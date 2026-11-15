'use strict';
// เวลาทั้งหมดในฐานข้อมูลเก็บเป็น ISO-8601 UTC (เช่น 2026-11-08T02:00:00.000Z)
// การแสดงผลและการตีความค่าที่ผู้ใช้กรอกใช้เขตเวลา Asia/Bangkok (UTC+7 ไม่มีเวลาออมแสง)

const TZ = 'Asia/Bangkok';
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** แปลงค่าเวลาใด ๆ ให้เป็น ISO UTC มาตรฐาน หรือคืน null ถ้าไม่ถูกต้อง */
function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  let v = String(value).trim();
  // ค่าจาก <input type="datetime-local"> ไม่มีเขตเวลา → ถือเป็นเวลาไทย
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v)) v += (v.length === 16 ? ':00' : '') + '+07:00';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** ช่วงเวลา [aStart, aEnd) กับ [bStart, bEnd) ทับซ้อนกันหรือไม่ (bEnd = null หมายถึงไม่มีกำหนดสิ้นสุด) */
function overlaps(aStart, aEnd, bStart, bEnd) {
  const as = Date.parse(aStart), ae = Date.parse(aEnd), bs = Date.parse(bStart);
  const be = bEnd ? Date.parse(bEnd) : Infinity;
  return as < be && ae > bs;
}

/** ส่วนประกอบวันเวลาตามเวลาไทย */
function bkkParts(iso) {
  const d = new Date(Date.parse(iso) + BKK_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
}

/** สร้าง ISO จากวันเวลาไทย */
function bkkToIso(y, m, d, hh = 0, mm = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - BKK_OFFSET_MS).toISOString();
}

/** ขยายช่วงเวลาให้ครอบคลุมทั้งวัน (00:00 ของวันแรก ถึง 00:00 ของวันถัดจากวันสุดท้าย) ตามเวลาไทย */
function expandToDays(start, end) {
  const s = bkkParts(start);
  const e = bkkParts(new Date(Date.parse(end) - 1).toISOString()); // กลับเวลา 00:00 พอดี = ยังเป็นวันก่อนหน้า
  return { start: bkkToIso(s.y, s.m, s.d), end: bkkToIso(e.y, e.m, e.d + 1) };
}

function formatThaiDate(iso) {
  return new Intl.DateTimeFormat('th-TH', { timeZone: TZ, dateStyle: 'medium' }).format(new Date(iso));
}

function formatThai(iso) {
  if (!iso) return '-';
  return new Intl.DateTimeFormat('th-TH', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

module.exports = { TZ, toIso, overlaps, bkkParts, bkkToIso, expandToDays, formatThai, formatThaiDate };
