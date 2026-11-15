'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { bkkParts, bkkToIso } = require('./time');

const SCHEMA_VERSION = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  position    TEXT NOT NULL DEFAULT '',
  department  TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  is_demo     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS vehicle_types (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS vehicles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  plate        TEXT NOT NULL UNIQUE,
  brand        TEXT NOT NULL DEFAULT '',
  model        TEXT NOT NULL DEFAULT '',
  type_id      INTEGER NOT NULL REFERENCES vehicle_types(id),
  seats        INTEGER NOT NULL DEFAULT 4,
  color        TEXT NOT NULL DEFAULT '',
  driver_name  TEXT NOT NULL DEFAULT '',
  driver_phone TEXT NOT NULL DEFAULT '',
  mileage      INTEGER,
  seq_start    INTEGER NOT NULL DEFAULT 1,  -- เลขลำดับเอกสารเริ่มต้นของรถคันนี้
  note         TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  is_demo      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- ช่วงเวลาซ่อมบำรุง: end_at = NULL หมายถึงยังซ่อมอยู่ ไม่มีกำหนดเสร็จ
CREATE TABLE IF NOT EXISTS maintenance (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id   INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  start_at     TEXT NOT NULL,
  end_at       TEXT,
  description  TEXT NOT NULL DEFAULT '',
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL,
  is_demo      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bookings (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  code                 TEXT NOT NULL UNIQUE,
  user_id              INTEGER NOT NULL REFERENCES users(id),
  requester_name       TEXT NOT NULL,
  requester_position   TEXT NOT NULL DEFAULT '',
  requester_department TEXT NOT NULL DEFAULT '',
  requester_phone      TEXT NOT NULL DEFAULT '',
  purpose              TEXT NOT NULL,
  destination          TEXT NOT NULL,
  companions           TEXT NOT NULL DEFAULT '',
  passenger_count      INTEGER NOT NULL DEFAULT 1,
  type_id              INTEGER REFERENCES vehicle_types(id),
  type_other           TEXT NOT NULL DEFAULT '',
  vehicle_id           INTEGER REFERENCES vehicles(id),
  need_driver          INTEGER NOT NULL DEFAULT 1,
  vehicle_seq          INTEGER,  -- เลขลำดับการจองของรถแต่ละคัน (รันต่อเนื่อง ไม่รีเซ็ต) แสดงใต้ "แบบ ๔"
  assigned_driver      TEXT NOT NULL DEFAULT '',
  start_at             TEXT NOT NULL,
  end_at               TEXT NOT NULL,
  note                 TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','rejected','cancelled','completed')),
  decision_note        TEXT NOT NULL DEFAULT '',
  decided_by           INTEGER REFERENCES users(id),
  decided_at           TEXT,
  cancel_reason        TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  is_demo              INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bookings_vehicle_time ON bookings(vehicle_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);

CREATE TABLE IF NOT EXISTS trip_logs (
  booking_id     INTEGER PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  vehicle_id     INTEGER REFERENCES vehicles(id),
  driver_name    TEXT NOT NULL DEFAULT '',
  depart_at      TEXT,
  depart_mileage INTEGER,
  return_at      TEXT,
  return_mileage INTEGER,
  note           TEXT NOT NULL DEFAULT '',
  recorded_by    INTEGER REFERENCES users(id),
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS booking_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id  INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id),
  user_name   TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT ''
);

-- รายชื่อบุคลากรที่ผู้ดูแลเพิ่ม ใช้เป็นตัวเลือกในฟอร์มต่าง ๆ (ชื่อถูกคัดลอกลงในการจอง จึงลบได้โดยไม่กระทบประวัติ)
CREATE TABLE IF NOT EXISTS people (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  position       TEXT NOT NULL DEFAULT '',
  department     TEXT NOT NULL DEFAULT '',
  phone          TEXT NOT NULL DEFAULT '',
  is_staff       INTEGER NOT NULL DEFAULT 1,  -- ผู้ขอใช้รถ
  is_driver      INTEGER NOT NULL DEFAULT 0,  -- พนักงานขับรถยนต์
  is_responsible INTEGER NOT NULL DEFAULT 0,  -- เจ้าหน้าที่ผู้รับผิดชอบ
  is_approver    INTEGER NOT NULL DEFAULT 0,  -- ผู้มีอำนาจ
  active         INTEGER NOT NULL DEFAULT 1,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  is_demo        INTEGER NOT NULL DEFAULT 0
);

-- รายการสถานที่/วัตถุประสงค์ที่ใช้บ่อย
CREATE TABLE IF NOT EXISTS presets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK (kind IN ('destination','purpose')),
  text       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_demo    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (kind, text)
);

-- บัญชีผู้ดูแลระบบ (มีแถวเดียว) แยกจาก settings เพื่อไม่ให้แฮชรหัสผ่านหลุดไปกับ /api/meta
CREATE TABLE IF NOT EXISTS admin_account (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_default    INTEGER NOT NULL DEFAULT 1,  -- ยังใช้รหัสผ่านเริ่มต้นอยู่
  admin_user_id INTEGER REFERENCES users(id),
  guest_user_id INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
`;

// ข้อความบนแบบพิมพ์ (ตามแบบฟอร์ม "แบบ ๔" ของ สนง.กกต.จว.เชียงใหม่) ผู้ดูแลแก้ไขได้ที่หน้าตั้งค่า
const DEFAULT_SETTINGS = {
  org_name: 'สนง.กกต.จว.เชียงใหม่',
  form_title: 'ใบขออนุญาตใช้รถส่วนกลาง/รถรับรอง',
  form_code: 'แบบ ๔',
  form_to: 'ผอ.สนง.กกต.จว.เชียงใหม่',
  org_affiliation: 'สนง.กกต.จว.เชียงใหม่',
  return_place: 'สนง.',
  responsible_heading: 'ความเห็น/คำแนะนำของผู้รับผิดชอบ',
  responsible_title: 'เจ้าหน้าที่ผู้รับผิดชอบ',
  approver_heading: 'คำสั่ง',
  approver_title: 'ผู้มีอำนาจ',
  trip_heading: 'บันทึกการใช้รถ',
  form_footer: '',
  // การจอง: '0' = จองแล้วยืนยันทันที ไม่ต้องรออนุมัติ / '1' = ต้องให้ผู้ดูแลอนุมัติก่อน
  require_approval: '0',
  // ตรวจการจองซ้ำ: 'day' = รถ 1 คันจองได้ 1 รายการต่อวัน / 'time' = ห้ามช่วงเวลาทับกัน (วันเดียวกันต่างเวลาได้)
  conflict_mode: 'day',
  // รูปแบบหน้าพิมพ์ (JSON) — ค่าเริ่มต้นและการตรวจค่าอยู่ใน lib/printLayout.js
  print_layout: '{}',
};

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  // v4: คอลัมน์เลขลำดับตามทะเบียนรถ (ฐานข้อมูลเดิมยังไม่มี)
  ensureColumn(db, 'vehicles', 'seq_start', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'bookings', 'vehicle_seq', 'INTEGER');
  // v5: รหัสลับของการจอง ให้ผู้จองที่ไม่ได้ล็อกอินดู/ยกเลิก/พิมพ์การจองของตนได้
  ensureColumn(db, 'bookings', 'owner_token', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_bookings_owner_token ON bookings(owner_token)');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  if (version >= 1 && version < 2) migrateToV2(db);
  if (version >= 1 && version < 3) tx(db, () => seedPeople(db)); // v3: รายชื่อบุคลากรและรายการที่ใช้บ่อย
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  if (!hasUsers) {
    // SEED_DEMO=0: ติดตั้งจริงโดยไม่มีข้อมูลตัวอย่าง (มีเฉพาะประเภทรถตามแบบฟอร์ม)
    if (process.env.SEED_DEMO === '0') {
      const ty = db.prepare('INSERT OR IGNORE INTO vehicle_types(name, sort_order) VALUES (?, ?)');
      tx(db, () => FORM_TYPES.forEach((n, i) => ty.run(n, i + 1)));
    } else seedDemo(db);
  }
  assignMissingSeq(db);
  ensureAccounts(db);
  return db;
}

/** ประเภทรถตามช่องทำเครื่องหมายบนแบบฟอร์ม เรียงตามลำดับบนกระดาษ */
const FORM_TYPES = ['รถเก๋ง', 'รถกระบะ', 'รถตู้', 'รถจักรยานยนต์'];

/**
 * v1 → v2: ใช้แบบฟอร์มจริง "แบบ ๔" — ไม่ลบข้อมูลใด ๆ
 * - ข้อความบนแบบพิมพ์ที่ยังเป็นค่าเริ่มต้นเดิม เปลี่ยนเป็นข้อความตามแบบฟอร์ม (ที่ผู้ดูแลแก้เองแล้วคงไว้)
 * - เพิ่มประเภท "รถจักรยานยนต์" และเรียงประเภทตามแบบฟอร์ม ประเภทเดิมที่ไม่มีรถใช้งานจะถูกปิด (ไม่ลบ)
 */
function migrateToV2(db) {
  const OLD = { org_name: 'หน่วยงานตัวอย่าง', form_code: '', form_to: '', responsible_title: 'ผู้รับผิดชอบ', approver_title: 'ผู้มีอำนาจอนุมัติ' };
  tx(db, () => {
    const up = db.prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?');
    for (const [k, old] of Object.entries(OLD)) up.run(DEFAULT_SETTINGS[k], k, old);
    if (db.prepare('SELECT COUNT(*) AS n FROM vehicle_types').get().n > 0) {
      const addType = db.prepare('INSERT OR IGNORE INTO vehicle_types(name, sort_order) VALUES (?, 0)');
      const order = db.prepare('UPDATE vehicle_types SET sort_order = ?, active = 1 WHERE name = ?');
      FORM_TYPES.forEach((n, i) => { addType.run(n); order.run(i + 1, n); });
      const others = db.prepare(`SELECT id FROM vehicle_types WHERE name NOT IN (${FORM_TYPES.map(() => '?').join(',')}) ORDER BY sort_order`).all(...FORM_TYPES);
      others.forEach((t, i) => {
        const used = db.prepare('SELECT COUNT(*) AS n FROM vehicles WHERE type_id = ? AND active = 1').get(t.id).n > 0;
        db.prepare('UPDATE vehicle_types SET sort_order = ?, active = ? WHERE id = ?').run(FORM_TYPES.length + 1 + i, used ? 1 : 0, t.id);
      });
    }
  });
}

/**
 * บัญชีผู้ดูแล + ผู้ใช้ระบบ 2 คน: "ผู้ดูแลระบบ" (ผู้ทำรายการเมื่อล็อกอิน) และ "ผู้ใช้งานทั่วไป" (เจ้าของการจองที่ไม่ได้ล็อกอิน)
 * รหัสผ่านเริ่มต้น: ตัวแปร ADMIN_PASSWORD หรือ admin1234 (ระบบเตือนให้เปลี่ยน)
 */
function ensureAccounts(db) {
  const { hashPassword } = require('./auth');
  const acc = db.prepare('SELECT * FROM admin_account WHERE id = 1').get();
  const userOk = (id, role) => id && db.prepare('SELECT id FROM users WHERE id = ? AND role = ?').get(id, role);
  const mkUser = (name, role) => Number(db.prepare("INSERT INTO users(name, position, department, role, is_demo) VALUES (?, '', '', ?, 0)").run(name, role).lastInsertRowid);
  tx(db, () => {
    const adminId = userOk(acc?.admin_user_id, 'admin') ? acc.admin_user_id : mkUser('ผู้ดูแลระบบ', 'admin');
    const guestId = userOk(acc?.guest_user_id, 'user') ? acc.guest_user_id : mkUser('ผู้ใช้งานทั่วไป', 'user');
    if (!acc) {
      const pw = process.env.ADMIN_PASSWORD || 'admin1234';
      db.prepare('INSERT INTO admin_account(id, username, password_hash, is_default, admin_user_id, guest_user_id) VALUES (1, ?, ?, ?, ?, ?)')
        .run(process.env.ADMIN_USERNAME || 'admin', hashPassword(pw), process.env.ADMIN_PASSWORD ? 0 : 1, adminId, guestId);
    } else if (adminId !== acc.admin_user_id || guestId !== acc.guest_user_id) {
      db.prepare('UPDATE admin_account SET admin_user_id = ?, guest_user_id = ? WHERE id = 1').run(adminId, guestId);
    }
  });
}

function ensureColumn(db, table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

/** เลขถัดไปของรถคันนี้ = มากกว่าเลขสูงสุดที่ใช้แล้ว (หรือเลขเริ่มต้นที่ตั้งไว้) */
function nextVehicleSeq(db, vehicleId) {
  const r = db.prepare(`SELECT MAX(COALESCE((SELECT MAX(vehicle_seq) FROM bookings WHERE vehicle_id = v.id), 0), v.seq_start - 1) AS last
    FROM vehicles v WHERE v.id = ?`).get(vehicleId);
  return (r ? r.last : 0) + 1;
}

/** ใส่เลขให้การจองที่มีรถแต่ยังไม่มีเลข เรียงตามเวลาที่สร้าง (ใช้กับข้อมูลเดิมและข้อมูลตัวอย่าง) */
function assignMissingSeq(db) {
  const rows = db.prepare('SELECT id, vehicle_id FROM bookings WHERE vehicle_id IS NOT NULL AND vehicle_seq IS NULL ORDER BY created_at, id').all();
  if (!rows.length) return;
  const set = db.prepare('UPDATE bookings SET vehicle_seq = ? WHERE id = ?');
  tx(db, () => { for (const r of rows) set.run(nextVehicleSeq(db, r.vehicle_id), r.id); });
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** ลบข้อมูลตัวอย่างทั้งหมด (รถ คำขอ การซ่อม ที่ is_demo = 1) — ผู้ใช้ตัวอย่างยังคงไว้เพื่อให้สลับบทบาทได้ */
function clearDemo(db) {
  tx(db, () => {
    db.exec(`
      DELETE FROM bookings WHERE is_demo = 1;
      DELETE FROM maintenance WHERE is_demo = 1 OR vehicle_id IN (SELECT id FROM vehicles WHERE is_demo = 1);
      UPDATE bookings SET vehicle_id = NULL WHERE vehicle_id IN (SELECT id FROM vehicles WHERE is_demo = 1);
      UPDATE trip_logs SET vehicle_id = NULL WHERE vehicle_id IN (SELECT id FROM vehicles WHERE is_demo = 1);
      DELETE FROM vehicles WHERE is_demo = 1;
      DELETE FROM people WHERE is_demo = 1;
      DELETE FROM presets WHERE is_demo = 1;
    `);
  });
}

/** รายชื่อบุคลากรและรายการที่ใช้บ่อยตัวอย่าง (เพิ่มเฉพาะชื่อที่ยังไม่มี) */
function seedPeople(db) {
  const has = db.prepare('SELECT id FROM people WHERE name = ?');
  const ins = db.prepare(`INSERT INTO people(name, position, department, phone, is_staff, is_driver, is_responsible, is_approver, sort_order, is_demo)
    VALUES (?,?,?,?,?,?,?,?,?,1)`);
  let order = 0;
  const add = (name, position, department, phone, roles) => {
    order += 1;
    if (!name || has.get(name)) return;
    ins.run(name, position, department, phone, roles.staff ? 1 : 0, roles.driver ? 1 : 0, roles.responsible ? 1 : 0, roles.approver ? 1 : 0, order);
  };
  add('นายสมชาย ตัวอย่าง', 'ผู้อำนวยการสำนักงาน', 'สนง.กกต.จว.เชียงใหม่', '', { approver: true });
  for (const u of db.prepare('SELECT * FROM users WHERE is_demo = 1 ORDER BY id').all()) {
    add(u.name, u.position, u.department, u.phone, { staff: true, responsible: u.role === 'admin' });
  }
  for (const v of db.prepare("SELECT DISTINCT driver_name, driver_phone FROM vehicles WHERE driver_name <> '' AND is_demo = 1").all()) {
    add(v.driver_name, 'พนักงานขับรถยนต์', 'ฝ่ายบริหารทั่วไป', v.driver_phone, { driver: true });
  }
  const pre = db.prepare('INSERT OR IGNORE INTO presets(kind, text, sort_order, is_demo) VALUES (?, ?, ?, 1)');
  ['ศาลากลางจังหวัดเชียงใหม่', 'สำนักงานคณะกรรมการการเลือกตั้ง (ส่วนกลาง) กรุงเทพมหานคร', 'ที่ว่าการอำเภอเมืองเชียงใหม่', 'ที่ทำการไปรษณีย์ช้างคลาน']
    .forEach((t, i) => pre.run('destination', t, i + 1));
  ['ประชุมหารือการเตรียมการเลือกตั้ง', 'นำส่งหนังสือราชการ', 'ตรวจเยี่ยมและติดตามการปฏิบัติงานในพื้นที่', 'จัดอบรมให้ความรู้แก่เจ้าหน้าที่']
    .forEach((t, i) => pre.run('purpose', t, i + 1));
}

/** ใส่ข้อมูลตัวอย่าง โดยกำหนดเวลาอิงจากวันนี้ (เวลาไทย) เพื่อให้เห็นทุกสถานะ */
function seedDemo(db) {
  const now = new Date().toISOString();
  const t = bkkParts(now);
  // วันที่ไทยแบบเลื่อนวัน: at(0, 9) = วันนี้ 09:00 น. เวลาไทย
  const at = (dayOffset, hh, mm = 0) => bkkToIso(t.y, t.m, t.d + dayOffset, hh, mm);
  const hoursFromNow = (h) => new Date(Date.now() + h * 3600e3).toISOString();

  tx(db, () => {
    const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    if (userCount === 0) {
      const u = db.prepare('INSERT INTO users(name, position, department, phone, role, is_demo) VALUES (?,?,?,?,?,1)');
      u.run('นางสาวกมลวรรณ ใจดี', 'เจ้าหน้าที่บริหารงานทั่วไป', 'ฝ่ายบริหารทั่วไป', '081-000-0001', 'user');
      u.run('นายธนากร ศรีสุข', 'นักวิชาการคอมพิวเตอร์', 'ฝ่ายเทคโนโลยีสารสนเทศ', '081-000-0002', 'user');
      u.run('นายประเสริฐ มั่นคง', 'หัวหน้างานยานพาหนะ', 'ฝ่ายบริหารทั่วไป', '081-000-0003', 'admin');
    }
    const typeCount = db.prepare('SELECT COUNT(*) AS n FROM vehicle_types').get().n;
    if (typeCount === 0) {
      const ty = db.prepare('INSERT INTO vehicle_types(name, sort_order) VALUES (?, ?)');
      FORM_TYPES.forEach((n, i) => ty.run(n, i + 1));
    }
    const typeId = (name) => db.prepare('SELECT id FROM vehicle_types WHERE name = ?').get(name).id;
    const users = db.prepare('SELECT * FROM users WHERE is_demo = 1 ORDER BY id').all();
    const approvalMode = (db.prepare("SELECT value FROM settings WHERE key = 'require_approval'").get()?.value ?? '0') === '1';
    if (users.length < 3) throw new Error('ไม่พบผู้ใช้ตัวอย่างครบ 3 คน จึงไม่สามารถสร้างข้อมูลตัวอย่างได้');
    const [u1, u2, admin] = users;

    const v = db.prepare(`INSERT INTO vehicles(plate, brand, model, type_id, seats, color, driver_name, driver_phone, mileage, note, active, is_demo, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`);
    const vid = (r) => Number(r.lastInsertRowid);
    const car1 = vid(v.run('กข 1234 เชียงใหม่', 'Toyota', 'Camry 2.5', typeId('รถเก๋ง'), 4, 'ดำ', 'นายสมศักดิ์ ขับดี', '089-111-1111', 45210, 'รถรับรองผู้บริหาร', 1, now, now));
    const van1 = vid(v.run('นข 5678 เชียงใหม่', 'Toyota', 'Commuter', typeId('รถตู้'), 12, 'ขาว', 'นายวิชัย ปลอดภัย', '089-222-2222', 120340, '', 1, now, now));
    const van2 = vid(v.run('ฮค 9012 เชียงใหม่', 'Hyundai', 'H-1', typeId('รถตู้'), 11, 'เงิน', '', '', 88050, 'ยังไม่มีพนักงานขับรถประจำ', 1, now, now));
    const pick1 = vid(v.run('บต 3456 เชียงใหม่', 'Isuzu', 'D-Max 4 ประตู', typeId('รถกระบะ'), 5, 'เทา', 'นายบุญมี แข็งแรง', '089-333-3333', 67500, '', 1, now, now));
    const suv1 = vid(v.run('1กร 7788 เชียงใหม่', 'Honda', 'Wave 110i', typeId('รถจักรยานยนต์'), 2, 'แดง', '', '', 30120, 'ผู้ขอขับขี่เอง', 1, now, now));
    vid(v.run('ศษ 2468 เชียงใหม่', 'Nissan', 'Almera', typeId('รถเก๋ง'), 4, 'ขาว', '', '', 150800, 'รอจำหน่าย ปิดใช้งาน', 0, now, now));

    db.prepare(`INSERT INTO maintenance(vehicle_id, start_at, end_at, description, created_by, created_at, is_demo) VALUES (?,?,?,?,?,?,1)`)
      .run(pick1, at(-1, 8), at(2, 17), 'เข้าศูนย์ตรวจเช็กระยะ 70,000 กม. และเปลี่ยนยาง', admin.id, now);

    let seq = 0;
    const be = bkkParts(now).y + 543;
    const b = db.prepare(`INSERT INTO bookings(code, user_id, requester_name, requester_position, requester_department, requester_phone,
      purpose, destination, companions, passenger_count, type_id, vehicle_id, need_driver, assigned_driver, start_at, end_at, note, status,
      decision_note, decided_by, decided_at, cancel_reason, created_at, updated_at, is_demo)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`);
    const driverOf = (vehicleId) => vehicleId ? db.prepare('SELECT driver_name FROM vehicles WHERE id = ?').get(vehicleId).driver_name : '';
    const ev = db.prepare('INSERT INTO booking_events(booking_id, at, user_id, user_name, action, note) VALUES (?,?,?,?,?,?)');
    const add = (o) => {
      // โหมดไม่ต้องอนุมัติ: ไม่มีสถานะรออนุมัติ/ไม่อนุมัติ จึงแปลงข้อมูลตัวอย่างให้สอดคล้อง
      if (!approvalMode && o.status === 'rejected') return null;
      if (!approvalMode && o.status === 'pending') { o.status = 'approved'; o.vehicle = o.vehicle ?? o.fallbackVehicle; }
      seq += 1;
      const code = `DEMO-${be}-${String(seq).padStart(4, '0')}`; // รหัสขึ้นต้น DEMO = ข้อมูลตัวอย่าง
      const created = o.created || at(-3, 10);
      const id = Number(b.run(code, o.user.id, o.user.name, o.user.position, o.user.department, o.user.phone,
        o.purpose, o.destination, o.companions || '', o.pax, typeId(o.type), o.vehicle ?? null, 1,
        ['approved', 'completed'].includes(o.status) ? (o.driver ?? driverOf(o.vehicle)) : '', o.start, o.end, o.note || '',
        o.status, approvalMode ? (o.decision || '') : '', o.status === 'pending' || !approvalMode ? null : admin.id, o.status === 'pending' ? null : created,
        o.cancel || '', created, created).lastInsertRowid);
      ev.run(id, created, o.user.id, o.user.name, 'create', '');
      if (['approved', 'completed'].includes(o.status)) {
        if (approvalMode) ev.run(id, created, admin.id, admin.name, 'approve', o.decision || '');
        else ev.run(id, created, o.user.id, o.user.name, 'confirm', 'จองสำเร็จ (ไม่ต้องรออนุมัติ)');
      }
      if (o.status === 'rejected') ev.run(id, created, admin.id, admin.name, 'reject', o.decision || '');
      if (o.status === 'cancelled') ev.run(id, created, o.user.id, o.user.name, 'cancel', o.cancel || '');
      return id;
    };

    // 1) กำลังใช้งานอยู่ตอนนี้ (ออกเดินทางแล้ว ยังไม่กลับ)
    const inUse = add({ user: u2, purpose: 'ติดตั้งระบบเครือข่ายและอบรมผู้ใช้งาน', destination: 'สนง.กกต. อำเภอแม่ริม', companions: 'นายเอกชัย ทองดี, นางสาวพิมพ์ชนก แก้วมณี', pax: 3,
      type: 'รถตู้', vehicle: van1, start: hoursFromNow(-2), end: hoursFromNow(3), status: 'approved', decision: 'อนุมัติ' });
    db.prepare('INSERT INTO trip_logs(booking_id, vehicle_id, driver_name, depart_at, depart_mileage, recorded_by, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(inUse, van1, 'นายวิชัย ปลอดภัย', hoursFromNow(-2), 120340, admin.id, now);
    // 2) อนุมัติแล้ว จะใช้งานพรุ่งนี้
    add({ user: u1, purpose: 'ประชุมคณะกรรมการร่วมกับหน่วยงานภายนอก', destination: 'ศาลากลางจังหวัดเชียงใหม่', pax: 2,
      type: 'รถเก๋ง', vehicle: car1, start: at(1, 9), end: at(1, 16), status: 'approved', decision: 'อนุมัติ ให้ออกเดินทางก่อนเวลา 15 นาที' });
    // 3) รออนุมัติ (ระบุรถแล้ว)
    add({ user: u1, purpose: 'นำส่งเอกสารและพัสดุ', destination: 'ที่ทำการไปรษณีย์ช้างคลาน', pax: 1,
      type: 'รถตู้', vehicle: van2, start: at(2, 13), end: at(2, 16), status: 'pending', created: now });
    // 4) รออนุมัติ (ยังไม่ระบุรถ ให้ผู้ดูแลจัดรถ)
    add({ user: u2, purpose: 'ศึกษาดูงานระบบบริหารจัดการข้อมูล', destination: 'อำเภอฝาง จังหวัดเชียงใหม่', companions: 'ทีมงานฝ่ายเทคโนโลยีสารสนเทศ 5 คน', pax: 6,
      type: 'รถตู้', vehicle: null, fallbackVehicle: van1, start: at(4, 7, 30), end: at(4, 18), status: 'pending', created: now, note: 'ขอรถที่มีที่นั่งอย่างน้อย 7 ที่' });
    // 5) ไม่อนุมัติ
    add({ user: u2, purpose: 'รับอุปกรณ์คอมพิวเตอร์', destination: 'ร้านค้าอุปกรณ์คอมพิวเตอร์ ถนนห้วยแก้ว', pax: 1,
      type: 'รถกระบะ', vehicle: pick1, start: at(1, 10), end: at(1, 12), status: 'rejected', decision: 'รถกระบะอยู่ระหว่างซ่อมบำรุง ให้ใช้บริการขนส่งของผู้ขายแทน' });
    // 6) ยกเลิกโดยผู้ขอ
    add({ user: u1, purpose: 'อบรมหลักสูตรงานสารบรรณ', destination: 'โรงแรมในอำเภอเมืองเชียงใหม่', pax: 2,
      type: 'รถเก๋ง', vehicle: car1, start: at(3, 8), end: at(3, 17), status: 'cancelled', cancel: 'เลื่อนการอบรมออกไปไม่มีกำหนด' });
    // 7) เสร็จสิ้น พร้อมบันทึกการใช้รถ
    const done = add({ user: u1, purpose: 'นำส่งหนังสือราชการ', destination: 'ที่ว่าการอำเภอสันทราย', pax: 1,
      type: 'รถจักรยานยนต์', vehicle: suv1, driver: 'นางสาวกมลวรรณ ใจดี', start: at(-5, 8), end: at(-5, 17), status: 'completed', decision: 'อนุมัติ', created: at(-8, 10) });
    db.prepare('INSERT INTO trip_logs(booking_id, vehicle_id, driver_name, depart_at, depart_mileage, return_at, return_mileage, recorded_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(done, suv1, 'นางสาวกมลวรรณ ใจดี', at(-5, 8, 5), 30078, at(-5, 11, 40), 30120, admin.id, now);
    ev.run(done, at(-5, 11, 40), admin.id, admin.name, 'trip', 'บันทึกการใช้รถ ระยะทาง 42 กม.');
    seedPeople(db);
  });
}

module.exports = { openDb, tx, seedDemo, clearDemo, nextVehicleSeq, assignMissingSeq, DEFAULT_SETTINGS };
