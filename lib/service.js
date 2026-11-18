'use strict';
// ตรรกะทางธุรกิจทั้งหมดของระบบจองรถ — server.js เรียกใช้ผ่านฟังก์ชันในไฟล์นี้เท่านั้น
const { tx, clearDemo, seedDemo, nextVehicleSeq, assignMissingSeq, DEFAULT_SETTINGS } = require('./db');
const { parseLayout, sanitizeLayout } = require('./printLayout');
const { readTable, planImport, fromBase64, ImportError } = require('../public/js/peopleImport.mjs');
const { toIso, overlaps, bkkParts, expandToDays, formatThai, formatThaiDate } = require('./time');

class AppError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const BOOKING_STATUS = {
  pending: 'รออนุมัติ', approved: 'อนุมัติ', rejected: 'ไม่อนุมัติ', cancelled: 'ยกเลิก', completed: 'เสร็จสิ้น',
};
// สถานะคำขอที่ "กันรถ" ไว้ (ห้ามจองทับ)
const HOLDING = ['pending', 'approved'];

const VEHICLE_STATE = {
  available: 'ว่าง', booked: 'ถูกจอง', in_use: 'กำลังใช้งาน', unavailable: 'ไม่พร้อมใช้งาน',
};

const nowIso = () => new Date().toISOString();
const str = (v, max = 500) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const intOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);

function requireAdmin(user) {
  if (!user || user.role !== 'admin') throw new AppError(403, 'เฉพาะผู้ดูแลระบบเท่านั้นที่ทำรายการนี้ได้');
}

