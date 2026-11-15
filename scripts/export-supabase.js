'use strict';
/**
 * ส่งออกข้อมูลจากฐานข้อมูลในเครื่อง (data/booking.db) เป็นไฟล์ SQL สำหรับนำเข้า Supabase
 * ใช้: npm run export-supabase   → ได้ไฟล์ data/supabase-import.sql
 * จากนั้น Supabase → SQL Editor → วางเนื้อหาไฟล์ → Run (รัน supabase/schema.sql ก่อน)
 *
 * - ใช้กับโปรเจกต์ Supabase ใหม่ที่ยังไม่มีรถ/การจอง (คงเลขลำดับ id เดิมเพื่อให้การจองอ้างถึงรถได้ถูกต้อง)
 * - ไม่ส่งออกบัญชีผู้ดูแล (ใน Supabase ใช้ Authentication แทน)
 * - ไฟล์ผลลัพธ์มีข้อมูลจริง อยู่ใน .gitignore อย่า push ขึ้น GitHub
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const src = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'booking.db');
const out = process.argv[2] || path.join(__dirname, '..', 'data', 'supabase-import.sql');
if (!fs.existsSync(src)) { console.error('ไม่พบฐานข้อมูล', src); process.exit(1); }
const db = new DatabaseSync(src, { readOnly: true });
const all = (sql) => db.prepare(sql).all();

const lit = (v) => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};
const bool = (v) => (v ? 'true' : 'false');
const userName = new Map(all('SELECT id, name FROM users').map((u) => [u.id, u.name]));
const adminIds = new Set(all("SELECT id FROM users WHERE role = 'admin'").map((u) => u.id));
const lines = [];
const insert = (table, rows, cols, map) => {
  if (!rows.length) return;
  lines.push(`-- ${table}: ${rows.length} แถว`);
  for (const r of rows) {
    const vals = map(r);
    lines.push(`insert into ${table}(${cols.join(', ')}) values (${vals.join(', ')});`);
  }
};

lines.push('-- ข้อมูลจากระบบจองรถในเครื่อง ส่งออกเมื่อ ' + new Date().toISOString());
lines.push('begin;');

// ประเภทรถ: จับคู่ตามชื่อ (schema สร้าง 4 ประเภทตามแบบฟอร์มไว้แล้ว)
for (const t of all('SELECT * FROM vehicle_types ORDER BY sort_order, id')) {
  lines.push(`insert into vehicle_types(name, sort_order, active) values (${lit(t.name)}, ${t.sort_order}, ${bool(t.active)}) on conflict (name) do update set sort_order = excluded.sort_order, active = excluded.active;`);
}
const typeRef = (id) => {
  const t = db.prepare('SELECT name FROM vehicle_types WHERE id = ?').get(id);
  return t ? `(select id from vehicle_types where name = ${lit(t.name)})` : 'null';
};

insert('vehicles', all('SELECT * FROM vehicles ORDER BY id'),
  ['id', 'plate', 'brand', 'model', 'type_id', 'seats', 'color', 'driver_name', 'driver_phone', 'mileage', 'seq_start', 'note', 'active', 'is_demo', 'created_at', 'updated_at'],
  (v) => [v.id, lit(v.plate), lit(v.brand), lit(v.model), typeRef(v.type_id), v.seats, lit(v.color), lit(v.driver_name), lit(v.driver_phone),
    lit(v.mileage), v.seq_start ?? 1, lit(v.note), bool(v.active), bool(v.is_demo), lit(v.created_at), lit(v.updated_at)]);

insert('maintenance', all('SELECT * FROM maintenance ORDER BY id'),
  ['id', 'vehicle_id', 'start_at', 'end_at', 'description', 'created_by', 'created_at', 'is_demo'],
  (m) => [m.id, m.vehicle_id, lit(m.start_at), lit(m.end_at), lit(m.description), lit(userName.get(m.created_by) || ''), lit(m.created_at), bool(m.is_demo)]);

insert('bookings', all('SELECT * FROM bookings ORDER BY id'),
  ['id', 'code', 'requester_name', 'requester_position', 'requester_department', 'requester_phone', 'purpose', 'destination', 'companions',
    'passenger_count', 'type_id', 'type_other', 'vehicle_id', 'vehicle_seq', 'need_driver', 'assigned_driver', 'start_at', 'end_at', 'note', 'status',
    'decision_note', 'approved_by_admin', 'decided_by_name', 'decided_at', 'cancel_reason', 'owner_token', 'created_at', 'updated_at', 'is_demo'],
  (b) => [b.id, lit(b.code), lit(b.requester_name), lit(b.requester_position), lit(b.requester_department), lit(b.requester_phone), lit(b.purpose),
    lit(b.destination), lit(b.companions), b.passenger_count, b.type_id ? typeRef(b.type_id) : 'null', lit(b.type_other), lit(b.vehicle_id), lit(b.vehicle_seq),
    bool(b.need_driver), lit(b.assigned_driver), lit(b.start_at), lit(b.end_at), lit(b.note), lit(b.status), lit(b.decision_note),
    bool(b.decided_by && adminIds.has(b.decided_by) && ['approved', 'completed'].includes(b.status)),
    lit(b.decided_by ? userName.get(b.decided_by) || '' : ''), lit(b.decided_at), lit(b.cancel_reason), lit(b.owner_token), lit(b.created_at), lit(b.updated_at), bool(b.is_demo)]);

insert('trip_logs', all('SELECT * FROM trip_logs ORDER BY booking_id'),
  ['booking_id', 'vehicle_id', 'driver_name', 'depart_at', 'depart_mileage', 'return_at', 'return_mileage', 'note', 'recorded_by', 'updated_at'],
  (t) => [t.booking_id, lit(t.vehicle_id), lit(t.driver_name), lit(t.depart_at), lit(t.depart_mileage), lit(t.return_at), lit(t.return_mileage), lit(t.note),
    lit(userName.get(t.recorded_by) || ''), lit(t.updated_at)]);

insert('booking_events', all('SELECT * FROM booking_events ORDER BY id'),
  ['id', 'booking_id', 'at', 'user_name', 'action', 'note'],
  (e) => [e.id, e.booking_id, lit(e.at), lit(e.user_name), lit(e.action), lit(e.note)]);

insert('people', all('SELECT * FROM people ORDER BY id'),
  ['id', 'name', 'position', 'department', 'phone', 'is_staff', 'is_driver', 'is_responsible', 'is_approver', 'active', 'sort_order', 'is_demo'],
  (p) => [p.id, lit(p.name), lit(p.position), lit(p.department), lit(p.phone), bool(p.is_staff), bool(p.is_driver), bool(p.is_responsible),
    bool(p.is_approver), bool(p.active), p.sort_order, bool(p.is_demo)]);

insert('presets', all('SELECT * FROM presets ORDER BY id'),
  ['id', 'kind', 'text', 'sort_order', 'is_demo'], (p) => [p.id, lit(p.kind), lit(p.text), p.sort_order, bool(p.is_demo)]);

for (const s of all('SELECT key, value FROM settings')) {
  lines.push(`insert into settings(key, value) values (${lit(s.key)}, ${lit(s.value)}) on conflict (key) do update set value = excluded.value;`);
}

// ให้เลข id ถัดไปต่อจากข้อมูลที่นำเข้า
for (const t of ['vehicles', 'maintenance', 'bookings', 'booking_events', 'people', 'presets']) {
  lines.push(`select setval(pg_get_serial_sequence('${t}', 'id'), greatest((select max(id) from ${t}), 1));`);
}
lines.push('commit;');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n') + '\n');
const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
console.log(`ส่งออกแล้ว: ${out}`);
console.log(`รถ ${count('vehicles')} คัน · การจอง ${count('bookings')} รายการ · บุคลากร ${count('people')} คน · รายการที่ใช้บ่อย ${count('presets')} รายการ`);
console.log('ไฟล์นี้มีข้อมูลจริง อย่า push ขึ้น GitHub (อยู่ใน .gitignore แล้ว)');
