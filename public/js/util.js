// ฟังก์ชันใช้ร่วมกันระหว่างหน้าแอปและหน้าพิมพ์
export const TZ = 'Asia/Bangkok';
const OFFSET = 7 * 3600e3; // ประเทศไทยไม่มีเวลาออมแสง ใช้ +07:00 ตลอดปี

// ---------- รหัสลับการจองที่ทำจากเครื่องนี้ (ใช้ดู/ยกเลิก/พิมพ์การจองของตนโดยไม่ต้องล็อกอิน) ----------
const TOKEN_KEY = 'vb.bookingTokens';
export function getTokens() { try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || '[]').filter((t) => /^[a-f0-9]{32}$/.test(t)); } catch { return []; } }
export function addToken(t) {
  if (!t) return;
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify([...getTokens().filter((x) => x !== t), t].slice(-400))); } catch { /* ไม่มี storage */ }
}
const REQ_KEY = 'vb.lastRequester';
export function getLastRequester() { try { return JSON.parse(localStorage.getItem(REQ_KEY) || 'null'); } catch { return null; } }
export function setLastRequester(r) { try { localStorage.setItem(REQ_KEY, JSON.stringify(r)); } catch { /* ไม่มี storage */ } }

export class ApiError extends Error {
  constructor(status, data) { super(data?.error || 'เกิดข้อผิดพลาด'); this.status = status; this.data = data || {}; }
}

/** โหมด Supabase เมื่อ config.js มี supabaseUrl (เช่นบน GitHub Pages) ไม่งั้นใช้เซิร์ฟเวอร์ Node */
export const SUPABASE_MODE = !!(globalThis.APP_CONFIG && globalThis.APP_CONFIG.supabaseUrl);

export async function api(method, url, body) {
  if (SUPABASE_MODE) {
    const { sbApi } = await import('./supabase-api.js');
    return sbApi(method, url, body);
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Booking-Tokens': getTokens().join(',') },
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, { error: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบว่าเปิดโปรแกรม (npm start) อยู่' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// ---------- วันเวลา (แสดงผลเป็นเวลาไทย ปีพุทธศักราช) ----------
const fmt = (opts) => new Intl.DateTimeFormat('th-TH', { timeZone: TZ, ...opts });
const F = {
  dt: fmt({ day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
  d: fmt({ day: 'numeric', month: 'short', year: 'numeric' }),
  dl: fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
  dshort: fmt({ weekday: 'short', day: 'numeric', month: 'short' }),
  t: fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
  month: fmt({ month: 'long' }),
};
export const fmtDateTime = (iso) => (iso ? `${F.dt.format(new Date(iso))} น.` : '-');
export const fmtDate = (iso) => (iso ? F.d.format(new Date(iso)) : '-');
export const fmtDateLong = (iso) => (iso ? F.dl.format(new Date(iso)) : '-');
export const fmtDayShort = (iso) => F.dshort.format(new Date(iso));
export const fmtTime = (iso) => (iso ? F.t.format(new Date(iso)) : '-');
export const fmtMonthName = (iso) => F.month.format(new Date(iso));
export const fmtMonthYear = (iso) => `${fmtMonthName(iso)} ${bkkParts(iso).y + 543}`;

/** ช่วงเวลาแบบย่อ: ถ้าวันเดียวกันแสดงวันครั้งเดียว */
export function fmtRange(a, b) {
  if (!a) return '-';
  const pa = bkkParts(a), pb = bkkParts(b);
  if (pa.y === pb.y && pa.m === pb.m && pa.d === pb.d) return `${fmtDate(a)} ${fmtTime(a)}–${fmtTime(b)} น.`;
  return `${fmtDateTime(a)} – ${fmtDateTime(b)}`;
}

export function bkkParts(iso) {
  const d = new Date(Date.parse(iso) + OFFSET);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), dow: d.getUTCDay() };
}
export function bkkIso(y, m, d, hh = 0, mm = 0) { return new Date(Date.UTC(y, m - 1, d, hh, mm) - OFFSET).toISOString(); }
/** เริ่มต้นวัน (00:00 เวลาไทย) ของวันที่ iso + offset วัน */
export function bkkDayStart(iso = new Date().toISOString(), offset = 0) {
  const p = bkkParts(iso); return bkkIso(p.y, p.m, p.d + offset);
}
/** ISO → ค่าสำหรับ <input type="datetime-local"> (เวลาไทย) */
export function toLocalInput(iso) {
  if (!iso) return '';
  const p = bkkParts(iso), z = (n) => String(n).padStart(2, '0');
  return `${p.y}-${z(p.m)}-${z(p.d)}T${z(p.hh)}:${z(p.mm)}`;
}
/** ค่าจาก <input type="datetime-local"> (ถือเป็นเวลาไทย) → ISO */
export function fromLocalInput(v) {
  if (!v) return '';
  const d = new Date(`${v.length === 16 ? v + ':00' : v}+07:00`);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}
export const thaiYear = (iso) => bkkParts(iso).y + 543;
export const num = (n) => (n === null || n === undefined || n === '' ? '-' : Number(n).toLocaleString('th-TH'));

// ---------- HTML ----------
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const BOOKING_STATUS = {
  pending: 'รออนุมัติ', approved: 'อนุมัติ', rejected: 'ไม่อนุมัติ', cancelled: 'ยกเลิก', completed: 'เสร็จสิ้น',
};
export const VEHICLE_STATE = { available: 'ว่าง', booked: 'ถูกจอง', in_use: 'กำลังใช้งาน', unavailable: 'ไม่พร้อมใช้งาน' };
export const EVENT_LABEL = {
  create: 'ยื่นคำขอ', confirm: 'ยืนยันการจอง', assign: 'กำหนดรถ', approve: 'อนุมัติ', reject: 'ไม่อนุมัติ', cancel: 'ยกเลิก', complete: 'ปิดงาน', trip: 'บันทึกการใช้รถ',
};
