'use strict';
// อ่านตารางจากไฟล์ Excel (.xlsx) หรือ .csv โดยไม่ต้องติดตั้งแพ็กเกจเพิ่ม
// .xlsx คือไฟล์ zip ที่มี XML อยู่ภายใน: อ่าน zip ด้วย zlib แล้วดึงข้อความจาก sharedStrings + แผ่นงานแรก
const zlib = require('node:zlib');

class ImportError extends Error {}

function unzip(buf) {
  // หา End of Central Directory จากท้ายไฟล์
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ImportError('ไฟล์ไม่ใช่ Excel (.xlsx) ที่ถูกต้อง');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    files[name] = () => (method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8');
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

function readXlsx(buf) {
  const files = unzip(buf);
  const get = (name) => (files[name] ? files[name]() : '');
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  // แผ่นงานแรกตามลำดับใน workbook
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const firstSheet = get('xl/workbook.xml').match(/<sheet\b[^>]*r:id="([^"]+)"/);
  if (firstSheet) {
    const rel = get('xl/_rels/workbook.xml.rels').match(new RegExp(`<Relationship\\b[^>]*Id="${firstSheet[1]}"[^>]*Target="([^"]+)"`))
      || get('xl/_rels/workbook.xml.rels').match(new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${firstSheet[1]}"`));
    if (rel) sheetPath = rel[1].startsWith('/') ? rel[1].slice(1) : `xl/${rel[1].replace(/^\.\//, '')}`;
  }
  const sheet = get(sheetPath);
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

function readCsv(buf) {
  // CSV จาก Excel อาจเป็น UTF-8 หรือ ANSI ภาษาไทย (Windows-874)
  let s;
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { s = new TextDecoder('windows-874').decode(buf); }
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // ตัด BOM
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

/** อ่านไฟล์เป็นตาราง (array ของแถว แต่ละแถวเป็น array ของข้อความ) */
function readTable(buf, filename = '') {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv')) return readCsv(buf);
  if (lower.endsWith('.xls') && buf.readUInt32LE(0) !== 0x04034b50) {
    throw new ImportError('ไฟล์ .xls แบบเก่ายังไม่รองรับ กรุณาเปิดใน Excel แล้วบันทึกเป็น .xlsx (Excel Workbook)');
  }
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) throw new ImportError('รองรับเฉพาะไฟล์ .xlsx หรือ .csv');
  return readXlsx(buf);
}

module.exports = { readTable, ImportError };
