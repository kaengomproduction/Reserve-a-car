// ตัวเชื่อม Supabase: แปลงการเรียก api('METHOD', '/api/...') แบบเดิมของหน้าเว็บ ไปเป็น REST/RPC ของ Supabase
// กฎสำคัญ (กันจองซ้ำ เลขที่ สิทธิ์ รหัสลับการจอง) อยู่ในฐานข้อมูล — ดู supabase/schema.sql
import { ApiError, getTokens } from './util.js';
import { DEFAULT_LAYOUT, sanitizeLayout } from './printLayout.mjs';
import { readTable, planImport, fromBase64, ImportError } from './peopleImport.mjs';

const CFG = window.APP_CONFIG || {};
const BASE = String(CFG.supabaseUrl || '').replace(/\/+$/, '');
const KEY = CFG.supabaseAnonKey || '';
const SESSION_KEY = 'vb.sb.session';
const ROLE_COLS = ['is_staff', 'is_driver', 'is_responsible', 'is_approver'];

// ---------- session ของผู้ดูแล (Supabase Auth) ----------
const store = {
  get() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } },
  set(s) { try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch { /* ไม่มี storage */ } },
};
function saveSession(d) {
  store.set({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600), email: d.user?.email || store.get()?.email || '', user_id: d.user?.id || store.get()?.user_id });
}
let refreshing = null;
async function accessToken() {
  const s = store.get();
  if (!s) return null;
  if (s.expires_at * 1000 - Date.now() > 60e3) return s.access_token;
  // ต่ออายุ token อัตโนมัติ
  refreshing ||= fetch(`${BASE}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh_token }),
  }).then(async (r) => { if (!r.ok) throw new Error('refresh'); saveSession(await r.json()); }).catch(() => store.set(null)).finally(() => { refreshing = null; });
  await refreshing;
  return store.get()?.access_token || null;
}

// ---------- HTTP ----------
function toError(status, d) {
  let conflicts;
  try { const x = JSON.parse(d?.details); if (Array.isArray(x)) conflicts = x; } catch { /* ไม่มีรายละเอียด */ }
  let msg = d?.message || d?.msg || d?.error_description || d?.error || 'เกิดข้อผิดพลาด';
  if (d?.code === '23505') msg = 'ข้อมูลซ้ำกับที่มีอยู่ในระบบ';
  if (d?.code === '42501') { msg = 'คุณไม่มีสิทธิ์ทำรายการนี้ (กรุณาเข้าสู่ระบบผู้ดูแล)'; status = 403; }
  if (d?.code === 'PGRST301' || /JWT expired/i.test(msg)) { store.set(null); msg = 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'; status = 401; }
  return new ApiError(status, { error: msg, conflicts });
}
async function http(path, { method = 'GET', body, headers = {}, anon = false } = {}) {
  if (!BASE || !KEY) throw new ApiError(0, { error: 'ยังไม่ได้ตั้งค่า Supabase (config.js)' });
  const token = anon ? null : await accessToken();
  let res;
  try {
    res = await fetch(BASE + path, {
      method, headers: { apikey: KEY, Authorization: `Bearer ${token || KEY}`, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new ApiError(0, { error: 'เชื่อมต่อฐานข้อมูลไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ต' }); }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!res.ok) throw toError(res.status, data);
  return data;
}
const rpc = (fn, args = {}) => http(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args });
const rest = (path, opts) => http(`/rest/v1/${path}`, opts);
const tokens = () => getTokens();
const enc = encodeURIComponent;

// ---------- ข้อมูลช่วย ----------
const str = (v, max = 500) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const intOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'on' || v === 'true';
const bad = (msg) => new ApiError(400, { error: msg });
let adminCache = null; // { isAdmin, name } ต่อหนึ่ง session
async function isAdmin() {
  const s = store.get();
  if (!s) return false;
  if (adminCache?.token === s.access_token) return adminCache.isAdmin;
  const ok = await rpc('is_admin').catch(() => false);
  adminCache = { token: s.access_token, isAdmin: !!ok };
  return !!ok;
}
async function adminName() {
  const rows = await rest('admin_users?select=display_name').catch(() => []);
  return rows[0]?.display_name || 'ผู้ดูแลระบบ';
}
async function settingsObject() {
  const rows = await rest('settings?select=key,value');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
function filterVehicles(rows, f) {
  let out = rows;
  if (f.type_id) out = out.filter((v) => v.type_id === Number(f.type_id));
  if (f.state) out = out.filter((v) => v.state === f.state);
  if (f.min_seats) out = out.filter((v) => v.seats >= Number(f.min_seats));
  if (f.q) {
    const s = String(f.q).toLowerCase();
    out = out.filter((v) => [v.plate, v.brand, v.model, v.driver_name, v.type_name].join(' ').toLowerCase().includes(s));
  }
  return out;
}
async function affectedBookings(vehicleId, start, end) {
  let q = `bookings?select=id,code,status,start_at,end_at&vehicle_id=eq.${vehicleId}&status=in.(pending,approved)&end_at=gt.${enc(start)}&order=start_at`;
  if (end) q += `&start_at=lt.${enc(end)}`;
  return rest(q).catch(() => []);
}
async function getVehicle(id) {
  const [v] = await rest(`vehicles?id=eq.${id}&select=*,vehicle_types(name)`);
  if (!v) throw new ApiError(404, { error: 'ไม่พบรถ' });
  v.type_name = v.vehicle_types?.name || ''; delete v.vehicle_types;
  v.maintenance = (await rest(`maintenance?vehicle_id=eq.${id}&order=start_at.desc`)).map((m) => ({ ...m, created_by_name: m.created_by }));
  v.next_seq = await rpc('next_vehicle_seq', { p_vehicle: id });
  return v;
}
async function vehicleInput(body) {
  const d = {
    plate: str(body.plate, 60), brand: str(body.brand, 80), model: str(body.model, 80),
    type_id: intOrNull(body.type_id), seats: intOrNull(body.seats), color: str(body.color, 40),
    driver_name: str(body.driver_name, 120), driver_phone: str(body.driver_phone, 40),
    mileage: intOrNull(body.mileage), note: str(body.note, 1000),
    seq_start: body.seq_start === undefined || body.seq_start === '' ? 1 : intOrNull(body.seq_start),
  };
  if (!d.plate) throw bad('กรุณาระบุทะเบียนรถ');
  if (!d.type_id) throw bad('กรุณาเลือกประเภทรถ');
  if (!Number.isInteger(d.seats) || d.seats < 1 || d.seats > 100) throw bad('จำนวนที่นั่งต้องเป็นตัวเลข 1–100');
  if (Number.isNaN(d.mileage) || (d.mileage !== null && d.mileage < 0)) throw bad('เลขไมล์ต้องเป็นจำนวนเต็มไม่ติดลบ');
  if (!Number.isInteger(d.seq_start) || d.seq_start < 1) throw bad('เลขลำดับเริ่มต้นต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
  return d;
}
function personInput(body) {
  const d = { name: str(body.name, 120), position: str(body.position, 120), department: str(body.department, 160), phone: str(body.phone, 40) };
  if (!d.name) throw bad('กรุณาระบุชื่อ-นามสกุล');
  for (const k of ROLE_COLS) d[k] = truthy(body[k]);
  if (!ROLE_COLS.some((k) => d[k])) throw bad('กรุณาเลือกหน้าที่อย่างน้อย 1 อย่าง');
  d.active = 'active' in body ? truthy(body.active) : true;
  return d;
}
const minimal = { Prefer: 'return=minimal' };
const single = { Prefer: 'return=representation' };

// ---------- เส้นทาง ----------
const routes = [
  ['GET', /^\/api\/session$/, async () => {
    const admin = await isAdmin();
    if (store.get() && !admin) store.set(null);
    const name = admin ? await adminName() : 'ผู้ใช้งานทั่วไป';
    return {
      user: { id: null, name, role: admin ? 'admin' : 'user' }, isAdmin: admin,
      account: admin ? { username: store.get()?.email || '', is_default: false, display_name: name, email_login: true } : null,
      demo: await rpc('demo_info'),
    };
  }],
  ['POST', /^\/api\/login$/, async (c) => {
    const email = str(c.body.username, 200), password = String(c.body.password || '');
    let d;
    try {
      d = await http('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password }, anon: true });
    } catch (e) {
      if (e.status === 400 || e.status === 401) throw new ApiError(401, { error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
      if (e.status === 429) throw new ApiError(429, { error: 'ลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่' });
      throw e;
    }
    saveSession(d);
    adminCache = null;
    if (!(await isAdmin())) {
      await http('/auth/v1/logout', { method: 'POST' }).catch(() => {});
      store.set(null);
      throw new ApiError(403, { error: 'บัญชีนี้ไม่ใช่ผู้ดูแลระบบ (ต้องเพิ่มในตาราง admin_users)' });
    }
    return { ok: true };
  }],
  ['POST', /^\/api\/logout$/, async () => {
    await http('/auth/v1/logout', { method: 'POST' }).catch(() => {});
    store.set(null); adminCache = null;
    return { ok: true };
  }],
  ['PUT', /^\/api\/account$/, async (c) => {
    if (!(await isAdmin())) throw new ApiError(403, { error: 'เฉพาะผู้ดูแลระบบเท่านั้นที่ทำรายการนี้ได้' });
    const s = store.get();
    if (c.body.username && c.body.username.trim().toLowerCase() !== s.email.toLowerCase()) {
      throw bad('เปลี่ยนอีเมลผู้ดูแลได้ที่ Supabase → Authentication → Users');
    }
    // ยืนยันรหัสผ่านปัจจุบันก่อนแก้ไข
    try { await http('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: s.email, password: String(c.body.current_password || '') }, anon: true }); }
    catch { throw bad('รหัสผ่านปัจจุบันไม่ถูกต้อง'); }
    const display = str(c.body.display_name, 120);
    if (display) await rest(`admin_users?user_id=eq.${s.user_id}`, { method: 'PATCH', body: { display_name: display }, headers: minimal });
    if (c.body.new_password) {
      if (String(c.body.new_password).length < 8) throw bad('รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร');
      await http('/auth/v1/user', { method: 'PUT', body: { password: String(c.body.new_password) } });
    }
    return { username: s.email, is_default: false, display_name: display || await adminName() };
  }],

  ['GET', /^\/api\/meta$/, async () => {
    const admin = await isAdmin();
    const [types, settings, people, presets] = await Promise.all([
      rest('vehicle_types?select=*&order=sort_order,id'),
      settingsObject(),
      admin ? rest('people?select=*&order=active.desc,sort_order,name') : rest('people_public?select=*&order=sort_order,name'),
      rest('presets?select=*&order=kind,sort_order,id'),
    ]);
    let layout = {};
    try { layout = JSON.parse(settings.print_layout || '{}'); } catch { /* ใช้ค่าเริ่มต้น */ }
    return { types, settings, print_layout: sanitizeLayout(layout), print_layout_default: DEFAULT_LAYOUT, people, presets };
  }],
  ['PUT', /^\/api\/settings$/, async (c) => {
    const rows = [];
    for (const [key, value] of Object.entries(c.body)) {
      if (key === 'print_layout') { rows.push({ key, value: JSON.stringify(sanitizeLayout(typeof value === 'string' ? JSON.parse(value || '{}') : value)) }); continue; }
      if (key === 'require_approval' && !['0', '1'].includes(String(value))) throw bad('ค่าการอนุมัติไม่ถูกต้อง');
      if (key === 'conflict_mode' && !['day', 'time'].includes(String(value))) throw bad('รูปแบบการตรวจการจองซ้ำไม่ถูกต้อง');
      rows.push({ key, value: str(value, 1000) });
    }
    if (rows.length) await rest('settings', { method: 'POST', body: rows, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
    return settingsObject();
  }],
  ['POST', /^\/api\/vehicle-types$/, async (c) => {
    const name = str(c.body.name, 100);
    if (!name) throw bad('กรุณาระบุชื่อประเภทรถ');
    const [last] = await rest('vehicle_types?select=sort_order&order=sort_order.desc&limit=1');
    const [t] = await rest('vehicle_types', { method: 'POST', body: { name, sort_order: (last?.sort_order || 0) + 1 }, headers: single });
    return t;
  }],
  ['PUT', /^\/api\/vehicle-types\/(\d+)$/, async (c) => {
    const name = str(c.body.name, 100);
    if (!name) throw bad('กรุณาระบุชื่อประเภทรถ');
    const [t] = await rest(`vehicle_types?id=eq.${c.id}`, { method: 'PATCH', body: { name, sort_order: Number(c.body.sort_order) || 0, active: c.body.active !== false && c.body.active !== 0 }, headers: single });
    if (!t) throw new ApiError(404, { error: 'ไม่พบประเภทรถ' });
    return t;
  }],

  ['GET', /^\/api\/dashboard$/, async (c) => {
    const all = await rpc('vehicle_states', { p_from: c.query.from || null, p_to: c.query.to || null });
    const counts = { total: all.length, available: 0, booked: 0, in_use: 0, unavailable: 0 };
    for (const v of all) counts[v.state] += 1;
    const d = await rpc('dashboard_counts', { p_tokens: tokens() });
    return { counts, pending: d.pending, overdue: d.overdue, vehicles: filterVehicles(all, c.query) };
  }],
  ['GET', /^\/api\/vehicles$/, async (c) => filterVehicles(await rpc('vehicle_states', { p_from: c.query.from || null, p_to: c.query.to || null }), c.query)],
  ['POST', /^\/api\/vehicles$/, async (c) => {
    const d = await vehicleInput(c.body);
    const [v] = await rest('vehicles', { method: 'POST', body: d, headers: single });
    return getVehicle(v.id);
  }],
  ['GET', /^\/api\/vehicles\/(\d+)$/, (c) => getVehicle(c.id)],
  ['PUT', /^\/api\/vehicles\/(\d+)$/, async (c) => {
    const d = await vehicleInput(c.body);
    await rest(`vehicles?id=eq.${c.id}`, { method: 'PATCH', body: { ...d, updated_at: new Date().toISOString() }, headers: minimal });
    return getVehicle(c.id);
  }],
  ['POST', /^\/api\/vehicles\/(\d+)\/active$/, async (c) => {
    const active = !!c.body.active;
    await rest(`vehicles?id=eq.${c.id}`, { method: 'PATCH', body: { active, updated_at: new Date().toISOString() }, headers: minimal });
    return { vehicle: await getVehicle(c.id), warnings: active ? [] : await affectedBookings(c.id, new Date().toISOString()) };
  }],
  ['POST', /^\/api\/vehicles\/(\d+)\/maintenance$/, async (c) => {
    const start = c.body.start_at ? new Date(c.body.start_at).toISOString() : null;
    const end = c.body.end_at ? new Date(c.body.end_at).toISOString() : null;
    if (!start) throw bad('กรุณาระบุวันเวลาเริ่มซ่อมบำรุง');
    if (end && end <= start) throw bad('วันเวลาสิ้นสุดต้องอยู่หลังวันเวลาเริ่มซ่อม');
    const description = str(c.body.description, 1000);
    if (!description) throw bad('กรุณาระบุรายละเอียดการซ่อมบำรุง');
    const [m] = await rest('maintenance', { method: 'POST', body: { vehicle_id: c.id, start_at: start, end_at: end, description, created_by: await adminName() }, headers: single });
    return { id: m.id, warnings: await affectedBookings(c.id, start, end) };
  }],
  ['PUT', /^\/api\/maintenance\/(\d+)$/, async (c) => {
    const [m] = await rest(`maintenance?id=eq.${c.id}`);
    if (!m) throw new ApiError(404, { error: 'ไม่พบรายการซ่อมบำรุง' });
    const patch = {};
    if (c.body.start_at) patch.start_at = new Date(c.body.start_at).toISOString();
    if ('end_at' in c.body) patch.end_at = c.body.end_at ? new Date(c.body.end_at).toISOString() : null;
    if ('description' in c.body) patch.description = str(c.body.description, 1000);
    const s = patch.start_at || m.start_at, e = 'end_at' in patch ? patch.end_at : m.end_at;
    if (e && new Date(e) <= new Date(s)) throw bad('วันเวลาสิ้นสุดต้องอยู่หลังวันเวลาเริ่มซ่อม');
    await rest(`maintenance?id=eq.${c.id}`, { method: 'PATCH', body: patch, headers: minimal });
    return { id: c.id, warnings: await affectedBookings(m.vehicle_id, s, e) };
  }],
  ['DELETE', /^\/api\/maintenance\/(\d+)$/, async (c) => { await rest(`maintenance?id=eq.${c.id}`, { method: 'DELETE', headers: minimal }); return { ok: true }; }],

  ['POST', /^\/api\/availability$/, (c) => rpc('check_availability', {
    p_vehicle: Number(c.body.vehicle_id) || null, p_start: c.body.start_at || null, p_end: c.body.end_at || null, p_exclude: Number(c.body.exclude_booking_id) || 0,
  })],
  ['GET', /^\/api\/schedule$/, (c) => rpc('get_schedule', { p_from: c.query.from, p_to: c.query.to, p_tokens: tokens() })],
  ['GET', /^\/api\/bookings$/, (c) => rpc('get_bookings', {
    p_tokens: tokens(), p_status: c.query.status || null, p_q: c.query.q || null, p_trip: c.query.trip === '1', p_order: c.query.order || null,
  })],
  ['POST', /^\/api\/bookings$/, (c) => rpc('create_booking', { p: c.body })],
  ['GET', /^\/api\/bookings\/(\d+)$/, (c) => rpc('get_booking', { p_id: c.id, p_tokens: tokens() })],
  ['POST', /^\/api\/bookings\/(\d+)\/assign$/, (c) => rpc('assign_vehicle', { p_id: c.id, p_vehicle: Number(c.body.vehicle_id) || null, p_driver: c.body.assigned_driver ?? null })],
  ['POST', /^\/api\/bookings\/(\d+)\/approve$/, (c) => rpc('approve_booking', {
    p_id: c.id, p_vehicle: Number(c.body.vehicle_id) || null, p_driver: c.body.assigned_driver ?? null, p_note: c.body.note || '',
  })],
  ['POST', /^\/api\/bookings\/(\d+)\/reject$/, (c) => rpc('reject_booking', { p_id: c.id, p_reason: c.body.reason || '' })],
  ['POST', /^\/api\/bookings\/(\d+)\/cancel$/, (c) => rpc('cancel_booking', { p_id: c.id, p_reason: c.body.reason || '', p_tokens: tokens() })],
  ['POST', /^\/api\/bookings\/(\d+)\/complete$/, (c) => rpc('complete_booking', { p_id: c.id, p_note: c.body.note || '' })],
  ['PUT', /^\/api\/bookings\/(\d+)\/trip$/, (c) => rpc('save_trip', { p_id: c.id, p: c.body })],

  ['POST', /^\/api\/demo\/clear$/, () => rpc('clear_demo')],
  ['POST', /^\/api\/demo\/reset$/, () => { throw bad('การสร้างข้อมูลตัวอย่างใหม่ไม่รองรับในโหมด Supabase (ใช้ไฟล์ supabase/demo.sql แทน)'); }],

  ['POST', /^\/api\/people$/, async (c) => {
    const d = personInput(c.body);
    const [last] = await rest('people?select=sort_order&order=sort_order.desc&limit=1');
    const [p] = await rest('people', { method: 'POST', body: { ...d, sort_order: (last?.sort_order || 0) + 1 }, headers: single });
    return p;
  }],
  ['POST', /^\/api\/people\/import$/, async (c) => {
    if (!c.body.data) throw bad('กรุณาเลือกไฟล์');
    const roles = Object.fromEntries(ROLE_COLS.map((k) => [k, truthy(c.body.roles?.[k])]));
    if (!ROLE_COLS.some((k) => roles[k])) throw bad('กรุณาเลือกหน้าที่ของรายชื่อที่นำเข้าอย่างน้อย 1 อย่าง');
    const existing = await rest('people?select=*');
    let plan;
    try { plan = planImport(await readTable(fromBase64(c.body.data), c.body.filename || ''), existing); }
    catch (e) { throw bad(e instanceof ImportError ? e.message : 'อ่านไฟล์ไม่สำเร็จ กรุณาตรวจว่าเป็นไฟล์ .xlsx หรือ .csv'); }
    const { columns, counts, rows, allRows, headerRow } = plan;
    if (!c.body.commit) return { columns, counts, rows, headerRow };
    const byId = new Map(existing.map((p) => [p.id, p]));
    let order = Math.max(0, ...existing.map((p) => p.sort_order || 0));
    const fresh = allRows.filter((r) => r.action === 'new')
      .map((r) => ({ name: r.name, position: r.position, department: r.department, phone: r.phone, ...roles, active: true, sort_order: ++order }));
    if (fresh.length) await rest('people', { method: 'POST', body: fresh, headers: minimal });
    for (const r of allRows.filter((x) => x.action === 'update')) {
      const o = byId.get(r.id);
      const patch = { position: r.position || o.position, department: r.department || o.department, phone: r.phone || o.phone, active: true };
      for (const k of ROLE_COLS) patch[k] = o[k] || roles[k];
      await rest(`people?id=eq.${o.id}`, { method: 'PATCH', body: patch, headers: minimal });
    }
    return { columns, counts, imported: counts.new + counts.update };
  }],
  ['PUT', /^\/api\/people\/(\d+)$/, async (c) => {
    const [p] = await rest(`people?id=eq.${c.id}`, { method: 'PATCH', body: personInput(c.body), headers: single });
    if (!p) throw new ApiError(404, { error: 'ไม่พบรายชื่อ' });
    return p;
  }],
  ['DELETE', /^\/api\/people\/(\d+)$/, async (c) => { await rest(`people?id=eq.${c.id}`, { method: 'DELETE', headers: minimal }); return { ok: true }; }],
  ['POST', /^\/api\/presets$/, async (c) => {
    const kind = String(c.body.kind || '');
    if (!['destination', 'purpose'].includes(kind)) throw bad('ชนิดรายการไม่ถูกต้อง');
    const text = str(c.body.text, 500);
    if (!text) throw bad('กรุณาระบุข้อความ');
    const [last] = await rest(`presets?select=sort_order&kind=eq.${kind}&order=sort_order.desc&limit=1`);
    const [p] = await rest('presets', { method: 'POST', body: { kind, text, sort_order: (last?.sort_order || 0) + 1 }, headers: single });
    return p;
  }],
  ['DELETE', /^\/api\/presets\/(\d+)$/, async (c) => { await rest(`presets?id=eq.${c.id}`, { method: 'DELETE', headers: minimal }); return { ok: true }; }],
];

export async function sbApi(method, url, body) {
  const u = new URL(url, 'http://local');
  for (const [m, re, handler] of routes) {
    const match = m === method && u.pathname.match(re);
    if (match) return handler({ body: body || {}, query: Object.fromEntries(u.searchParams), id: match[1] ? Number(match[1]) : null });
  }
  throw new ApiError(404, { error: 'ไม่พบ API ที่ร้องขอ' });
}
