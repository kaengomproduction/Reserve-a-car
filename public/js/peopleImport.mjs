// นำเข้ารายชื่อบุคลากรจาก Excel (.xlsx) / CSV — ใช้ร่วมกันทั้งเซิร์ฟเวอร์ Node และหน้าเว็บโหมด Supabase
// .xlsx คือไฟล์ zip ที่มี XML ข้างใน: แตก zip ด้วย DecompressionStream แล้วดึงข้อความจาก sharedStrings + แผ่นงานแรก

export class ImportError extends Error {}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ImportError('ไฟล์ไม่ใช่ Excel (.xlsx) ที่ถูกต้อง');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const utf8 = new TextDecoder('utf-8');
  const files = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + csize);
    files[name] = async () => utf8.decode(method === 0 ? raw : await inflateRaw(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decode = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  const map = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  if (map[e.toLowerCase()]) return map[e.toLowerCase()];
  return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});
const textOf = (xml) => decode([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

async function readXlsx(bytes) {
  const files = await unzip(bytes);
  const get = async (name) => (files[name] ? files[name]() : '');
  const shared = [...(await get('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const firstSheet = (await get('xl/workbook.xml')).match(/<sheet\b[^>]*r:id="([^"]+)"/);
  if (firstSheet) {
    const rels = await get('xl/_rels/workbook.xml.rels');
    const rel = rels.match(new RegExp(`<Relationship\\b[^>]*Id="${firstSheet[1]}"[^>]*Target="([^"]+)"`))
      || rels.match(new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${firstSheet[1]}"`));
    if (rel) sheetPath = rel[1].startsWith('/') ? rel[1].slice(1) : `xl/${rel[1].replace(/^\.\//, '')}`;
  }
  const sheet = await get(sheetPath);
  if (!sheet) throw new ImportError('ไม่พบแผ่นงานในไฟล์ Excel');
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    // Excel ไม่เก็บแถวว่าง จึงวางแถวตามเลขแถวจริง (r="3") เพื่อให้เลขแถวที่แจ้งผู้ใช้ตรงกับไฟล์
    const rowNo = Number((rm[1].match(/\br="(\d+)"/) || [])[1]) || rows.length + 1;
    while (rows.length < rowNo - 1) rows.push([]);
    const row = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] || '';
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1];
      const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = '';
      if (type === 's') val = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') val = textOf(body);
      else if (v !== undefined) val = decode(v);
      row[ref ? colIndex(ref) : row.length] = val;
    }
    rows.push(Array.from(row, (x) => (x ?? '').toString().trim()));
  }
  return rows;
}

function readCsv(bytes) {
  // CSV จาก Excel อาจเป็น UTF-8 หรือ ANSI ภาษาไทย (Windows-874)
  let s;
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { s = new TextDecoder('windows-874').decode(bytes); }
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows;
}

const isZip = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** อ่านไฟล์เป็นตาราง (array ของแถว แต่ละแถวเป็น array ของข้อความ) */
export async function readTable(bytes, filename = '') {
  const lower = String(filename).toLowerCase();
  if (lower.endsWith('.csv')) return readCsv(bytes);
  if (lower.endsWith('.xls') && !isZip(bytes)) {
    throw new ImportError('ไฟล์ .xls แบบเก่ายังไม่รองรับ กรุณาเปิดใน Excel แล้วบันทึกเป็น .xlsx (Excel Workbook)');
  }
  if (!isZip(bytes)) throw new ImportError('รองรับเฉพาะไฟล์ .xlsx หรือ .csv');
  return readXlsx(bytes);
}

/**
 * หาแถวหัวตาราง แล้วแยกแต่ละแถวเป็น เพิ่มใหม่ / อัปเดต (ชื่อมีอยู่แล้ว) / ข้าม
 * existing = รายชื่อปัจจุบัน [{ id, name, ... }]
 */
export function planImport(table, existing) {
  const norm = (v) => String(v || '').replace(/[\s*:：]/g, '');
  const find = (cells, re) => cells.findIndex((c) => re.test(norm(c)));
  let head = -1, cols;
  for (let i = 0; i < Math.min(20, table.length); i++) {
    const cells = table[i] || [];
    const c = {
      full: find(cells, /^(ชื่อ-?นามสกุล|ชื่อ-?สกุล|ชื่อและนามสกุล|ชื่อนามสกุล|ชื่อ\/นามสกุล)/),
      prefix: find(cells, /^คำนำหน้า/),
      first: find(cells, /^ชื่อ$/),
      last: find(cells, /^(นามสกุล|สกุล)$/),
      position: find(cells, /ตำแหน่ง/),
      department: find(cells, /^(ฝ่าย|กลุ่มงาน|สังกัด|หน่วยงาน|ฝ่าย\/กลุ่มงาน)/),
      phone: find(cells, /(โทร|เบอร์)/),
    };
    if (c.full >= 0 || c.first >= 0) { head = i; cols = c; break; }
  }
  if (head < 0) throw new ImportError('ไม่พบหัวคอลัมน์ “ชื่อ-นามสกุล” ในไฟล์ (ตรวจสอบว่าอยู่ในแผ่นงานแรก)');

  const cell = (r, i) => (i >= 0 ? String(r[i] ?? '').replace(/\s+/g, ' ').trim() : '');
  const byName = new Map(existing.map((p) => [String(p.name).replace(/\s+/g, ' ').trim(), p]));
  const seen = new Set();
  const rows = [];
  for (let i = head + 1; i < table.length; i++) {
    const r = table[i] || [];
    const name = cols.full >= 0 ? cell(r, cols.full) : `${cell(r, cols.prefix)}${cell(r, cols.first)} ${cell(r, cols.last)}`.trim();
    const d = { row: i + 1, name: name.slice(0, 120), position: cell(r, cols.position).slice(0, 120),
      department: cell(r, cols.department).slice(0, 160), phone: cell(r, cols.phone).slice(0, 40) };
    if (!d.name) { if (r.some((x) => String(x || '').trim())) rows.push({ ...d, action: 'skip', note: 'ไม่มีชื่อ' }); continue; }
    if (seen.has(d.name)) { rows.push({ ...d, action: 'skip', note: 'ชื่อซ้ำในไฟล์' }); continue; }
    seen.add(d.name);
    const old = byName.get(d.name);
    rows.push({ ...d, action: old ? 'update' : 'new', id: old?.id, note: old ? 'มีชื่อนี้แล้ว จะอัปเดตข้อมูล' : '' });
  }
  const counts = { new: 0, update: 0, skip: 0 };
  for (const r of rows) counts[r.action] += 1;
  const columns = Object.fromEntries(Object.entries(cols).filter(([, v]) => v >= 0).map(([k, v]) => [k, String(table[head][v])]));
  return { columns, counts, rows: rows.slice(0, 1000), allRows: rows, headerRow: head + 1 };
}

/** base64 (หรือ data URL) → Uint8Array */
export function fromBase64(data) {
  const b64 = String(data || '').replace(/^data:[^,]*,/, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
