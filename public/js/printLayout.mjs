// รูปแบบหน้าพิมพ์ — ใช้ร่วมกันทั้งเซิร์ฟเวอร์ Node (lib/printLayout.js) และหน้าเว็บโหมด Supabase
// รูปแบบหน้าพิมพ์ใบขออนุญาตใช้รถ ที่ผู้ดูแลปรับได้ (เก็บเป็น JSON ใน settings.print_layout)

export const DEFAULT_LAYOUT = {
  fontSize: 13.5,          // ขนาดตัวอักษร (pt)
  autoFit: true,           // ย่อตัวอักษรอัตโนมัติให้พอดี 1 หน้า
  minFontSize: 11,         // ย่อได้ต่ำสุด (pt)
  lineHeight: 1.6,         // ระยะห่างบรรทัด (เท่าของขนาดตัวอักษร)
  marginTop: 14, marginRight: 15, marginBottom: 10, marginLeft: 20, // ระยะขอบกระดาษ (มม.)
  splitLeft: 57,           // ความกว้างคอลัมน์ซ้ายของส่วนเจ้าหน้าที่/คำสั่ง (%)
  indent: 25,              // ย่อหน้า "ข้าพเจ้า" และ "จึงเรียนมา..." (มม.)
  purposeLines: 3,         // จำนวนบรรทัดของ "เพื่อ" อย่างน้อย
  signGap: 3,              // ระยะเว้นก่อนช่องลงนาม (มม.)
  showCompanionNames: true,  // ต่อท้ายวัตถุประสงค์ด้วยรายชื่อผู้ร่วมเดินทาง
  showOfficerSection: true,  // แสดงส่วนเจ้าหน้าที่ผู้รับผิดชอบ/คำสั่ง
  showTripSection: true,     // แสดงส่วนบันทึกการใช้รถ
  showRef: true,             // แสดงเลขอ้างอิงการจองมุมล่าง
  printSignerNames: true,    // พิมพ์ชื่อผู้ลงนามที่เลือกไว้ในวงเล็บ
  responsibleId: 0,          // เจ้าหน้าที่ผู้รับผิดชอบ: 0 = พนักงานขับรถ, -1 = เว้นว่าง, อื่น ๆ = people.id
  approverId: 0,             // ผู้มีอำนาจ: 0 = ผู้อำนวยการ (หาจากตำแหน่ง), -1 = เว้นว่าง, อื่น ๆ = people.id
  texts: {
    // เลขลำดับใต้รหัสแบบฟอร์ม: {n}=ลำดับ {thn}=ลำดับเลขไทย {short}=ทะเบียนย่อ {plate}=ทะเบียนเต็ม (เว้นว่าง = ไม่แสดง)
    seqFormat: 'เลขที่ {short} {n}',
    requestLine: 'ขออนุญาตใช้รถสำนักงาน',
    destination: 'เดินทางไปปฏิบัติงานที่',
    purpose: 'เพื่อ',
    closing: 'จึงเรียนมาเพื่อโปรดพิจารณาอนุญาต',
    requesterTitle: 'ผู้ขออนุญาต',
    officerOpt1: 'เห็นควรอนุมัติให้ใช้รถหมายเลขทะเบียน',
    officerAssign: 'มอบให้',
    officerDriver: 'เป็นผู้ขับขี่',
    officerOpt2: 'เนื่องจากในวันและเวลาดังกล่าวพนักงานขับรถยนต์ติดภารกิจ เห็นควรแจ้งให้ผู้ขออนุญาตใช้รถสำนักงานทราบ เพื่อดำเนินการในส่วนที่เกี่ยวข้องต่อไป',
    officerClosing: 'จึงเรียนมาเพื่อโปรดพิจารณา',
    orderPermit: 'อนุญาต',
    orderDeny: 'ไม่อนุญาต',
    orderUnable: 'ไม่สามารถดำเนินการตามคำขอได้',
    orderUnableReason: 'เนื่องจากรถส่วนกลางติดภารกิจ',
    orderOther: 'อื่นๆ',
    driverTitle: 'พนักงานขับรถยนต์',
  },
};

const RANGES = {
  fontSize: [9, 20], minFontSize: [8, 18], lineHeight: [1.2, 2.4],
  marginTop: [0, 40], marginRight: [0, 40], marginBottom: [0, 40], marginLeft: [0, 40],
  splitLeft: [35, 70], indent: [0, 50], purposeLines: [1, 8], signGap: [0, 20],
  responsibleId: [-1, 1e9], approverId: [-1, 1e9],
};
const INTS = new Set(['purposeLines', 'responsibleId', 'approverId']);

/** รวมกับค่าเริ่มต้น ตัดค่าที่ผิดช่วง และคืนเฉพาะคีย์ที่รู้จัก */
export function sanitizeLayout(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = { ...DEFAULT_LAYOUT, texts: { ...DEFAULT_LAYOUT.texts } };
  for (const [k, def] of Object.entries(DEFAULT_LAYOUT)) {
    if (k === 'texts' || !(k in src)) continue;
    if (typeof def === 'boolean') out[k] = src[k] === true || src[k] === 'true' || src[k] === 1;
    else if (typeof def === 'number') {
      let n = Number(src[k]);
      if (!Number.isFinite(n)) continue;
      const [lo, hi] = RANGES[k];
      n = Math.min(hi, Math.max(lo, n));
      out[k] = INTS.has(k) ? Math.round(n) : Math.round(n * 100) / 100;
    }
  }
  if (out.minFontSize > out.fontSize) out.minFontSize = out.fontSize;
  const texts = src.texts && typeof src.texts === 'object' ? src.texts : {};
  for (const k of Object.keys(DEFAULT_LAYOUT.texts)) {
    if (typeof texts[k] === 'string') out.texts[k] = texts[k].slice(0, 500);
  }
  return out;
}

export function parseLayout(json) {
  try { return sanitizeLayout(JSON.parse(json || '{}')); } catch { return sanitizeLayout({}); }
}

