'use strict';
// ทดสอบ supabase/schema.sql ด้วย PGlite (PostgreSQL ใน Node) โดยจำลองส่วนที่ Supabase มีให้:
// role anon / authenticated และฟังก์ชัน auth.uid() (อ่านจาก request.jwt.claim.sub เหมือน Supabase)
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let db;
const ADMIN_ID = '11111111-1111-1111-1111-111111111111';
const NOT_ADMIN_ID = '22222222-2222-2222-2222-222222222222';
let vanId, sedanId, pickupId, offId, seqCarId;

// วันเวลาไทย +n วันจากวันนี้ เป็น ISO (เวลา hh:mm น.)
function bkkIso(dayOffset, hh, mm = 0) {
  const d = new Date(Date.now() + 7 * 3600e3 + dayOffset * 86400e3);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm) - 7 * 3600e3).toISOString();
}

async function as(who) {
  await db.exec('reset role');
  const sub = who === 'admin' ? ADMIN_ID : who === 'user' ? NOT_ADMIN_ID : '';
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [sub]);
  if (who === 'anon') await db.exec('set role anon');
  else if (who === 'admin' || who === 'user') await db.exec('set role authenticated');
}
async function rpc(who, sql, params = []) {
  await as(who);
  try { return (await db.query(sql, params)).rows[0]; } finally { await db.exec('reset role'); }
}
async function rpcErr(who, sql, params = []) {
  try { await rpc(who, sql, params); } catch (e) { return e; }
  throw new Error('ควรเกิด error แต่ไม่เกิด: ' + sql);
}
const create = (who, p) => rpc(who, 'select create_booking($1::jsonb) as r', [JSON.stringify(p)]).then((x) => x.r);
const form = (vehicle, day, h1 = 9, h2 = 12, extra = {}) => ({
  requester_name: 'นายทดสอบ ระบบ', requester_department: 'กลุ่มงานทดสอบ', purpose: 'ทดสอบ', destination: 'ศาลากลาง',
  passenger_count: 2, type_id: 3, vehicle_id: vehicle, start_at: bkkIso(day, h1), end_at: bkkIso(day, h2), ...extra,
});