function createService(db) {
  const q = (sql) => db.prepare(sql);

  // ---------- ผู้ใช้ / ค่าตั้งต้น ----------
  function listUsers() { return q('SELECT * FROM users ORDER BY role DESC, id').all(); }
  function getUser(id) { return id ? q('SELECT * FROM users WHERE id = ?').get(Number(id)) : undefined; }

  // ---------- บัญชีผู้ดูแล ----------
  const account = () => q('SELECT * FROM admin_account WHERE id = 1').get();
  function adminUser() { return getUser(account().admin_user_id); }
  function guestUser() { return getUser(account().guest_user_id); }
  /** ตรวจชื่อผู้ใช้/รหัสผ่าน (เทียบชื่อผู้ใช้แบบไม่สนตัวพิมพ์เล็ก-ใหญ่) */
  function checkLogin(username, password) {
    const a = account();
    const { verifyPassword } = require('./auth');
    return String(username || '').trim().toLowerCase() === a.username.toLowerCase() && verifyPassword(password, a.password_hash);
  }
  function accountInfo() { const a = account(); return { username: a.username, is_default: !!a.is_default, display_name: adminUser().name }; }
  function changeAccount(user, body) {
    requireAdmin(user);
    const { hashPassword, verifyPassword } = require('./auth');
    const a = account();
    if (!verifyPassword(body.current_password, a.password_hash)) throw new AppError(400, 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
    const username = str(body.username, 60) || a.username;
    if (!/^[A-Za-z0-9._@-]{3,60}$/.test(username)) throw new AppError(400, 'ชื่อผู้ใช้ต้องเป็นตัวอักษรอังกฤษ ตัวเลข หรือ . _ @ - อย่างน้อย 3 ตัว');
    const display = str(body.display_name, 120);
    if (display) q('UPDATE users SET name = ? WHERE id = ?').run(display, a.admin_user_id);
    if (body.new_password) {
      if (String(body.new_password).length < 8) throw new AppError(400, 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร');
      q('UPDATE admin_account SET username = ?, password_hash = ?, is_default = 0 WHERE id = 1').run(username, hashPassword(body.new_password));
    } else {
      q('UPDATE admin_account SET username = ? WHERE id = 1').run(username);
    }
    return accountInfo();
  }

  function getSettings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const r of q('SELECT key, value FROM settings').all()) out[r.key] = r.value;
    return out;
  }
  function updateSettings(user, body) {
    requireAdmin(user);
    const up = q('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    if ('print_layout' in body) {
      // JSON ยาวเกินขีดจำกัดข้อความทั่วไป จึงตรวจและบันทึกแยก
      const layout = typeof body.print_layout === 'string' ? parseLayout(body.print_layout) : sanitizeLayout(body.print_layout);
      up.run('print_layout', JSON.stringify(layout));
    }
    if ('require_approval' in body && !['0', '1'].includes(String(body.require_approval))) throw new AppError(400, 'ค่าการอนุมัติไม่ถูกต้อง');
    if ('conflict_mode' in body && !['day', 'time'].includes(String(body.conflict_mode))) throw new AppError(400, 'รูปแบบการตรวจการจองซ้ำไม่ถูกต้อง');
    tx(db, () => { for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in body && k !== 'print_layout') up.run(k, str(body[k], 1000)); });
    return getSettings();
  }

  /** ค่าตั้งค่าการจอง */
  function bookingRules() {
    const s = getSettings();
    return { requireApproval: s.require_approval === '1', dayMode: s.conflict_mode !== 'time' };
  }
  /** ชื่อสถานะตามโหมด: ไม่ต้องอนุมัติ → "จองแล้ว" แทน "อนุมัติ" */
  function statusLabel(status) {
    if (status === 'approved' && !bookingRules().requireApproval) return 'จองแล้ว';
    return BOOKING_STATUS[status];
  }

  function printLayout() { return parseLayout(getSettings().print_layout); }

  // ---------- รายชื่อบุคลากร ----------
  const ROLE_COLS = ['is_staff', 'is_driver', 'is_responsible', 'is_approver'];
  const flag = (v) => (v === true || v === 1 || v === '1' || v === 'on' ? 1 : 0);
  function listPeople() { return q('SELECT * FROM people ORDER BY active DESC, sort_order, name').all(); }
  function savePerson(user, id, body) {
    requireAdmin(user);
    const d = { name: str(body.name, 120), position: str(body.position, 120), department: str(body.department, 160), phone: str(body.phone, 40) };
    if (!d.name) throw new AppError(400, 'กรุณาระบุชื่อ-นามสกุล');
    const roles = ROLE_COLS.map((c) => flag(body[c]));
    if (!roles.some(Boolean)) throw new AppError(400, 'กรุณาเลือกหน้าที่อย่างน้อย 1 อย่าง');
    if (q('SELECT id FROM people WHERE name = ? AND id <> ?').get(d.name, id || 0)) throw new AppError(409, 'มีรายชื่อนี้อยู่แล้ว');
    const active = 'active' in body ? flag(body.active) : 1;
    if (id) {
      const r = q(`UPDATE people SET name=?, position=?, department=?, phone=?, ${ROLE_COLS.map((c) => `${c}=?`).join(', ')}, active=? WHERE id=?`)
        .run(d.name, d.position, d.department, d.phone, ...roles, active, id);
      if (!r.changes) throw new AppError(404, 'ไม่พบรายชื่อ');
      return q('SELECT * FROM people WHERE id = ?').get(id);
    }
    const max = q('SELECT COALESCE(MAX(sort_order), 0) AS m FROM people').get().m;
    const r = q(`INSERT INTO people(name, position, department, phone, ${ROLE_COLS.join(', ')}, active, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(d.name, d.position, d.department, d.phone, ...roles, active, max + 1);
    return q('SELECT * FROM people WHERE id = ?').get(Number(r.lastInsertRowid));
  }
  function deletePerson(user, id) {
    requireAdmin(user);
    if (!q('DELETE FROM people WHERE id = ?').run(id).changes) throw new AppError(404, 'ไม่พบรายชื่อ');
    return { ok: true };
  }

  /**
   * นำเข้ารายชื่อจาก Excel/CSV — body: { filename, data (base64), roles: {is_staff,...}, commit }
   * commit = false → ตรวจและคืนตัวอย่างเท่านั้น / true → บันทึก
   * ชื่อที่มีอยู่แล้ว: อัปเดตตำแหน่ง (และฝ่าย/เบอร์ถ้ามีในไฟล์) และเพิ่มหน้าที่ที่เลือก ไม่ลบหน้าที่เดิม
   */
  async function importPeople(user, body) {
    requireAdmin(user);
    const filename = str(body.filename, 200);
    if (!body.data) throw new AppError(400, 'กรุณาเลือกไฟล์');
    const roles = ROLE_COLS.map((k) => flag(body.roles?.[k]));
    if (!roles.some(Boolean)) throw new AppError(400, 'กรุณาเลือกหน้าที่ของรายชื่อที่นำเข้าอย่างน้อย 1 อย่าง');
    let plan;
    try { plan = planImport(await readTable(fromBase64(body.data), filename), listPeople()); }
    catch (e) { throw new AppError(400, e instanceof ImportError ? e.message : 'อ่านไฟล์ไม่สำเร็จ กรุณาตรวจว่าเป็นไฟล์ .xlsx หรือ .csv'); }
    const { columns, counts, rows, allRows, headerRow } = plan;
    if (!body.commit) return { columns, counts, rows, headerRow };

    // ชื่อที่มีอยู่แล้ว: อัปเดตตำแหน่ง (และฝ่าย/เบอร์ถ้ามีในไฟล์) และเพิ่มหน้าที่ที่เลือก ไม่ลบหน้าที่เดิม
    const existing = new Map(listPeople().map((p) => [p.id, p]));
    tx(db, () => {
      let order = q('SELECT COALESCE(MAX(sort_order), 0) AS m FROM people').get().m;
      const ins = q(`INSERT INTO people(name, position, department, phone, ${ROLE_COLS.join(', ')}, active, sort_order) VALUES (?,?,?,?,?,?,?,?,1,?)`);
      for (const r of allRows) {
        if (r.action === 'new') ins.run(r.name, r.position, r.department, r.phone, ...roles, ++order);
        if (r.action === 'update') {
          const o = existing.get(r.id);
          q(`UPDATE people SET position = ?, department = ?, phone = ?, ${ROLE_COLS.map((c) => `${c} = MAX(${c}, ?)`).join(', ')}, active = 1 WHERE id = ?`)
            .run(r.position || o.position, r.department || o.department, r.phone || o.phone, ...roles, o.id);
        }
      }
    });
    return { columns, counts, imported: counts.new + counts.update };
  }

  // ---------- สถานที่/วัตถุประสงค์ที่ใช้บ่อย ----------
  function listPresets() { return q('SELECT * FROM presets ORDER BY kind, sort_order, id').all(); }
  function savePreset(user, body) {
    requireAdmin(user);
    const kind = String(body.kind || '');
    if (!['destination', 'purpose'].includes(kind)) throw new AppError(400, 'ชนิดรายการไม่ถูกต้อง');
    const text = str(body.text, 500);
    if (!text) throw new AppError(400, 'กรุณาระบุข้อความ');
    if (q('SELECT id FROM presets WHERE kind = ? AND text = ?').get(kind, text)) throw new AppError(409, 'มีรายการนี้อยู่แล้ว');
    const max = q('SELECT COALESCE(MAX(sort_order), 0) AS m FROM presets WHERE kind = ?').get(kind).m;
    const r = q('INSERT INTO presets(kind, text, sort_order) VALUES (?, ?, ?)').run(kind, text, max + 1);
    return q('SELECT * FROM presets WHERE id = ?').get(Number(r.lastInsertRowid));
  }
  function deletePreset(user, id) {
    requireAdmin(user);
    if (!q('DELETE FROM presets WHERE id = ?').run(id).changes) throw new AppError(404, 'ไม่พบรายการ');
    return { ok: true };
  }

  function listTypes() { return q('SELECT * FROM vehicle_types ORDER BY sort_order, id').all(); }
  function saveType(user, id, body) {
    requireAdmin(user);
    const name = str(body.name, 100);
    if (!name) throw new AppError(400, 'กรุณาระบุชื่อประเภทรถ');
    const dup = q('SELECT id FROM vehicle_types WHERE name = ? AND id <> ?').get(name, id || 0);
    if (dup) throw new AppError(409, 'มีประเภทรถชื่อนี้อยู่แล้ว');
    if (id) {
      const r = q('UPDATE vehicle_types SET name = ?, sort_order = ?, active = ? WHERE id = ?')
        .run(name, Number(body.sort_order) || 0, body.active === false || body.active === 0 ? 0 : 1, id);
      if (!r.changes) throw new AppError(404, 'ไม่พบประเภทรถ');
      return q('SELECT * FROM vehicle_types WHERE id = ?').get(id);
    }
    const max = q('SELECT COALESCE(MAX(sort_order), 0) AS m FROM vehicle_types').get().m;
    const r = q('INSERT INTO vehicle_types(name, sort_order) VALUES (?, ?)').run(name, max + 1);
    return q('SELECT * FROM vehicle_types WHERE id = ?').get(Number(r.lastInsertRowid));
  }

  // ---------- ความขัดแย้งของเวลา ----------
  /**
   * หาสาเหตุที่รถคันนี้ไม่ว่างในช่วง [start, end)
   * คืนรายการ { kind: 'inactive'|'maintenance'|'booking', message, ... }
   */
  function findConflicts(vehicleId, reqStart, reqEnd, excludeBookingId = 0) {
    const out = [];
    const { dayMode } = bookingRules();
    // โหมดรายวัน: ขยายช่วงที่ขอให้เต็มวัน ถ้ารถมีการจองใด ๆ ในวันเดียวกันถือว่าชน
    const { start, end } = dayMode ? expandToDays(reqStart, reqEnd) : { start: reqStart, end: reqEnd };
    const span = (a, b) => (dayMode ? dateSpan(a, b) : `ช่วง ${formatThai(a)} ถึง ${formatThai(b)}`);
    const v = q('SELECT * FROM vehicles WHERE id = ?').get(vehicleId);
    if (!v) throw new AppError(404, 'ไม่พบรถที่เลือก');
    if (!v.active) out.push({ kind: 'inactive', message: `รถ ${v.plate} ถูกปิดใช้งานอยู่` });
    for (const m of q('SELECT * FROM maintenance WHERE vehicle_id = ? AND start_at < ? AND (end_at IS NULL OR end_at > ?)').all(vehicleId, end, start)) {
      out.push({ kind: 'maintenance', id: m.id, start_at: m.start_at, end_at: m.end_at,
        message: `รถอยู่ระหว่างซ่อมบำรุง ${formatThai(m.start_at)} ถึง ${m.end_at ? formatThai(m.end_at) : 'ยังไม่กำหนดวันเสร็จ'}${m.description ? ` (${m.description})` : ''}` });
    }
    const rows = q(`SELECT id, code, status, start_at, end_at, requester_department FROM bookings
      WHERE vehicle_id = ? AND id <> ? AND status IN ('pending','approved') AND start_at < ? AND end_at > ? ORDER BY start_at`)
      .all(vehicleId, excludeBookingId || 0, end, start);
    for (const b of rows) {
      out.push({ kind: 'booking', id: b.id, code: b.code, status: b.status, start_at: b.start_at, end_at: b.end_at,
        message: `${dayMode ? 'รถคันนี้มีการจองแล้ว' : 'มีการจอง'} ${span(b.start_at, b.end_at)} (${b.code} · ${statusLabel(b.status)}${b.requester_department ? ` · ${b.requester_department}` : ''})` });
    }
    // รถที่ออกไปแล้วแต่ยังไม่บันทึกขากลับ: ถือว่าไม่ว่างตั้งแต่เวลาออกจนถึงเวลากลับตามคำขอ หรือจนถึงปัจจุบันถ้าเลยกำหนดแล้ว
    const open = q(`SELECT b.code, b.end_at, t.depart_at FROM trip_logs t JOIN bookings b ON b.id = t.booking_id
      WHERE t.vehicle_id = ? AND t.depart_at IS NOT NULL AND t.return_at IS NULL AND b.id <> ? AND b.status = 'approved'`)
      .all(vehicleId, excludeBookingId || 0);
    for (const o of open) {
      const busyUntil = new Date(Math.max(Date.parse(o.end_at), Date.now())).toISOString();
      if (!rows.some((r) => r.code === o.code) && overlaps(start, end, o.depart_at, busyUntil)) {
        out.push({ kind: 'trip', code: o.code, message: `รถออกเดินทางตามคำขอ ${o.code} ตั้งแต่ ${formatThai(o.depart_at)} และยังไม่บันทึกขากลับ` });
      }
    }
    return out;
  }

  /** "วันที่ 9 พ.ย. 2569" หรือ "วันที่ 9 พ.ย. 2569 ถึง 11 พ.ย. 2569" */
  function dateSpan(a, b) {
    const da = formatThaiDate(a), db_ = formatThaiDate(new Date(Date.parse(b) - 1).toISOString());
    return da === db_ ? `วันที่ ${da}` : `วันที่ ${da} ถึง ${db_}`;
  }

  function parseRange(startRaw, endRaw) {
    const start = toIso(startRaw), end = toIso(endRaw);
    if (!start || !end) throw new AppError(400, 'กรุณาระบุวันและเวลาออกเดินทางและเวลากลับให้ถูกต้อง');
    if (Date.parse(end) <= Date.parse(start)) throw new AppError(400, 'วันเวลากลับต้องอยู่หลังวันเวลาออกเดินทาง');
    return { start, end };
  }

  function checkAvailability(body) {
    const { start, end } = parseRange(body.start_at, body.end_at);
    const vehicleId = intOrNull(body.vehicle_id);
    if (!vehicleId) throw new AppError(400, 'กรุณาเลือกรถ');
    const conflicts = findConflicts(vehicleId, start, end, intOrNull(body.exclude_booking_id) || 0);
    return { available: conflicts.length === 0, conflicts };
  }

  // ---------- รถและสถานะรถ ----------
  /** คำนวณสถานะของรถทุกคันในช่วงเวลา [from, to] */
  function vehiclesWithState({ from, to } = {}) {
    const now = nowIso();
    from = toIso(from) || now;
    to = toIso(to) || new Date(Date.parse(from) + 60e3).toISOString();
    if (Date.parse(to) < Date.parse(from)) throw new AppError(400, 'ช่วงเวลาสิ้นสุดต้องอยู่หลังเวลาเริ่มต้น');
    const includesNow = Date.parse(from) <= Date.now() + 60e3 && Date.parse(to) >= Date.now();

    const vehicles = q(`SELECT v.*, t.name AS type_name FROM vehicles v JOIN vehicle_types t ON t.id = v.type_id ORDER BY v.active DESC, t.sort_order, v.plate`).all();
    const maint = q('SELECT * FROM maintenance WHERE start_at < ? AND (end_at IS NULL OR end_at > ?)').all(to, from);
    const books = q(`SELECT id, code, user_id, vehicle_id, status, start_at, end_at, requester_department FROM bookings
      WHERE vehicle_id IS NOT NULL AND status IN ('pending','approved') AND start_at < ? AND end_at > ? ORDER BY start_at`).all(to, from);
    const openTrips = q(`SELECT t.*, b.code FROM trip_logs t JOIN bookings b ON b.id = t.booking_id
      WHERE t.depart_at IS NOT NULL AND t.return_at IS NULL AND b.status = 'approved'`).all();
    const nextQ = q(`SELECT id, code, status, start_at, end_at FROM bookings WHERE vehicle_id = ? AND status IN ('pending','approved') AND end_at > ? ORDER BY start_at LIMIT 1`);

    return vehicles.map((v) => {
      const vm = maint.filter((m) => m.vehicle_id === v.id);
      const vb = books.filter((b) => b.vehicle_id === v.id);
      const trip = openTrips.find((t) => t.vehicle_id === v.id);
      let state = 'available', reason = '', detail = '';
      if (!v.active) { state = 'unavailable'; reason = 'inactive'; detail = 'ปิดใช้งาน'; }
      else if (vm.length) {
        state = 'unavailable'; reason = 'maintenance';
        detail = `ซ่อมบำรุงถึง ${vm[0].end_at ? formatThai(vm[0].end_at) : 'ยังไม่กำหนด'}`;
      } else if (includesNow && (trip || vb.some((b) => b.status === 'approved' && b.start_at <= now && b.end_at > now))) {
        state = 'in_use'; reason = 'trip';
        const b = trip ? { code: trip.code } : vb.find((x) => x.status === 'approved' && x.start_at <= now && x.end_at > now);
        detail = `ใช้งานตามคำขอ ${b.code}`;
      } else if (vb.length) {
        state = 'booked'; reason = vb.every((b) => b.status === 'pending') ? 'pending' : 'approved';
        detail = `${vb.length} รายการ${reason === 'pending' ? ' (รออนุมัติ)' : ''}`;
      }
      return {
        ...v, state, state_label: VEHICLE_STATE[state], state_reason: reason, state_detail: detail,
        maintenance: vm, bookings_in_range: vb.length, next_booking: nextQ.get(v.id, now) || null,
      };
    });
  }

  function listVehicles(filters = {}) { return filterVehicles(vehiclesWithState(filters), filters); }

  function filterVehicles(rows, filters) {
    if (filters.type_id) rows = rows.filter((v) => v.type_id === Number(filters.type_id));
    if (filters.state) rows = rows.filter((v) => v.state === filters.state);
    if (filters.min_seats) rows = rows.filter((v) => v.seats >= Number(filters.min_seats));
    if (filters.q) {
      const s = String(filters.q).toLowerCase();
      rows = rows.filter((v) => [v.plate, v.brand, v.model, v.driver_name, v.type_name].join(' ').toLowerCase().includes(s));
    }
    return rows;
  }

  function vehicleInput(body) {
    const d = {
      plate: str(body.plate, 60), brand: str(body.brand, 80), model: str(body.model, 80),
      type_id: intOrNull(body.type_id), seats: intOrNull(body.seats), color: str(body.color, 40),
      driver_name: str(body.driver_name, 120), driver_phone: str(body.driver_phone, 40),
      mileage: intOrNull(body.mileage), note: str(body.note, 1000),
      seq_start: body.seq_start === undefined || body.seq_start === '' ? 1 : intOrNull(body.seq_start),
    };
    if (!d.plate) throw new AppError(400, 'กรุณาระบุทะเบียนรถ');
    if (!d.type_id || !q('SELECT id FROM vehicle_types WHERE id = ?').get(d.type_id)) throw new AppError(400, 'กรุณาเลือกประเภทรถ');
    if (!Number.isInteger(d.seats) || d.seats < 1 || d.seats > 100) throw new AppError(400, 'จำนวนที่นั่งต้องเป็นตัวเลข 1–100');
    if (Number.isNaN(d.mileage) || (d.mileage !== null && d.mileage < 0)) throw new AppError(400, 'เลขไมล์ต้องเป็นจำนวนเต็มไม่ติดลบ');
    if (!Number.isInteger(d.seq_start) || d.seq_start < 1 || d.seq_start > 9999999) throw new AppError(400, 'เลขลำดับเริ่มต้นต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
    return d;
  }

  function getVehicle(id) {
    const v = q('SELECT v.*, t.name AS type_name FROM vehicles v JOIN vehicle_types t ON t.id = v.type_id WHERE v.id = ?').get(id);
    if (!v) throw new AppError(404, 'ไม่พบรถ');
    v.next_seq = nextVehicleSeq(db, id);
    v.maintenance = q('SELECT m.*, u.name AS created_by_name FROM maintenance m LEFT JOIN users u ON u.id = m.created_by WHERE vehicle_id = ? ORDER BY start_at DESC').all(id);
    return v;
  }

  function createVehicle(user, body) {
    requireAdmin(user);
    const d = vehicleInput(body);
    if (q('SELECT id FROM vehicles WHERE plate = ?').get(d.plate)) throw new AppError(409, 'มีรถทะเบียนนี้อยู่ในระบบแล้ว');
    const now = nowIso();
    const r = q(`INSERT INTO vehicles(plate, brand, model, type_id, seats, color, driver_name, driver_phone, mileage, note, seq_start, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(d.plate, d.brand, d.model, d.type_id, d.seats, d.color, d.driver_name, d.driver_phone, d.mileage, d.note, d.seq_start, now, now);
    return getVehicle(Number(r.lastInsertRowid));
  }

  function updateVehicle(user, id, body) {
    requireAdmin(user);
    getVehicle(id);
    const d = vehicleInput(body);
    if (q('SELECT id FROM vehicles WHERE plate = ? AND id <> ?').get(d.plate, id)) throw new AppError(409, 'มีรถทะเบียนนี้อยู่ในระบบแล้ว');
    q(`UPDATE vehicles SET plate=?, brand=?, model=?, type_id=?, seats=?, color=?, driver_name=?, driver_phone=?, mileage=?, note=?, seq_start=?, updated_at=? WHERE id=?`)
      .run(d.plate, d.brand, d.model, d.type_id, d.seats, d.color, d.driver_name, d.driver_phone, d.mileage, d.note, d.seq_start, nowIso(), id);
    return getVehicle(id);
  }

  /** คำขอที่ยังค้างอยู่ในอนาคตของรถคันนี้ (ใช้เตือนเมื่อปิดใช้งาน/ส่งซ่อม) */
  function affectedBookings(vehicleId, start, end) {
    return q(`SELECT id, code, status, start_at, end_at FROM bookings WHERE vehicle_id = ? AND status IN ('pending','approved')
      AND end_at > ? ${end ? 'AND start_at < ?' : ''} ORDER BY start_at`).all(...[vehicleId, start, end].filter(Boolean));
  }

  function setVehicleActive(user, id, active) {
    requireAdmin(user);
    getVehicle(id);
    q('UPDATE vehicles SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, nowIso(), id);
    return { vehicle: getVehicle(id), warnings: active ? [] : affectedBookings(id, nowIso()) };
  }

  function addMaintenance(user, vehicleId, body) {
    requireAdmin(user);
    getVehicle(vehicleId);
    const start = toIso(body.start_at);
    const end = body.end_at ? toIso(body.end_at) : null;
    if (!start) throw new AppError(400, 'กรุณาระบุวันเวลาเริ่มซ่อมบำรุง');
    if (body.end_at && !end) throw new AppError(400, 'วันเวลาสิ้นสุดไม่ถูกต้อง');
    if (end && Date.parse(end) <= Date.parse(start)) throw new AppError(400, 'วันเวลาสิ้นสุดต้องอยู่หลังวันเวลาเริ่มซ่อม');
    const description = str(body.description, 1000);
    if (!description) throw new AppError(400, 'กรุณาระบุรายละเอียดการซ่อมบำรุง');
    const r = q('INSERT INTO maintenance(vehicle_id, start_at, end_at, description, created_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(vehicleId, start, end, description, user.id, nowIso());
    return { id: Number(r.lastInsertRowid), warnings: affectedBookings(vehicleId, start, end) };
  }

  function updateMaintenance(user, id, body) {
    requireAdmin(user);
    const m = q('SELECT * FROM maintenance WHERE id = ?').get(id);
    if (!m) throw new AppError(404, 'ไม่พบรายการซ่อมบำรุง');
    const start = body.start_at ? toIso(body.start_at) : m.start_at;
    const end = body.end_at === null || body.end_at === '' ? null : body.end_at ? toIso(body.end_at) : m.end_at;
    if (!start || (body.end_at && !end)) throw new AppError(400, 'วันเวลาไม่ถูกต้อง');
    if (end && Date.parse(end) <= Date.parse(start)) throw new AppError(400, 'วันเวลาสิ้นสุดต้องอยู่หลังวันเวลาเริ่มซ่อม');
    const description = 'description' in body ? str(body.description, 1000) : m.description;
    q('UPDATE maintenance SET start_at = ?, end_at = ?, description = ? WHERE id = ?').run(start, end, description, id);
    return { id, warnings: affectedBookings(m.vehicle_id, start, end) };
  }

  function deleteMaintenance(user, id) {
    requireAdmin(user);
    const r = q('DELETE FROM maintenance WHERE id = ?').run(id);
    if (!r.changes) throw new AppError(404, 'ไม่พบรายการซ่อมบำรุง');
    return { ok: true };
  }

  // ---------- คำขอใช้รถ ----------
  const BOOKING_SELECT = `SELECT b.*, v.plate, v.brand, v.model, v.seats AS vehicle_seats, v.driver_name AS vehicle_driver,
      t.name AS type_name, du.name AS decided_by_name,
      tl.driver_name AS trip_driver, tl.depart_at, tl.depart_mileage, tl.return_at, tl.return_mileage, tl.note AS trip_note
    FROM bookings b
    LEFT JOIN vehicles v ON v.id = b.vehicle_id
    LEFT JOIN vehicle_types t ON t.id = b.type_id
    LEFT JOIN users du ON du.id = b.decided_by
    LEFT JOIN trip_logs tl ON tl.booking_id = b.id`;

  function decorate(b) {
    b.status_label = statusLabel(b.status);
    b.distance = b.depart_mileage !== null && b.return_mileage !== null && b.depart_mileage !== undefined ? b.return_mileage - b.depart_mileage : null;
    b.overdue = b.status === 'approved' && Date.parse(b.end_at) < Date.now() && !b.return_at;
    return b;
  }

  function canSee(user, b) { return user.role === 'admin' || (!!b.owner_token && (user.tokens || []).includes(b.owner_token)); }

  function getBooking(user, id) {
    const b = q(`${BOOKING_SELECT} WHERE b.id = ?`).get(id);
    if (!b) throw new AppError(404, 'ไม่พบคำขอใช้รถ');
    if (!canSee(user, b)) throw new AppError(403, 'คุณไม่มีสิทธิ์ดูคำขอนี้');
    decorate(b);
    b.events = q('SELECT * FROM booking_events WHERE booking_id = ? ORDER BY at, id').all(id);
    return b;
  }

  function listBookings(user, f = {}) {
    const where = [], args = [];
    if (user.role !== 'admin') {
      // ผู้ไม่ได้ล็อกอินเห็นเฉพาะการจองที่เครื่องนี้ถือรหัสลับ
      const tokens = user.tokens || [];
      if (!tokens.length) return [];
      where.push(`b.owner_token IN (${tokens.map(() => '?').join(',')})`); args.push(...tokens);
    }
    if (f.status) { where.push('b.status = ?'); args.push(f.status); }
    if (f.vehicle_id) { where.push('b.vehicle_id = ?'); args.push(Number(f.vehicle_id)); }
    if (f.from) { where.push('b.end_at > ?'); args.push(toIso(f.from)); }
    if (f.to) { where.push('b.start_at < ?'); args.push(toIso(f.to)); }
    if (f.trip === '1') { where.push("b.status IN ('approved','completed') AND b.vehicle_id IS NOT NULL"); }
    if (f.q) {
      where.push('(b.code LIKE ? OR b.requester_name LIKE ? OR b.destination LIKE ? OR b.purpose LIKE ? OR v.plate LIKE ?)');
      const s = `%${f.q}%`; args.push(s, s, s, s, s);
    }
    const order = f.order === 'start' ? 'b.start_at ASC' : 'b.created_at DESC, b.id DESC';
    return q(`${BOOKING_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 500`).all(...args).map(decorate);
  }

  function logEvent(bookingId, user, action, note = '') {
    q('INSERT INTO booking_events(booking_id, at, user_id, user_name, action, note) VALUES (?,?,?,?,?,?)')
      .run(bookingId, nowIso(), user.id, user.name, action, note);
  }

  function nextCode() {
    const be = bkkParts(nowIso()).y + 543;
    const prefix = `RQ-${be}-`;
    const last = q('SELECT code FROM bookings WHERE code LIKE ? ORDER BY code DESC LIMIT 1').get(prefix + '%');
    const n = last ? Number(last.code.slice(prefix.length)) + 1 : 1;
    return prefix + String(n).padStart(4, '0');
  }

  function assertVehicleFits(vehicleId, start, end, pax, excludeId) {
    const v = q('SELECT * FROM vehicles WHERE id = ?').get(vehicleId);
    if (!v) throw new AppError(400, 'ไม่พบรถที่เลือก');
    if (pax > v.seats) throw new AppError(400, `จำนวนผู้เดินทาง ${pax} คน เกินจำนวนที่นั่งของรถ ${v.plate} (${v.seats} ที่นั่ง)`);
    const conflicts = findConflicts(vehicleId, start, end, excludeId);
    if (conflicts.length) {
      throw new AppError(409, `รถ ${v.plate} ไม่ว่างในช่วงเวลาที่เลือก`, { conflicts });
    }
    return v;
  }

  function createBooking(user, body) {
    const d = {
      requester_name: str(body.requester_name, 120) || user.name,
      requester_position: str(body.requester_position, 120),
      requester_department: str(body.requester_department, 160),
      requester_phone: str(body.requester_phone, 40),
      purpose: str(body.purpose, 1000), destination: str(body.destination, 500),
      companions: str(body.companions, 2000), passenger_count: intOrNull(body.passenger_count),
      type_id: intOrNull(body.type_id), type_other: str(body.type_other, 100),
      vehicle_id: intOrNull(body.vehicle_id), need_driver: body.need_driver === false || body.need_driver === 0 || body.need_driver === '0' ? 0 : 1,
      assigned_driver: str(body.assigned_driver, 120), // เลือกพนักงานขับรถเอง (ว่าง = ใช้คนขับประจำรถ)
      note: str(body.note, 2000),
    };
    if (!d.requester_name) throw new AppError(400, 'กรุณาระบุชื่อผู้ขอใช้รถ');
    if (!d.requester_department) throw new AppError(400, 'กรุณาระบุฝ่าย/สังกัด');
    if (!d.purpose) throw new AppError(400, 'กรุณาระบุวัตถุประสงค์/เหตุผลในการใช้รถ');
    if (!d.destination) throw new AppError(400, 'กรุณาระบุสถานที่ไป/จุดหมาย');
    if (!Number.isInteger(d.passenger_count) || d.passenger_count < 1 || d.passenger_count > 100) throw new AppError(400, 'จำนวนผู้เดินทางต้องเป็นตัวเลข 1–100 คน');
    if (Number.isNaN(d.type_id) || Number.isNaN(d.vehicle_id)) throw new AppError(400, 'ข้อมูลประเภทรถหรือรถไม่ถูกต้อง');
    if (!d.type_id && !d.type_other) throw new AppError(400, 'กรุณาเลือกประเภทรถ');
    if (d.type_id && !q('SELECT id FROM vehicle_types WHERE id = ?').get(d.type_id)) throw new AppError(400, 'ไม่พบประเภทรถที่เลือก');
    const { start, end } = parseRange(body.start_at, body.end_at);
    if (user.role !== 'admin' && Date.parse(start) < Date.now() - 10 * 60e3) throw new AppError(400, 'ไม่สามารถจองย้อนหลังได้ กรุณาเลือกเวลาออกเดินทางในอนาคต');
    const { requireApproval } = bookingRules();
    if (!requireApproval && !d.vehicle_id) throw new AppError(400, 'กรุณาเลือกรถที่ต้องการจอง');

    return tx(db, () => {
      if (d.vehicle_id) {
        const v = assertVehicleFits(d.vehicle_id, start, end, d.passenger_count, 0);
        if (!d.type_id) d.type_id = v.type_id;
      }
      const now = nowIso();
      const code = nextCode();
      const ownerToken = require('node:crypto').randomBytes(16).toString('hex');
      const r = q(`INSERT INTO bookings(code, user_id, requester_name, requester_position, requester_department, requester_phone, purpose, destination,
          companions, passenger_count, type_id, type_other, vehicle_id, need_driver, start_at, end_at, note, status, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(code, user.id, d.requester_name, d.requester_position, d.requester_department, d.requester_phone, d.purpose, d.destination,
          d.companions, d.passenger_count, d.type_id, d.type_other, d.vehicle_id, d.need_driver, start, end, d.note,
          requireApproval ? 'pending' : 'approved', now, now);
      q('UPDATE bookings SET owner_token = ? WHERE id = ?').run(ownerToken, Number(r.lastInsertRowid));
      // ผู้จองที่ไม่ได้ล็อกอิน: บันทึกประวัติด้วยชื่อผู้ขอ และให้สิทธิ์ดูการจองนี้ผ่านรหัสลับ
      if (user.role !== 'admin') user = { ...user, name: d.requester_name, tokens: [...(user.tokens || []), ownerToken] };
      const id = Number(r.lastInsertRowid);
      if (d.vehicle_id) q('UPDATE bookings SET vehicle_seq = ? WHERE id = ?').run(nextVehicleSeq(db, d.vehicle_id), id);
      logEvent(id, user, 'create', d.vehicle_id ? '' : 'ยังไม่ระบุรถ ให้ผู้ดูแลจัดรถ');
      if (d.need_driver && d.assigned_driver) q('UPDATE bookings SET assigned_driver = ? WHERE id = ?').run(d.assigned_driver, id);
      if (!requireApproval) {
        // จองสำเร็จทันที: ใช้พนักงานขับรถประจำรถเป็นค่าเริ่มต้น
        const v = q('SELECT plate, driver_name FROM vehicles WHERE id = ?').get(d.vehicle_id);
        q('UPDATE bookings SET assigned_driver = ?, decided_at = ? WHERE id = ?').run(d.need_driver ? d.assigned_driver || v.driver_name : '', now, id);
        logEvent(id, user, 'confirm', `จองรถ ${v.plate} สำเร็จ (ไม่ต้องรออนุมัติ)`);
      }
      return getBooking(user, id);
    });
  }

  function loadForAction(id) {
    const b = q('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!b) throw new AppError(404, 'ไม่พบคำขอใช้รถ');
    return b;
  }

  /** ผู้ดูแลกำหนด/เปลี่ยนรถและพนักงานขับรถ (ใช้ได้ทั้งตอนรออนุมัติและหลังอนุมัติ) */
  function assignVehicle(user, id, body) {
    requireAdmin(user);
    return tx(db, () => {
      const b = loadForAction(id);
      if (!HOLDING.includes(b.status)) throw new AppError(400, `คำขอสถานะ "${BOOKING_STATUS[b.status]}" ไม่สามารถเปลี่ยนรถได้`);
      const vehicleId = intOrNull(body.vehicle_id);
      if (!vehicleId) throw new AppError(400, 'กรุณาเลือกรถ');
      const v = assertVehicleFits(vehicleId, b.start_at, b.end_at, b.passenger_count, b.id);
      const driver = 'assigned_driver' in body ? str(body.assigned_driver, 120) : (b.vehicle_id === vehicleId ? b.assigned_driver : v.driver_name);
      q('UPDATE bookings SET vehicle_id = ?, assigned_driver = ?, updated_at = ? WHERE id = ?').run(vehicleId, driver, nowIso(), id);
      if (b.vehicle_id !== vehicleId || !b.vehicle_seq) q('UPDATE bookings SET vehicle_seq = ? WHERE id = ?').run(nextVehicleSeq(db, vehicleId), id);
      logEvent(id, user, 'assign', `กำหนดรถ ${v.plate}${driver ? ` พนักงานขับรถ ${driver}` : ''}`);
      return getBooking(user, id);
    });
  }

  function approveBooking(user, id, body = {}) {
    requireAdmin(user);
    return tx(db, () => {
      const b = loadForAction(id);
      if (b.status !== 'pending') throw new AppError(400, `อนุมัติได้เฉพาะคำขอที่รออนุมัติ (สถานะปัจจุบัน: ${BOOKING_STATUS[b.status]})`);
      const vehicleId = intOrNull(body.vehicle_id) || b.vehicle_id;
      if (!vehicleId) throw new AppError(400, 'กรุณาเลือกรถก่อนอนุมัติ');
      const v = assertVehicleFits(vehicleId, b.start_at, b.end_at, b.passenger_count, b.id);
      const driver = 'assigned_driver' in body ? str(body.assigned_driver, 120) : (b.assigned_driver || v.driver_name);
      const note = str(body.note, 1000);
      const now = nowIso();
      q(`UPDATE bookings SET status = 'approved', vehicle_id = ?, assigned_driver = ?, decision_note = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`)
        .run(vehicleId, driver, note, user.id, now, now, id);
      if (b.vehicle_id !== vehicleId || !b.vehicle_seq) q('UPDATE bookings SET vehicle_seq = ? WHERE id = ?').run(nextVehicleSeq(db, vehicleId), id);
      logEvent(id, user, 'approve', [`รถ ${v.plate}`, driver && `พนักงานขับรถ ${driver}`, note].filter(Boolean).join(' · '));
      return getBooking(user, id);
    });
  }

  function rejectBooking(user, id, body = {}) {
    requireAdmin(user);
    const reason = str(body.reason, 1000);
    if (!reason) throw new AppError(400, 'กรุณาระบุเหตุผลที่ไม่อนุมัติ');
    return tx(db, () => {
      const b = loadForAction(id);
      if (b.status !== 'pending') throw new AppError(400, `ไม่อนุมัติได้เฉพาะคำขอที่รออนุมัติ (สถานะปัจจุบัน: ${BOOKING_STATUS[b.status]})`);
      const now = nowIso();
      q(`UPDATE bookings SET status = 'rejected', decision_note = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`).run(reason, user.id, now, now, id);
      logEvent(id, user, 'reject', reason);
      return getBooking(user, id);
    });
  }

  function cancelBooking(user, id, body = {}) {
    const reason = str(body.reason, 1000);
    if (!reason) throw new AppError(400, 'กรุณาระบุเหตุผลการยกเลิก');
    return tx(db, () => {
      const b = loadForAction(id);
      if (!canSee(user, b)) throw new AppError(403, 'ยกเลิกได้เฉพาะการจองของตนเอง (ทำจากเครื่องที่ใช้จอง) หรือติดต่อผู้ดูแล');
      if (user.role !== 'admin') user = { ...user, name: b.requester_name };
      if (!HOLDING.includes(b.status)) throw new AppError(400, `คำขอสถานะ "${BOOKING_STATUS[b.status]}" ยกเลิกไม่ได้`);
      const trip = q('SELECT * FROM trip_logs WHERE booking_id = ?').get(id);
      if (trip && trip.depart_at) throw new AppError(400, 'รถออกเดินทางแล้ว ไม่สามารถยกเลิกได้ กรุณาบันทึกขากลับแทน');
      q(`UPDATE bookings SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?`).run(reason, nowIso(), id);
      logEvent(id, user, 'cancel', reason);
      return getBooking(user, id);
    });
  }

  function completeBooking(user, id, body = {}) {
    requireAdmin(user);
    return tx(db, () => {
      const b = loadForAction(id);
      if (b.status !== 'approved') throw new AppError(400, 'ปิดงานได้เฉพาะคำขอที่อนุมัติแล้ว');
      const trip = q('SELECT * FROM trip_logs WHERE booking_id = ?').get(id);
      if (trip && trip.depart_at && !trip.return_at) throw new AppError(400, 'รถยังไม่ได้บันทึกขากลับ กรุณาบันทึกเวลาและเลขไมล์ขากลับก่อน');
      q(`UPDATE bookings SET status = 'completed', updated_at = ? WHERE id = ?`).run(nowIso(), id);
      logEvent(id, user, 'complete', str(body.note, 500));
      return getBooking(user, id);
    });
  }

  /** บันทึกการใช้รถ: เวลา/เลขไมล์ขาออก-ขากลับ พนักงานขับรถ — บันทึกขากลับครบแล้วคำขอจะเป็น "เสร็จสิ้น" อัตโนมัติ */
  function saveTrip(user, id, body = {}) {
    requireAdmin(user);
    return tx(db, () => {
      const b = loadForAction(id);
      if (!['approved', 'completed'].includes(b.status)) throw new AppError(400, 'บันทึกการใช้รถได้เฉพาะคำขอที่อนุมัติแล้ว');
      if (!b.vehicle_id) throw new AppError(400, 'คำขอนี้ยังไม่ได้กำหนดรถ');
      const old = q('SELECT * FROM trip_logs WHERE booking_id = ?').get(id) || {};
      const pick = (k) => (k in body ? body[k] : old[k]);
      const departAt = pick('depart_at') ? toIso(pick('depart_at')) : null;
      const returnAt = pick('return_at') ? toIso(pick('return_at')) : null;
      const dm = intOrNull(pick('depart_mileage'));
      const rm = intOrNull(pick('return_mileage'));
      const driver = str(pick('driver_name') ?? b.assigned_driver, 120);
      const note = str(pick('note'), 1000);
      if ((pick('depart_at') && !departAt) || (pick('return_at') && !returnAt)) throw new AppError(400, 'วันเวลาที่บันทึกไม่ถูกต้อง');
      if (Number.isNaN(dm) || Number.isNaN(rm) || (dm !== null && dm < 0) || (rm !== null && rm < 0)) throw new AppError(400, 'เลขไมล์ต้องเป็นจำนวนเต็มไม่ติดลบ');
      if ((returnAt || rm !== null) && (!departAt || dm === null)) throw new AppError(400, 'กรุณาบันทึกเวลาและเลขไมล์ขาออกก่อนบันทึกขากลับ');
      if (departAt && returnAt && Date.parse(returnAt) <= Date.parse(departAt)) throw new AppError(400, 'เวลากลับต้องอยู่หลังเวลาออกเดินทาง');
      if (dm !== null && rm !== null && rm < dm) throw new AppError(400, 'เลขไมล์ขากลับต้องไม่น้อยกว่าเลขไมล์ขาออก');
      if (departAt && dm === null) throw new AppError(400, 'กรุณาระบุเลขไมล์ขาออก');
      if (returnAt && rm === null) throw new AppError(400, 'กรุณาระบุเลขไมล์ขากลับ');
      if (rm !== null && !returnAt) throw new AppError(400, 'กรุณาระบุวันเวลากลับถึง');
      if (departAt && Date.parse(departAt) > Date.now() + 5 * 60e3) throw new AppError(400, 'เวลาออกเดินทางต้องไม่เป็นเวลาในอนาคต');

      q(`INSERT INTO trip_logs(booking_id, vehicle_id, driver_name, depart_at, depart_mileage, return_at, return_mileage, note, recorded_by, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(booking_id) DO UPDATE SET vehicle_id=excluded.vehicle_id, driver_name=excluded.driver_name, depart_at=excluded.depart_at,
          depart_mileage=excluded.depart_mileage, return_at=excluded.return_at, return_mileage=excluded.return_mileage, note=excluded.note,
          recorded_by=excluded.recorded_by, updated_at=excluded.updated_at`)
        .run(id, b.vehicle_id, driver, departAt, dm, returnAt, rm, note, user.id, nowIso());

      const done = returnAt && rm !== null;
      if (done) {
        q('UPDATE vehicles SET mileage = MAX(COALESCE(mileage, 0), ?), updated_at = ? WHERE id = ?').run(rm, nowIso(), b.vehicle_id);
        if (b.status === 'approved') q(`UPDATE bookings SET status = 'completed', updated_at = ? WHERE id = ?`).run(nowIso(), id);
      } else if (dm !== null) {
        q('UPDATE vehicles SET mileage = MAX(COALESCE(mileage, 0), ?), updated_at = ? WHERE id = ?').run(dm, nowIso(), b.vehicle_id);
      }
      logEvent(id, user, 'trip', done ? `บันทึกขากลับ ระยะทางรวม ${(rm - dm).toLocaleString('th-TH')} กม.` : departAt ? 'บันทึกขาออก' : 'แก้ไขบันทึกการใช้รถ');
      return getBooking(user, id);
    });
  }

  // ---------- ปฏิทิน / แดชบอร์ด ----------
  function schedule(user, f = {}) {
    const from = toIso(f.from), to = toIso(f.to);
    if (!from || !to) throw new AppError(400, 'กรุณาระบุช่วงวันที่');
    const rows = q(`${BOOKING_SELECT} WHERE b.status IN ('pending','approved','completed') AND b.start_at < ? AND b.end_at > ? ORDER BY b.start_at`).all(to, from).map(decorate);
    const bookings = rows.map((b) => (canSee(user, b) ? { ...b, can_view: true } : {
      // ผู้ใช้ทั่วไปเห็นเฉพาะช่วงเวลาที่รถไม่ว่าง ไม่เห็นรายละเอียดคำขอของผู้อื่น
      id: null, code: b.code, status: b.status, status_label: b.status_label, vehicle_id: b.vehicle_id, plate: b.plate,
      type_name: b.type_name, start_at: b.start_at, end_at: b.end_at, requester_department: b.requester_department, can_view: false,
    }));
    const maintenance = q(`SELECT m.*, v.plate FROM maintenance m JOIN vehicles v ON v.id = m.vehicle_id WHERE m.start_at < ? AND (m.end_at IS NULL OR m.end_at > ?) ORDER BY m.start_at`).all(to, from);
    const vehicles = q('SELECT v.id, v.plate, v.brand, v.model, v.seats, v.active, v.type_id, t.name AS type_name FROM vehicles v JOIN vehicle_types t ON t.id = v.type_id ORDER BY t.sort_order, v.plate').all();
    return { from, to, vehicles, bookings, maintenance };
  }

  function dashboard(user, f = {}) {
    const all = vehiclesWithState(f);
    const counts = { total: all.length, available: 0, booked: 0, in_use: 0, unavailable: 0 };
    for (const v of all) counts[v.state] += 1;
    const isAdmin = user.role === 'admin';
    const pending = isAdmin
      ? q("SELECT COUNT(*) AS n FROM bookings WHERE status = 'pending'").get().n
      : (user.tokens || []).length
        ? q(`SELECT COUNT(*) AS n FROM bookings WHERE status = 'pending' AND owner_token IN (${user.tokens.map(() => '?').join(',')})`).get(...user.tokens).n
        : 0;
    const overdue = isAdmin
      ? q("SELECT COUNT(*) AS n FROM bookings b LEFT JOIN trip_logs t ON t.booking_id = b.id WHERE b.status = 'approved' AND b.end_at < ? AND t.return_at IS NULL").get(nowIso()).n
      : 0;
    return { counts, pending, overdue, vehicles: filterVehicles(all, f) };
  }

  // ---------- ข้อมูลตัวอย่าง ----------
  function demoInfo() {
    return {
      vehicles: q('SELECT COUNT(*) AS n FROM vehicles WHERE is_demo = 1').get().n,
      bookings: q('SELECT COUNT(*) AS n FROM bookings WHERE is_demo = 1').get().n,
      users: q('SELECT COUNT(*) AS n FROM users WHERE is_demo = 1').get().n,
    };
  }
  function clearDemoData(user) { requireAdmin(user); clearDemo(db); return demoInfo(); }
  function resetDemoData(user) { requireAdmin(user); clearDemo(db); seedDemo(db); assignMissingSeq(db); return demoInfo(); }

  return {
    listUsers, getUser, adminUser, guestUser, checkLogin, accountInfo, changeAccount, getSettings, updateSettings, listTypes, saveType, printLayout,
    listPeople, savePerson, deletePerson, importPeople, listPresets, savePreset, deletePreset,
    findConflicts, checkAvailability, listVehicles, getVehicle, createVehicle, updateVehicle, setVehicleActive,
    addMaintenance, updateMaintenance, deleteMaintenance,
    listBookings, getBooking, createBooking, assignVehicle, approveBooking, rejectBooking, cancelBooking, completeBooking, saveTrip,
    schedule, dashboard, demoInfo, clearDemoData, resetDemoData,
  };
}

module.exports = { createService, AppError, BOOKING_STATUS, VEHICLE_STATE, overlaps };
