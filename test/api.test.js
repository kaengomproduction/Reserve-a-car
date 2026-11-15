'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server');
const { toIso, overlaps } = require('../lib/time');

let server, base, dir;
// ผู้ใช้ในการทดสอบ: ผู้ไม่ได้ล็อกอิน 2 เครื่อง (แยกกันด้วยรหัสลับการจองที่ถือ) และผู้ดูแลที่ล็อกอินแล้ว
const USER = 'u1', USER2 = 'u2', ADMIN = 'admin';
const tokens = { u1: [], u2: [] };
let adminCookie = '';

async function api(method, url, body, who = USER) {
  const headers = { 'Content-Type': 'application/json' };
  if (who === ADMIN) headers.Cookie = adminCookie;
  else if (who) headers['X-Booking-Tokens'] = tokens[who].join(',');
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (method === 'POST' && url === '/api/bookings' && res.status === 201 && tokens[who]) tokens[who].push(data.owner_token);
  return { status: res.status, data, headers: res.headers };
}
const login = (username, password) => fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });

// วันเวลาไทยในอนาคต (วันที่ +n จากวันนี้) ในรูปแบบ datetime-local
function bkkLocal(dayOffset, hh, mm = 0) {
  const d = new Date(Date.now() + 7 * 3600e3 + dayOffset * 86400e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(hh)}:${p(mm)}`;
}

before(async () => {
  delete process.env.ADMIN_PASSWORD; delete process.env.ADMIN_USERNAME;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-test-'));
  ({ server } = createApp({ dbPath: path.join(dir, 'test.db') }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await login('admin', 'admin1234');
  adminCookie = r.headers.get('set-cookie').split(';')[0];
});
after(() => { server.close(); });

test('เวลาจาก datetime-local ถูกตีความเป็นเวลาไทย (UTC+7)', () => {
  assert.equal(toIso('2026-11-08T09:00'), '2026-11-08T02:00:00.000Z');
  assert.equal(overlaps('2026-01-01T01:00Z', '2026-01-01T02:00Z', '2026-01-01T02:00Z', '2026-01-01T03:00Z'), false, 'ช่วงที่ต่อกันพอดีไม่ถือว่าทับ');
  assert.equal(overlaps('2026-01-01T01:00Z', '2026-01-01T02:30Z', '2026-01-01T02:00Z', null), true, 'end = null คือไม่มีกำหนดสิ้นสุด');
});

test('ล็อกอิน: ผู้ดูแลมีบัญชีเดียว ผู้ไม่ได้ล็อกอินใช้งานทั่วไปได้แต่ทำงานผู้ดูแลไม่ได้', async () => {
  assert.equal((await api('GET', '/api/vehicles', null, USER)).status, 200, 'ไม่ล็อกอินก็ดูรถได้');
  const guest = (await api('GET', '/api/session', null, USER)).data;
  assert.equal(guest.isAdmin, false);
  assert.equal(guest.account, null);
  assert.equal((await api('POST', '/api/vehicles', { plate: 'x', type_id: 1, seats: 4 }, USER)).status, 403);
  assert.equal((await login('admin', 'wrong')).status, 401);
  assert.equal((await login('ADMIN', 'admin1234')).status, 200, 'ชื่อผู้ใช้ไม่สนตัวพิมพ์เล็ก-ใหญ่');
  const adm = (await api('GET', '/api/session', null, ADMIN)).data;
  assert.equal(adm.isAdmin, true);
  assert.equal(adm.account.is_default, true, 'เตือนให้เปลี่ยนรหัสผ่านเริ่มต้น');
  assert.equal(JSON.stringify((await api('GET', '/api/meta', null, ADMIN)).data).includes('password'), false, 'ไม่ส่งแฮชรหัสผ่านออกไป');
});

test('แดชบอร์ดมีรถครบทุกสถานะจากข้อมูลตัวอย่าง', async () => {
  const r = await api('GET', '/api/dashboard');
  assert.equal(r.status, 200);
  const states = new Set(r.data.vehicles.map((v) => v.state));
  for (const s of ['available', 'in_use', 'unavailable']) assert.ok(states.has(s), `ควรมีสถานะ ${s}`);
  assert.ok(r.data.vehicles.every((v) => v.is_demo === 1));
});

test('ค่าเริ่มต้น: จองแล้วยืนยันทันที และรถ 1 คันจองได้ 1 รายการต่อวัน', async () => {
  const meta = (await api('GET', '/api/meta')).data.settings;
  assert.equal(meta.require_approval, '0');
  assert.equal(meta.conflict_mode, 'day');
  const vehicles = (await api('GET', '/api/vehicles')).data;
  const suv = vehicles.find((v) => v.plate.startsWith('1กร')); // รถจักรยานยนต์ 2 ที่นั่ง
  const form = { requester_department: 'ฝ่ายทดสอบ', purpose: 'ทดสอบ', destination: 'ปลายทาง', passenger_count: 2,
    type_id: suv.type_id, vehicle_id: suv.id, start_at: bkkLocal(12, 9), end_at: bkkLocal(12, 11) };

  const ok = await api('POST', '/api/bookings', form);
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.status, 'approved');
  assert.equal(ok.data.status_label, 'จองแล้ว');
  assert.deepEqual(ok.data.events.map((e) => e.action), ['create', 'confirm']);

  // วันเดียวกันแม้ต่างเวลา (บ่าย) ก็จองไม่ได้ และบอกวันที่ชน
  const sameDay = await api('POST', '/api/bookings', { ...form, start_at: bkkLocal(12, 13), end_at: bkkLocal(12, 16) }, USER2);
  assert.equal(sameDay.status, 409);
  assert.match(sameDay.data.conflicts[0].message, /มีการจองแล้ว วันที่/);
  assert.match(sameDay.data.conflicts[0].message, new RegExp(ok.data.code));

  // จองข้ามวัน (วันที่ 11 ถึง 12) ชนกับวันที่ 12 ด้วย
  assert.equal((await api('POST', '/api/bookings', { ...form, start_at: bkkLocal(11, 9), end_at: bkkLocal(12, 8) }, USER2)).status, 409);
  // วันถัดไปจองได้ / กลับเที่ยงคืนพอดีไม่ถือว่าเป็นวันถัดไป
  assert.equal((await api('POST', '/api/bookings', { ...form, start_at: bkkLocal(13, 8), end_at: bkkLocal(13, 17) }, USER2)).status, 201);
  assert.equal((await api('POST', '/api/bookings', { ...form, start_at: bkkLocal(11, 18), end_at: bkkLocal(12, 0) }, USER2)).status, 201);

  // ไม่ต้องอนุมัติแล้วต้องเลือกรถเสมอ
  const noCar = await api('POST', '/api/bookings', { ...form, vehicle_id: '', start_at: bkkLocal(20, 9), end_at: bkkLocal(20, 10) });
  assert.equal(noCar.status, 400);
  assert.match(noCar.data.error, /เลือกรถ/);
});

test('ตั้งค่าการจองได้เฉพาะผู้ดูแล และตรวจค่าที่ไม่ถูกต้อง', async () => {
  assert.equal((await api('PUT', '/api/settings', { require_approval: '1' }, USER)).status, 403);
  assert.equal((await api('PUT', '/api/settings', { conflict_mode: 'week' }, ADMIN)).status, 400);
});

test('โหมดอนุมัติ + ตรวจช่วงเวลา: จอง → กันจองซ้อน → อนุมัติ → บันทึกการใช้รถ → เสร็จสิ้น', async () => {
  await api('PUT', '/api/settings', { require_approval: '1', conflict_mode: 'time' }, ADMIN);
  const vehicles = (await api('GET', '/api/vehicles')).data;
  const van = vehicles.find((v) => v.plate.startsWith('ฮค'));
  const form = {
    requester_name: 'ผู้ทดสอบ', requester_position: 'นักทดสอบ', requester_department: 'ฝ่ายทดสอบ',
    purpose: 'ทดสอบระบบ', destination: 'ปลายทางทดสอบ', passenger_count: 3, type_id: van.type_id, vehicle_id: van.id,
    start_at: bkkLocal(10, 9), end_at: bkkLocal(10, 12),
  };
  const created = await api('POST', '/api/bookings', form);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.status, 'pending');
  assert.match(created.data.code, /^RQ-\d{4}-\d{4}$/);

  // จองทับช่วงเวลา (10:00–11:00) ต้องถูกปฏิเสธพร้อมเหตุผล
  const clash = await api('POST', '/api/bookings', { ...form, start_at: bkkLocal(10, 10), end_at: bkkLocal(10, 13) }, USER2);
  assert.equal(clash.status, 409);
  assert.equal(clash.data.conflicts[0].kind, 'booking');
  assert.match(clash.data.conflicts[0].message, new RegExp(created.data.code));

  // ช่วงที่ต่อกันพอดี (12:00–14:00) จองได้
  const adjacent = await api('POST', '/api/bookings', { ...form, start_at: bkkLocal(10, 12), end_at: bkkLocal(10, 14) }, USER2);
  assert.equal(adjacent.status, 201);

  // ผู้ใช้ทั่วไปอนุมัติไม่ได้ และดูคำขอของผู้อื่นไม่ได้
  assert.equal((await api('POST', `/api/bookings/${created.data.id}/approve`, {}, USER)).status, 403);
  assert.equal((await api('GET', `/api/bookings/${created.data.id}`, null, USER2)).status, 403);

  // ไม่อนุมัติต้องมีเหตุผล
  assert.equal((await api('POST', `/api/bookings/${adjacent.data.id}/reject`, { reason: '' }, ADMIN)).status, 400);
  const rej = await api('POST', `/api/bookings/${adjacent.data.id}/reject`, { reason: 'รถไม่พอ' }, ADMIN);
  assert.equal(rej.data.status, 'rejected');
  assert.equal(rej.data.decision_note, 'รถไม่พอ');

  const appr = await api('POST', `/api/bookings/${created.data.id}/approve`, { note: 'อนุมัติ' }, ADMIN);
  assert.equal(appr.status, 200);
  assert.equal(appr.data.status, 'approved');

  // ช่วงเวลาที่ถูกจองแสดงสถานะ "ถูกจอง"
  const inRange = (await api('GET', `/api/vehicles?from=${encodeURIComponent(form.start_at)}&to=${encodeURIComponent(form.end_at)}`)).data;
  assert.equal(inRange.find((v) => v.id === van.id).state, 'booked');

  // บันทึกขากลับโดยไม่บันทึกขาออก → ผิด ; เลขไมล์กลับน้อยกว่าออก → ผิด
  const tripUrl = `/api/bookings/${created.data.id}/trip`;
  assert.equal((await api('PUT', tripUrl, { return_at: bkkLocal(0, 0), return_mileage: 10 }, ADMIN)).status, 400);
  const depart = new Date(Date.now() - 3 * 3600e3).toISOString();
  const ret = new Date(Date.now() - 3600e3).toISOString();
  assert.equal((await api('PUT', tripUrl, { depart_at: depart, depart_mileage: 1000, return_at: ret, return_mileage: 900 }, ADMIN)).status, 400);

  const trip = await api('PUT', tripUrl, { driver_name: 'คนขับทดสอบ', depart_at: depart, depart_mileage: 88050, return_at: ret, return_mileage: 88175 }, ADMIN);
  assert.equal(trip.status, 200, JSON.stringify(trip.data));
  assert.equal(trip.data.status, 'completed');
  assert.equal(trip.data.distance, 125);
  assert.equal((await api('GET', `/api/vehicles/${van.id}`)).data.mileage, 88175);

  // ผู้ขอดูคำขอของตนได้ และเห็นประวัติการดำเนินการ
  const mine = await api('GET', `/api/bookings/${created.data.id}`, null, USER);
  assert.deepEqual(mine.data.events.map((e) => e.action), ['create', 'approve', 'trip']);

  // คำขอแบบไม่ระบุรถ (ให้ผู้ดูแลจัด) ใช้ได้ในโหมดอนุมัติ แต่อนุมัติโดยไม่เลือกรถไม่ได้
  const noCar = await api('POST', '/api/bookings', { ...form, vehicle_id: '', start_at: bkkLocal(15, 9), end_at: bkkLocal(15, 10) });
  assert.equal(noCar.data.status, 'pending');
  assert.equal((await api('POST', `/api/bookings/${noCar.data.id}/approve`, {}, ADMIN)).status, 400);
  await api('PUT', '/api/settings', { require_approval: '0', conflict_mode: 'day' }, ADMIN);
});

test('รถที่ซ่อมบำรุงหรือปิดใช้งานจองไม่ได้ และแจ้งสาเหตุ', async () => {
  const vehicles = (await api('GET', '/api/vehicles')).data;
  const pickup = vehicles.find((v) => v.state_reason === 'maintenance');
  const r = await api('POST', '/api/availability', { vehicle_id: pickup.id, start_at: bkkLocal(1, 9), end_at: bkkLocal(1, 10) });
  assert.equal(r.data.available, false);
  assert.equal(r.data.conflicts[0].kind, 'maintenance');

  const inactive = vehicles.find((v) => !v.active);
  const r2 = await api('POST', '/api/availability', { vehicle_id: inactive.id, start_at: bkkLocal(20, 9), end_at: bkkLocal(20, 10) });
  assert.equal(r2.data.conflicts[0].kind, 'inactive');
});

test('จำนวนผู้โดยสารเกินที่นั่ง / จองย้อนหลัง / เวลากลับก่อนออก ถูกปฏิเสธ', async () => {
  const vehicles = (await api('GET', '/api/vehicles')).data;
  const sedan = vehicles.find((v) => v.plate.startsWith('กข'));
  const base = { requester_department: 'ฝ่าย', purpose: 'x', destination: 'y', type_id: sedan.type_id, vehicle_id: sedan.id };
  assert.equal((await api('POST', '/api/bookings', { ...base, passenger_count: 9, start_at: bkkLocal(30, 9), end_at: bkkLocal(30, 10) })).status, 400);
  assert.equal((await api('POST', '/api/bookings', { ...base, passenger_count: 1, start_at: bkkLocal(-2, 9), end_at: bkkLocal(-2, 10) })).status, 400);
  const bad = await api('POST', '/api/bookings', { ...base, passenger_count: 1, start_at: bkkLocal(30, 10), end_at: bkkLocal(30, 9) });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /หลัง/);
});

test('ยกเลิกได้เฉพาะคำขอของตนเอง ต้องระบุเหตุผล และยกเลิกแล้ววันนั้นว่างอีกครั้ง', async () => {
  const sedan = (await api('GET', '/api/vehicles')).data.find((v) => v.plate.startsWith('กข'));
  const form = { requester_department: 'ฝ่าย', purpose: 'x', destination: 'y', passenger_count: 1,
    type_id: sedan.type_id, vehicle_id: sedan.id, start_at: bkkLocal(25, 9), end_at: bkkLocal(25, 10) };
  const b = (await api('POST', '/api/bookings', form)).data;
  assert.equal((await api('POST', `/api/bookings/${b.id}/cancel`, { reason: 'x' }, USER2)).status, 403);
  assert.equal((await api('POST', `/api/bookings/${b.id}/cancel`, { reason: '' }, USER)).status, 400);
  const c = await api('POST', `/api/bookings/${b.id}/cancel`, { reason: 'ไม่ไปแล้ว' }, USER);
  assert.equal(c.data.status, 'cancelled');
  assert.equal((await api('POST', '/api/bookings', { ...form, start_at: bkkLocal(25, 14), end_at: bkkLocal(25, 15) }, USER2)).status, 201);
});

test('ปฏิทิน: ผู้ใช้ทั่วไปไม่เห็นรายละเอียดคำขอของผู้อื่น', async () => {
  const from = bkkLocal(-7, 0), to = bkkLocal(14, 0);
  const r = await api('GET', `/api/schedule?from=${from}&to=${to}`, null, USER);
  const others = r.data.bookings.filter((b) => !b.can_view);
  assert.ok(others.length > 0);
  assert.ok(others.every((b) => b.requester_name === undefined && b.purpose === undefined));
});

test('ลบข้อมูลตัวอย่างได้เฉพาะผู้ดูแล', async () => {
  assert.equal((await api('POST', '/api/demo/clear', {}, USER)).status, 403);
  const r = await api('POST', '/api/demo/clear', {}, ADMIN);
  assert.equal(r.data.vehicles, 0);
  assert.equal(r.data.bookings, 0);
  const again = await api('POST', '/api/demo/reset', {}, ADMIN);
  assert.ok(again.data.vehicles > 0);
});

test('รายชื่อบุคลากร: ผู้ดูแลเพิ่ม/แก้/ลบได้ ผู้ใช้ทั่วไปอ่านได้อย่างเดียว', async () => {
  const meta = (await api('GET', '/api/meta')).data;
  assert.ok(meta.people.some((p) => p.is_driver), 'มีพนักงานขับรถตัวอย่าง');
  assert.ok(meta.people.some((p) => p.is_approver), 'มีผู้มีอำนาจตัวอย่าง');
  assert.ok(meta.presets.some((p) => p.kind === 'destination'));
  assert.equal((await api('POST', '/api/people', { name: 'x', is_driver: 1 }, USER)).status, 403);
  assert.equal((await api('POST', '/api/people', { name: 'นายทดสอบ' }, ADMIN)).status, 400, 'ต้องมีหน้าที่อย่างน้อย 1 อย่าง');
  const p = await api('POST', '/api/people', { name: 'นายทดสอบ ขับดี', phone: '080', is_staff: 0, is_driver: 1 }, ADMIN);
  assert.equal(p.status, 200);
  assert.equal(p.data.is_driver, 1);
  assert.equal((await api('POST', '/api/people', { name: 'นายทดสอบ ขับดี', is_driver: 1 }, ADMIN)).status, 409);
  const up = await api('PUT', `/api/people/${p.data.id}`, { name: 'นายทดสอบ ขับดี', is_driver: 1, is_responsible: 1, active: 0 }, ADMIN);
  assert.equal(up.data.is_responsible, 1);
  assert.equal(up.data.active, 0);
  assert.equal((await api('DELETE', `/api/people/${p.data.id}`, null, ADMIN)).status, 200);
});

test('รายการที่ใช้บ่อยและรูปแบบหน้าพิมพ์: ตรวจค่าและจำกัดช่วง', async () => {
  const pr = await api('POST', '/api/presets', { kind: 'purpose', text: 'ทดสอบวัตถุประสงค์' }, ADMIN);
  assert.equal(pr.status, 200);
  assert.equal((await api('POST', '/api/presets', { kind: 'other', text: 'x' }, ADMIN)).status, 400);
  assert.equal((await api('DELETE', `/api/presets/${pr.data.id}`, null, ADMIN)).status, 200);

  await api('PUT', '/api/settings', { print_layout: { fontSize: 99, splitLeft: 10, purposeLines: 4.6, autoFit: false, texts: { closing: 'ข้อความใหม่', bogus: 'x' } } }, ADMIN);
  const L = (await api('GET', '/api/meta')).data.print_layout;
  assert.equal(L.fontSize, 20, 'ตัดให้อยู่ในช่วงสูงสุด');
  assert.equal(L.splitLeft, 35, 'ตัดให้อยู่ในช่วงต่ำสุด');
  assert.equal(L.purposeLines, 5);
  assert.equal(L.autoFit, false);
  assert.equal(L.texts.closing, 'ข้อความใหม่');
  assert.equal(L.texts.bogus, undefined);
  assert.equal(L.texts.orderPermit, 'อนุญาต', 'ข้อความที่ไม่ได้ส่งมาใช้ค่าเริ่มต้น');
  assert.equal((await api('PUT', '/api/settings', { print_layout: {} }, USER)).status, 403);
  await api('PUT', '/api/settings', { print_layout: {} }, ADMIN);
});

test('เลขลำดับตามทะเบียนรถ: รันต่อเนื่องแยกตามคัน ตั้งเลขเริ่มต้นได้ และเปลี่ยนรถได้เลขใหม่', async () => {
  const types = (await api('GET', '/api/meta')).data.types;
  const t = types[0].id;
  const mk = async (plate, seq_start) => (await api('POST', '/api/vehicles', { plate, type_id: t, seats: 4, seq_start }, ADMIN)).data;
  const a = await mk('ทดสอบ 1001', 1);
  const b = await mk('ทดสอบ 1002', 58);
  assert.equal(b.next_seq, 58);
  const book = (vehicle_id, day) => api('POST', '/api/bookings', { requester_department: 'ฝ่าย', purpose: 'x', destination: 'y', passenger_count: 1,
    type_id: t, vehicle_id, start_at: bkkLocal(day, 9), end_at: bkkLocal(day, 10) }).then((r) => r.data);
  const a1 = await book(a.id, 40), a2 = await book(a.id, 41), b1 = await book(b.id, 40);
  assert.deepEqual([a1.vehicle_seq, a2.vehicle_seq, b1.vehicle_seq], [1, 2, 58]);
  // ยกเลิกแล้วเลขไม่ถูกนำกลับมาใช้
  await api('POST', `/api/bookings/${a2.id}/cancel`, { reason: 'x' });
  assert.equal((await book(a.id, 42)).vehicle_seq, 3);
  // ผู้ดูแลเปลี่ยนรถ → ได้เลขถัดไปของรถคันใหม่
  const a4 = await book(a.id, 44);
  assert.equal(a4.vehicle_seq, 4);
  const moved = await api('POST', `/api/bookings/${a4.id}/assign`, { vehicle_id: b.id }, ADMIN);
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.data.vehicle_seq, 59);
  assert.equal((await api('POST', '/api/vehicles', { plate: 'ทดสอบ 1003', type_id: t, seats: 4, seq_start: 0 }, ADMIN)).status, 400);
});

test('นำเข้าบุคลากรจาก Excel: หาแถวหัวตาราง ตรวจตัวอย่าง แล้วนำเข้าจริง', async () => {
  const data = fs.readFileSync(path.join(__dirname, 'fixtures', 'people.xlsx')).toString('base64');
  const body = { filename: 'people.xlsx', data, roles: { is_staff: true } };
  assert.equal((await api('POST', '/api/people/import', body, USER)).status, 403);
  assert.equal((await api('POST', '/api/people/import', { ...body, roles: {} }, ADMIN)).status, 400, 'ต้องเลือกหน้าที่');

  const pre = (await api('POST', '/api/people/import', body, ADMIN)).data;
  assert.equal(pre.headerRow, 3, 'ข้ามแถวหัวเรื่องด้านบน');
  assert.equal(pre.columns.full, 'ชื่อ-นามสกุล *');
  assert.deepEqual(pre.counts, { new: 3, update: 1, skip: 2 });
  assert.equal(pre.rows.find((r) => r.name === 'นาย ช่องว่าง เยอะ').position, 'พนักงานขับรถยนต์', 'ตัดช่องว่างเกิน');
  // ตรวจตัวอย่างยังไม่บันทึก
  assert.ok(!(await api('GET', '/api/meta')).data.people.some((p) => p.name === 'นายทดสอบ นำเข้าหนึ่ง'));

  const done = (await api('POST', '/api/people/import', { ...body, roles: { is_staff: true, is_driver: true }, commit: true }, ADMIN)).data;
  assert.equal(done.imported, 4);
  const people = (await api('GET', '/api/meta')).data.people;
  const one = people.find((p) => p.name === 'นายทดสอบ นำเข้าหนึ่ง');
  assert.equal(one.position, 'นักจัดการงานทั่วไป');
  assert.equal(one.is_driver, 1);
  const updated = people.find((p) => p.name === 'นางสาวกมลวรรณ ใจดี');
  assert.equal(updated.position, 'เจ้าพนักงานธุรการชำนาญงาน', 'ชื่อเดิมได้ตำแหน่งใหม่');
  assert.equal(updated.department, 'ฝ่ายบริหารทั่วไป', 'ไฟล์ไม่มีฝ่าย จึงคงค่าเดิม');

  // CSV ภาษาไทยแบบ ANSI (Windows-874) และไฟล์ที่ไม่รองรับ
  const ansi = Buffer.from([0xaa, 0xd7, 0xe8, 0xcd, 0x2c, 0xb5, 0xd3, 0xe1, 0xcb, 0xb9, 0xe8, 0xa7, 0x0d, 0x0a, 0xa1, 0x2c, 0xa2]); // "ชื่อ,ตำแหน่ง\r\nก,ข"
  const csv = (await api('POST', '/api/people/import', { filename: 'a.csv', data: ansi.toString('base64'), roles: { is_staff: true } }, ADMIN)).data;
  assert.deepEqual(csv.rows.map((r) => [r.name, r.position]), [['ก', 'ข']]);
  const bad = await api('POST', '/api/people/import', { filename: 'old.xls', data: Buffer.from('not excel').toString('base64'), roles: { is_staff: true } }, ADMIN);
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /\.xlsx/);
});

test('เปลี่ยนชื่อผู้ใช้/รหัสผ่านผู้ดูแล และออกจากระบบ', async () => {
  assert.equal((await api('PUT', '/api/account', { current_password: 'admin1234', new_password: 'x' }, USER)).status, 403);
  assert.equal((await api('PUT', '/api/account', { current_password: 'nope', new_password: 'newpass123' }, ADMIN)).status, 400);
  assert.equal((await api('PUT', '/api/account', { current_password: 'admin1234', new_password: 'short' }, ADMIN)).status, 400);
  const ok = await api('PUT', '/api/account', { current_password: 'admin1234', username: 'carboss', new_password: 'newpass123', display_name: 'หัวหน้างานยานพาหนะ' }, ADMIN);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.is_default, false);
  assert.equal((await login('admin', 'admin1234')).status, 401);
  assert.equal((await login('carboss', 'newpass123')).status, 200);
  // ออกจากระบบแล้ว cookie เดิมใช้ไม่ได้
  const r = await login('carboss', 'newpass123');
  const cookie = r.headers.get('set-cookie').split(';')[0];
  await fetch(base + '/api/logout', { method: 'POST', headers: { Cookie: cookie } });
  const after = await (await fetch(base + '/api/session', { headers: { Cookie: cookie } })).json();
  assert.equal(after.isAdmin, false);
});