before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant usage on schema public to anon, authenticated;
  `);
  await db.exec(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8'));
  // รันซ้ำได้ (ไม่ error และไม่ซ้ำข้อมูลเริ่มต้น)
  await db.exec(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8'));
  await db.query("insert into admin_users(user_id, display_name) values ($1, 'หัวหน้างานยานพาหนะ')", [ADMIN_ID]);
  const ins = async (plate, type, seats, extra = '') => (await db.query(
    `insert into vehicles(plate, type_id, seats, driver_name ${extra ? ', ' + extra.split('=')[0] : ''}) values ($1, $2, $3, 'นายขับ ดี' ${extra ? ', ' + extra.split('=')[1] : ''}) returning id`,
    [plate, type, seats])).rows[0].id;
  vanId = await ins('นข 5678 เชียงใหม่', 3, 12);
  sedanId = await ins('กข 1234 เชียงใหม่', 1, 4);
  pickupId = await ins('บต 3456 เชียงใหม่', 2, 5);
  offId = await ins('ศษ 2468 เชียงใหม่', 1, 4, 'active=false');
  seqCarId = await ins('ทด 9999 เชียงใหม่', 1, 4, 'seq_start=58');
  await db.query("insert into maintenance(vehicle_id, start_at, end_at, description) values ($1, now() - interval '1 day', now() + interval '2 days', 'เปลี่ยนยาง')", [pickupId]);
  await db.query("insert into people(name, position, phone, is_staff) values ('นางสาวบุคลากร ตัวอย่าง', 'เจ้าพนักงานธุรการ', '081-111-1111', true)");
});

test('ค่าเริ่มต้นจาก schema: ประเภทรถ 4 แบบตามแบบฟอร์ม และไม่ต้องอนุมัติ/ตรวจรายวัน', async () => {
  const types = (await db.query('select name from vehicle_types order by sort_order')).rows.map((r) => r.name);
  assert.deepEqual(types, ['รถเก๋ง', 'รถกระบะ', 'รถตู้', 'รถจักรยานยนต์']);
  const s = Object.fromEntries((await db.query("select key, value from settings where key in ('require_approval','conflict_mode','form_code')")).rows.map((r) => [r.key, r.value]));
  assert.deepEqual(s, { require_approval: '0', conflict_mode: 'day', form_code: 'แบบ ๔' });
});

test('ผู้ไม่ได้ล็อกอินจอง: ยืนยันทันที ได้รหัสลับและเลขที่ตามทะเบียน / วันเดียวกันต่างเวลาจองไม่ได้', async () => {
  const b = await create('anon', form(vanId, 10));
  assert.equal(b.status, 'approved');
  assert.equal(b.status_label, 'จองแล้ว');
  assert.match(b.code, /^RQ-\d{4}-\d{4}$/);
  assert.match(b.owner_token, /^[a-f0-9]{32}$/);
  assert.equal(b.vehicle_seq, 1);
  assert.equal(b.assigned_driver, 'นายขับ ดี');
  assert.deepEqual(b.events.map((e) => e.action), ['create', 'confirm']);
  assert.equal(b.events[0].user_name, 'นายทดสอบ ระบบ');

  const e = await rpcErr('anon', 'select create_booking($1::jsonb)', [JSON.stringify(form(vanId, 10, 14, 16))]);
  assert.equal(e.code, 'PT409');
  const conflicts = JSON.parse(e.detail);
  assert.equal(conflicts[0].kind, 'booking');
  assert.match(conflicts[0].message, /รถคันนี้มีการจองแล้ว วันที่ \d+ [ก-๙.]+ \d{4} \(RQ-/);

  assert.equal((await create('anon', form(vanId, 11))).vehicle_seq, 2, 'วันถัดไปจองได้ เลขที่รันต่อ');
  assert.equal((await create('anon', form(seqCarId, 10))).vehicle_seq, 58, 'ใช้เลขเริ่มต้นของรถ');
});

test('ตรวจข้อมูลจอง: ย้อนหลัง ที่นั่งเกิน ไม่เลือกรถ รถซ่อม/ปิดใช้งาน', async () => {
  assert.equal((await rpcErr('anon', 'select create_booking($1::jsonb)', [JSON.stringify(form(sedanId, -2))])).message, 'ไม่สามารถจองย้อนหลังได้ กรุณาเลือกเวลาออกเดินทางในอนาคต');
  assert.match((await rpcErr('anon', 'select create_booking($1::jsonb)', [JSON.stringify(form(sedanId, 20, 9, 10, { passenger_count: 9 }))])).message, /เกินจำนวนที่นั่ง/);
  assert.equal((await rpcErr('anon', 'select create_booking($1::jsonb)', [JSON.stringify(form(null, 20))])).message, 'กรุณาเลือกรถที่ต้องการจอง');
  assert.equal((await rpcErr('anon', 'select create_booking($1::jsonb)', [JSON.stringify(form(sedanId, 20, 12, 9))])).code, 'PT400');
  const m = (await rpc('anon', 'select check_availability($1, $2, $3) as r', [pickupId, bkkIso(1, 9), bkkIso(1, 10)])).r;
  assert.equal(m.available, false);
  assert.equal(m.conflicts[0].kind, 'maintenance');
  const off = (await rpc('anon', 'select check_availability($1, $2, $3) as r', [offId, bkkIso(30, 9), bkkIso(30, 10)])).r;
  assert.equal(off.conflicts[0].kind, 'inactive');
});

test('สิทธิ์: ผู้ไม่ได้ล็อกอินอ่านตารางการจอง/บุคลากรตรงไม่ได้ เห็นเฉพาะการจองที่ถือรหัสลับ', async () => {
  const mine = await create('anon', form(sedanId, 12));
  await assert.rejects(rpc('anon', 'select * from bookings'), /permission denied/);
  await assert.rejects(rpc('anon', 'select * from people'), /permission denied/);
  await assert.rejects(rpc('anon', "update vehicles set plate = 'x'"), /permission denied/);
  const pub = await rpc('anon', 'select count(*)::int as n, max(phone) as phone from people_public');
  assert.equal(pub.n, 1);
  assert.equal(pub.phone, '', 'ไม่เปิดเผยเบอร์โทร');

  assert.equal((await rpc('anon', 'select get_booking($1, $2) as r', [mine.id, [mine.owner_token]])).r.code, mine.code);
  assert.equal((await rpcErr('anon', 'select get_booking($1, $2)', [mine.id, ['0'.repeat(32)]])).code, 'PT403');
  assert.equal((await rpc('anon', 'select get_bookings($1) as r', [[]])).r.length, 0);
  assert.deepEqual((await rpc('anon', 'select get_bookings($1) as r', [[mine.owner_token]])).r.map((x) => x.code), [mine.code]);
});

test('ผู้ดูแลเท่านั้น: ผู้ใช้ Auth ที่ไม่อยู่ใน admin_users ทำงานผู้ดูแลไม่ได้', async () => {
  const b = await create('anon', form(sedanId, 14));
  assert.equal((await rpcErr('user', 'select complete_booking($1)', [b.id])).code, 'PT403');
  assert.equal((await rpcErr('anon', 'select clear_demo()')).code, 'PT403');
  assert.equal((await rpc('user', 'select count(*)::int as n from bookings')).n, 0, 'RLS: ไม่ใช่ผู้ดูแลเห็น 0 แถว');
  assert.ok((await rpc('admin', 'select count(*)::int as n from bookings')).n > 0);
  assert.equal((await rpc('admin', 'select get_booking($1) as r', [b.id])).r.code, b.code);
});

test('ยกเลิก: ต้องถือรหัสลับและระบุเหตุผล แล้ววันนั้นว่างอีกครั้ง', async () => {
  const b = await create('anon', form(sedanId, 25));
  assert.equal((await rpcErr('anon', 'select cancel_booking($1, $2, $3)', [b.id, 'x', []])).code, 'PT403');
  assert.equal((await rpcErr('anon', 'select cancel_booking($1, $2, $3)', [b.id, '', [b.owner_token]])).code, 'PT400');
  const c = (await rpc('anon', 'select cancel_booking($1, $2, $3) as r', [b.id, 'เลื่อนประชุม', [b.owner_token]])).r;
  assert.equal(c.status, 'cancelled');
  assert.equal(c.events.at(-1).user_name, 'นายทดสอบ ระบบ');
  assert.equal((await create('anon', form(sedanId, 25, 13, 15))).status, 'approved');
});

test('ปฏิทิน: การจองของผู้อื่นแสดงเฉพาะช่วงเวลาและหน่วยงาน', async () => {
  const s = (await rpc('anon', 'select get_schedule($1, $2, $3) as r', [bkkIso(9, 0), bkkIso(13, 0), []])).r;
  assert.ok(s.bookings.length > 0);
  assert.ok(s.bookings.every((b) => !b.can_view && b.requester_name === undefined && b.id === null));
  assert.ok(s.vehicles.length >= 5);
});

test('สถานะรถ: ซ่อมบำรุง/ปิดใช้งาน/ถูกจอง/ว่าง', async () => {
  const st = (await rpc('anon', 'select vehicle_states() as r')).r;
  const by = Object.fromEntries(st.map((v) => [v.plate, v]));
  assert.equal(by['บต 3456 เชียงใหม่'].state, 'unavailable');
  assert.equal(by['บต 3456 เชียงใหม่'].state_reason, 'maintenance');
  assert.equal(by['ศษ 2468 เชียงใหม่'].state_reason, 'inactive');
  assert.equal(by['นข 5678 เชียงใหม่'].state, 'available');
  assert.ok(by['นข 5678 เชียงใหม่'].next_booking.code.startsWith('RQ-'));
  const day10 = (await rpc('anon', 'select vehicle_states($1, $2) as r', [bkkIso(10, 0), bkkIso(11, 0)])).r;
  assert.equal(day10.find((v) => v.id === vanId).state, 'booked');
});

test('โหมดอนุมัติ + ตรวจช่วงเวลา: รออนุมัติ → อนุมัติ → บันทึกการใช้รถ → เสร็จสิ้น', async () => {
  await db.exec("update settings set value = '1' where key = 'require_approval'; update settings set value = 'time' where key = 'conflict_mode';");
  try {
    const p = await create('anon', form(null, 40, 9, 12));
    assert.equal(p.status, 'pending');
    assert.equal(p.vehicle_id, null);
    assert.equal((await rpcErr('admin', 'select approve_booking($1)', [p.id])).message, 'กรุณาเลือกรถก่อนอนุมัติ');
    const a = (await rpc('admin', 'select approve_booking($1, $2, $3, $4) as r', [p.id, vanId, null, 'อนุมัติ'])).r;
    assert.equal(a.status, 'approved');
    assert.equal(a.status_label, 'อนุมัติ');
    assert.equal(a.decided_by, 1);
    assert.equal(a.decided_by_name, 'หัวหน้างานยานพาหนะ');
    assert.equal(a.vehicle_seq, 3);
    // โหมดช่วงเวลา: วันเดียวกันเวลาต่อกันพอดีจองได้ ทับกันไม่ได้
    assert.equal((await create('anon', form(vanId, 40, 12, 14))).status, 'pending');
    assert.equal((await rpcErr('anon', 'select create_booking($1::jsonb)', [JSON.stringify(form(vanId, 40, 11, 13))])).code, 'PT409');
    const r = await rpcErr('admin', 'select reject_booking($1, $2)', [a.id, '']);
    assert.equal(r.code, 'PT400');

    const dep = new Date(Date.now() - 3 * 3600e3).toISOString(), ret = new Date(Date.now() - 3600e3).toISOString();
    assert.match((await rpcErr('admin', 'select save_trip($1, $2::jsonb)', [a.id, JSON.stringify({ return_at: ret, return_mileage: 10 })])).message, /ขาออกก่อน/);
    assert.match((await rpcErr('admin', 'select save_trip($1, $2::jsonb)', [a.id, JSON.stringify({ depart_at: dep, depart_mileage: 1000, return_at: ret, return_mileage: 900 })])).message, /ไม่น้อยกว่า/);
    const t = (await rpc('admin', 'select save_trip($1, $2::jsonb) as r', [a.id, JSON.stringify({ driver_name: 'นายขับ ดี', depart_at: dep, depart_mileage: 120000, return_at: ret, return_mileage: 120087 })])).r;
    assert.equal(t.status, 'completed');
    assert.equal(t.distance, 87);
    assert.equal(t.events.at(-1).note, 'บันทึกขากลับ ระยะทางรวม 87 กม.');
    assert.equal((await db.query('select mileage from vehicles where id = $1', [vanId])).rows[0].mileage, 120087);
    const counts = (await rpc('admin', 'select dashboard_counts() as r')).r;
    assert.equal(counts.pending, 1);
  } finally {
    await db.exec("update settings set value = '0' where key = 'require_approval'; update settings set value = 'day' where key = 'conflict_mode';");
  }
});

test('เปลี่ยนรถ: ได้เลขที่ถัดไปของรถคันใหม่', async () => {
  const b = await create('anon', form(sedanId, 50));
  const moved = (await rpc('admin', 'select assign_vehicle($1, $2, $3) as r', [b.id, seqCarId, ''])).r;
  assert.equal(moved.vehicle_seq, 59);
  assert.equal(moved.plate, 'ทด 9999 เชียงใหม่');
});
