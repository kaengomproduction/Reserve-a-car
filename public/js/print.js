import { api, esc, bkkParts, fmtTime, fmtMonthName, thaiYear, num } from './util.js';

// หน้าพิมพ์ตามแบบฟอร์ม "ใบขออนุญาตใช้รถส่วนกลาง/รถรับรอง" (แบบ ๔)
// รูปแบบ (ขนาดตัวอักษร ระยะขอบ ข้อความ ฯลฯ) มาจาก META.print_layout ที่ผู้ดูแลตั้งค่าไว้
const qs = new URLSearchParams(location.search);
const wrap = document.getElementById('wrap');
const id = Number(qs.get('id'));
const EMBED = qs.get('embed') === '1';   // ฝังในหน้าตั้งค่าเพื่อแสดงตัวอย่างสด
const SAMPLE = qs.get('sample') === '1'; // ใช้ข้อมูลสมมติ (ไม่ต้องมีการจองจริง)
const optFill = document.getElementById('optFill');
const optEdit = document.getElementById('optEdit');
const selResp = document.getElementById('selResp');
const selAppr = document.getElementById('selAppr');
let B, META, L, S;

// ---------- ส่วนประกอบ ----------
/** ช่องเส้นประบรรทัดเดียว (w = ความกว้างคงที่, ไม่ระบุ = ยืดเต็มที่เหลือ) */
const fill = (v, { w, cls = '' } = {}) =>
  `<span class="fill ${w ? 'fixed' : ''} ${cls}" data-edit ${w ? `style="width:${w}"` : ''}>${esc(v ?? '')}</span>`;
/** ข้อความหลายบรรทัด เส้นประทุกบรรทัด */
const lined = (label, v, min = 1) =>
  `<div class="lined" data-min="${min}"><div class="lines"></div><div class="content"><span class="lbl" data-edit>${esc(label)}</span><span class="val" data-edit>${esc(v ?? '')}</span></div></div>`;
const box = (on = false) => `<span class="cb ${on ? 'on' : ''}"></span>`;
const cb = (label, on = false) => `<span class="cb-item">${box(on)}<span data-edit>${esc(label)}</span></span>`;
const thDate = (iso) => (iso ? `${bkkParts(iso).d} ${fmtMonthName(iso)} ${thaiYear(iso)}` : '');
/** วันที่แบบย่อสำหรับช่องแคบ เช่น 3 พ.ย. 2569 */
const thDateShort = (iso) => (iso ? new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)) : '');
/** วัน/เดือน/ปี แบบช่องเส้นประ (ค่าว่าง = เว้นให้เขียน) */
const slashDate = (iso) => {
  const p = iso ? bkkParts(iso) : null;
  return `<div class="frow slash">${fill(p ? p.d : '', { w: '13mm' })}<span>/</span>${fill(p ? p.m : '', { w: '20mm' })}<span>/</span>${fill(p ? p.y + 543 : '', { w: '15mm' })}</div>`;
};
/** ลายเซ็นตามแบบฟอร์ม: (ลงชื่อ) .......... ตำแหน่ง / (ชื่อ) / วว/ดด/ปปปป */
const sign = (title, name = '', { date, withDate = true } = {}) => `
  <div class="sign">
    <div class="frow"><span>(ลงชื่อ)</span>${fill('')}<span data-edit>${esc(title)}</span></div>
    <div class="frow paren"><span>(</span>${fill(name)}<span>)</span></div>
    ${withDate ? slashDate(date) : ''}
  </div>`;

const personName = (pid) => (META.people || []).find((p) => p.id === Number(pid))?.name || '';

function render() {
  const s = S, T = L.texts;
  const R = optFill.checked; // เติมผลพิจารณา/บันทึกการใช้รถจากระบบ
  const created = B.created_at;
  const sp = bkkParts(B.start_at), ep = bkkParts(B.end_at);
  const types = META.types.filter((t) => t.active || t.id === B.type_id);
  const companions = Math.max(0, (B.passenger_count || 1) - 1); // จำนวนในระบบรวมผู้ขอ แบบฟอร์มถามเฉพาะผู้ร่วมเดินทาง
  const purpose = B.purpose + (L.showCompanionNames && B.companions ? ` (ผู้ร่วมเดินทาง: ${B.companions})` : '');
  const approvedByAdmin = ['approved', 'completed'].includes(B.status) && !!B.decided_by;
  const rejected = B.status === 'rejected';
  const driver = B.trip_driver || B.assigned_driver || '';
  const shortPlate = B.plate ? B.plate.split(' ').slice(0, 2).join(' ') : '';
  // เลขลำดับตามทะเบียนรถ (มีเมื่อการจองระบุรถแล้ว)
  const thaiDigits = (n) => String(n).replace(/\d/g, (d) => '๐๑๒๓๔๕๖๗๘๙'[d]);
  const seqText = B.vehicle_seq && T.seqFormat ? T.seqFormat.replace(/\{n\}/g, B.vehicle_seq).replace(/\{thn\}/g, thaiDigits(B.vehicle_seq))
    .replace(/\{short\}/g, shortPlate).replace(/\{plate\}/g, B.plate || '') : '';
  const dist = B.distance !== null && B.distance !== undefined ? num(B.distance) : '';
  const mile = (n) => (n === null || n === undefined ? '' : num(n));
  // ชื่อผู้ลงนาม: เลือกจากรายชื่อ (ค่าเริ่มต้นจากการตั้งค่า) / ผู้อนุมัติจริงในระบบ
  const respName = L.printSignerNames ? personName(selResp.value) : '';
  const apprName = L.printSignerNames ? (personName(selAppr.value) || (R && B.decided_by_name ? B.decided_by_name : '')) : '';

  wrap.innerHTML = `
  <article class="page" id="page">
    <header class="doc-head">
      <h1 class="doc-title" data-edit>${esc(s.form_title)}</h1>
      <div class="doc-code"><span data-edit>${esc(s.form_code)}</span>${seqText ? `<span class="doc-seq" data-edit>${esc(seqText)}</span>` : ''}</div>
    </header>

    <div class="frow date-row"><span class="grow"></span>
      <span>วันที่</span>${fill(bkkParts(created).d, { w: '13mm' })}<span>เดือน</span>${fill(fmtMonthName(created), { w: '32mm' })}<span>พ.ศ.</span>${fill(thaiYear(created), { w: '17mm' })}
    </div>
    <div class="frow"><span>เรียน</span>${s.form_to ? `<span class="plain" data-edit>${esc(s.form_to)}</span><span class="grow"></span>` : fill('', { cls: 'left' })}</div>

    <div class="frow indent"><span>ข้าพเจ้า</span>${fill(B.requester_name)}<span>ตำแหน่ง</span>${fill(B.requester_position)}</div>
    <div class="frow"><span>ฝ่าย/กลุ่มงาน</span>${fill(B.requester_department)}${s.org_affiliation ? `<span data-edit>สังกัด ${esc(s.org_affiliation)}</span>` : `<span>สังกัด</span>${fill('', { w: '50mm' })}`}</div>
    <div class="frow cbs-row"><span data-edit>${esc(T.requestLine)}</span>
      ${types.map((t) => cb(t.name, t.id === B.type_id)).join('')}
      ${!B.type_id && B.type_other ? cb(B.type_other, true) : ''}
    </div>
    ${lined(T.destination, B.destination, 1)}
    ${lined(T.purpose, purpose, L.purposeLines)}
    <div class="frow"><span>มีผู้ร่วมเดินทาง</span>${fill(companions || '-', { w: '15mm' })}<span>คน ตั้งแต่วันที่</span>${fill(sp.d, { w: '11mm' })}<span>เดือน</span>${fill(fmtMonthName(B.start_at))}<span>พ.ศ.</span>${fill(sp.y + 543, { w: '15mm' })}<span>เวลา</span>${fill(fmtTime(B.start_at), { w: '17mm' })}<span>น.</span></div>
    <div class="frow"><span>ถึงวันที่</span>${fill(ep.d, { w: '11mm' })}<span>เดือน</span>${fill(fmtMonthName(B.end_at), { w: '32mm' })}<span>พ.ศ.</span>${fill(ep.y + 543, { w: '15mm' })}<span>เวลา</span>${fill(fmtTime(B.end_at), { w: '17mm' })}<span>น.</span><span class="grow"></span></div>
    <p class="closing" data-edit>${esc(T.closing)}</p>
    <div class="sign-wrap requester">${sign(T.requesterTitle, B.requester_name, { date: created })}</div>

    ${L.showOfficerSection ? `
    <div class="split">
      <section class="col-left">
        <div class="frow"><span data-edit>เรียน ${esc(s.form_to)}</span></div>
        <div class="frow indent-sm plate-row">${box(R && !!B.plate)}<span data-edit>${esc(T.officerOpt1)}</span>${fill(R ? shortPlate : '')}</div>
        <div class="frow"><span data-edit>${esc(T.officerAssign)}</span>${fill(R ? driver : '')}<span data-edit>${esc(T.officerDriver)}</span></div>
        <p class="para">${box(false)} <span data-edit>${esc(T.officerOpt2)}</span></p>
        <p class="closing" data-edit>${esc(T.officerClosing)}</p>
        <div class="sign-wrap">${sign(s.responsible_title, respName)}</div>
      </section>
      <section class="col-right">
        <div class="frow"><span data-edit>${esc(s.approver_heading)}</span></div>
        <div class="opt">${cb(T.orderPermit, R && approvedByAdmin)}</div>
        <div class="opt">${cb(T.orderDeny, R && rejected)}</div>
        <div class="opt">${cb(T.orderUnable)}</div>
        ${T.orderUnableReason ? `<div class="opt cont" data-edit>${esc(T.orderUnableReason)}</div>` : ''}
        <div class="frow opt">${box(false)}<span data-edit>${esc(T.orderOther)}</span>${fill(R && rejected ? B.decision_note : '')}</div>
        <div class="frow opt">${fill(R && approvedByAdmin ? B.decision_note : '')}</div>
        <div class="sign-wrap">${sign(s.approver_title, apprName)}</div>
      </section>
    </div>` : ''}

    ${L.showTripSection ? `
    <section class="trip">
      <div class="trip-head" data-edit>${esc(s.trip_heading)}</div>
      <div class="frow"><span>ออกเดินทางวันที่</span>${fill(R ? thDateShort(B.depart_at) : '')}<span>เวลา</span>${fill(R && B.depart_at ? fmtTime(B.depart_at) : '', { w: '20mm' })}<span>น. หมายเลขไมล์</span>${fill(R ? mile(B.depart_mileage) : '', { w: '34mm' })}<span>กิโลเมตร</span></div>
      <div class="frow"><span data-edit>กลับถึง ${esc(s.return_place)} วันที่</span>${fill(R ? thDateShort(B.return_at) : '')}<span>เวลา</span>${fill(R && B.return_at ? fmtTime(B.return_at) : '', { w: '20mm' })}<span>น. หมายเลขไมล์</span>${fill(R ? mile(B.return_mileage) : '', { w: '34mm' })}<span>กิโลเมตร</span></div>
      <div class="frow"><span>รวมระยะทาง</span>${fill(R ? dist : '', { w: '42mm' })}<span>กิโลเมตร</span><span class="grow"></span></div>
      <div class="sign-wrap driver">${sign(T.driverTitle, R ? driver : '', { withDate: false })}</div>
    </section>` : ''}
    ${s.form_footer ? `<div class="doc-footer" data-edit>${esc(s.form_footer)}</div>` : ''}
    ${L.showRef ? `<div class="doc-ref">อ้างอิงการจองเลขที่ ${esc(B.code)}</div>` : ''}
  </article>`;

  applyLayoutVars();
  applyEditMode();
  layout();
}

/** นำค่ารูปแบบไปใส่เป็นตัวแปร CSS ของกระดาษ */
function applyLayoutVars() {
  const page = document.getElementById('page');
  page.style.padding = `${L.marginTop}mm ${L.marginRight}mm ${L.marginBottom}mm ${L.marginLeft}mm`;
  page.style.setProperty('--lh', `${L.lineHeight}em`);
  page.style.setProperty('--indent', `${L.indent}mm`);
  page.style.setProperty('--split', `${L.splitLeft}%`);
  page.style.setProperty('--sign-gap', `${L.signGap}mm`);
  page.style.setProperty('--ref-left', `${L.marginLeft}mm`);
}

// ---------- การจัดวาง: เส้นประหลายบรรทัด ย่อข้อความที่ยาวเกิน และบีบให้พอดี 1 หน้า ----------
function layoutLined(page) {
  for (const el of page.querySelectorAll('.lined')) {
    const content = el.querySelector('.content');
    const lh = parseFloat(getComputedStyle(content).lineHeight);
    const min = Number(el.dataset.min) || 1;
    const n = Math.max(min, Math.round(content.offsetHeight / lh));
    el.style.minHeight = `${n * lh}px`;
    const lbl = el.querySelector('.lbl');
    const first = lbl.textContent.trim() ? lbl.offsetWidth + 3 : 0;
    const shift = lh * 0.16; // ให้เส้นอยู่ใต้ตัวอักษรพอดี
    el.querySelector('.lines').innerHTML = Array.from({ length: n }, (_, k) =>
      `<i style="top:${k * lh}px;height:${lh - shift}px;left:${k === 0 ? first : 0}px"></i>`).join('');
  }
}
function shrinkFills(page) {
  for (const el of page.querySelectorAll('.fill')) {
    el.style.fontSize = '';
    let size = 100;
    while (el.scrollWidth > el.clientWidth + 1 && size > 62) { size -= 4; el.style.fontSize = `${size}%`; }
  }
}
const mmToPx = (mm) => (mm * 96) / 25.4;
let fitInfo = { fontSize: 0, fits: true };
function layout() {
  const page = document.getElementById('page');
  if (!page) return;
  page.style.zoom = 1;
  const pageH = mmToPx(297);
  let fs = L.fontSize;
  page.style.setProperty('--fs', `${fs}pt`);
  const run = () => { layoutLined(page); shrinkFills(page); };
  // วัดความสูงเนื้อหาจริง (ปิด min-height ชั่วคราว ไม่งั้นจะได้ 297mm เสมอ)
  const contentH = () => { page.style.minHeight = '0'; const h = page.offsetHeight; page.style.minHeight = ''; return h; };
  run();
  if (L.autoFit) {
    // เนื้อหายาวเกิน 1 หน้า ลดขนาดตัวอักษรทีละน้อย ไม่ต่ำกว่าค่าต่ำสุดที่ตั้งไว้
    while (contentH() > pageH - 2 && fs > L.minFontSize) { fs = Math.max(L.minFontSize, fs - 0.25); page.style.setProperty('--fs', `${fs}pt`); run(); }
  }
  fitInfo = { fontSize: fs, fits: contentH() <= pageH - 2 };
  if (EMBED) parent.postMessage({ type: 'print-fit', ...fitInfo }, location.origin);
  fitScreen();
}
function fitScreen() {
  const page = document.getElementById('page');
  if (!page) return;
  const avail = document.documentElement.clientWidth - (EMBED ? 8 : 16);
  page.style.zoom = Math.min(1, avail / mmToPx(210)).toFixed(3);
}
function applyEditMode() {
  const page = document.getElementById('page');
  page.classList.toggle('editing', optEdit.checked);
  page.querySelectorAll('[data-edit]').forEach((el) => { el.contentEditable = optEdit.checked ? 'true' : 'false'; });
}

// ---------- ผู้ลงนาม (เลือกจากรายชื่อที่ผู้ดูแลเพิ่ม) ----------
const SIGN_KEY = { resp: 'vb.print.resp', appr: 'vb.print.appr' };
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ไม่สำคัญ */ } } };
function fillSigners() {
  const opts = (flag, def) => `<option value="">— เว้นว่าง (เขียนเอง) —</option>` + (META.people || [])
    .filter((p) => p.active && p[flag]).map((p) => `<option value="${p.id}">${esc(p.name)}${p.position ? ` · ${esc(p.position)}` : ''}</option>`).join('');
  selResp.innerHTML = opts('is_responsible');
  selAppr.innerHTML = opts('is_approver');
  const pick = (sel, saved, def) => {
    const v = !EMBED && saved !== null ? saved : String(def || '');
    sel.value = [...sel.options].some((o) => o.value === v) ? v : '';
  };
  pick(selResp, store.get(SIGN_KEY.resp), L.responsibleId);
  pick(selAppr, store.get(SIGN_KEY.appr), L.approverId);
}

// ---------- ข้อมูลสมมติสำหรับตัวอย่าง ----------
function sampleBooking() {
  const now = new Date();
  const start = new Date(now.getTime() + 2 * 86400e3); start.setUTCHours(1, 30, 0, 0); // 08:30 น. เวลาไทย
  const end = new Date(start.getTime() + 8 * 3600e3);
  const van = META.types.find((t) => t.name.includes('ตู้')) || META.types[0];
  return {
    id: 0, code: 'ตัวอย่าง', created_at: now.toISOString(), start_at: start.toISOString(), end_at: end.toISOString(),
    requester_name: 'นางสาวตัวอย่าง ใจดี', requester_position: 'เจ้าพนักงานธุรการ', requester_department: 'กลุ่มงานบริหารทั่วไป',
    destination: 'ศาลากลางจังหวัดเชียงใหม่', purpose: 'ประชุมหารือการเตรียมการเลือกตั้งร่วมกับหน่วยงานที่เกี่ยวข้อง',
    companions: 'นายสมศักดิ์ ตัวอย่าง, นางสาวมาลี ตัวอย่าง', passenger_count: 3, type_id: van?.id, type_other: '',
    plate: 'นข 5678 เชียงใหม่', vehicle_seq: 12, assigned_driver: 'นายวิชัย ปลอดภัย', trip_driver: 'นายวิชัย ปลอดภัย', status: 'approved', decided_by: null,
    depart_at: start.toISOString(), depart_mileage: 120340, return_at: end.toISOString(), return_mileage: 120412, distance: 72,
  };
}

// ---------- เริ่มต้น ----------
optFill.addEventListener('change', () => {
  if (optEdit.checked && !confirm('การเปลี่ยนตัวเลือกนี้จะล้างข้อความที่แก้ไขบนเอกสาร ต้องการดำเนินการต่อหรือไม่')) { optFill.checked = !optFill.checked; return; }
  render();
});
optEdit.addEventListener('change', applyEditMode);
selResp.addEventListener('change', () => { store.set(SIGN_KEY.resp, selResp.value); render(); });
selAppr.addEventListener('change', () => { store.set(SIGN_KEY.appr, selAppr.value); render(); });
document.addEventListener('input', (e) => { if (e.target.closest?.('#page')) layoutLined(document.getElementById('page')); });
document.getElementById('printBtn').addEventListener('click', () => window.print());
window.addEventListener('resize', fitScreen);
window.addEventListener('beforeprint', () => { const p = document.getElementById('page'); if (p) p.style.zoom = 1; });
window.addEventListener('afterprint', fitScreen);
// ตัวอย่างสดจากหน้าตั้งค่า: รับรูปแบบ/ข้อความที่ยังไม่บันทึกมาแสดง
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data || e.data.type !== 'print-preview' || !META) return;
  if (e.data.layout) L = e.data.layout;
  if (e.data.settings) S = { ...S, ...e.data.settings };
  if (typeof e.data.fill === 'boolean') optFill.checked = e.data.fill;
  fillSigners();
  render();
});

(async () => {
  if (EMBED) document.body.classList.add('embed');
  if (!id && !SAMPLE) { wrap.innerHTML = '<div class="error">ไม่พบเลขที่การจอง</div>'; return; }
  try {
    META = await api('GET', '/api/meta');
    B = SAMPLE ? sampleBooking() : await api('GET', `/api/bookings/${id}`);
  } catch (e) {
    wrap.innerHTML = `<div class="error">${esc(e.message)}</div>`;
    return;
  }
  L = META.print_layout; S = META.settings;
  if (SAMPLE) optFill.checked = true;
  document.title = `${S.form_title} ${B.code}`;
  document.getElementById('tbTitle').textContent = `${B.code} · ${B.requester_name}`;
  if (B.id) document.getElementById('backLink').href = `./#/requests/${B.id}`;
  fillSigners();
  // โหลดฟอนต์ Sarabun ให้เสร็จก่อนวัดขนาดหน้า (ไม่งั้นจะวัดด้วยฟอนต์สำรองแล้วล้นเป็น 2 หน้า)
  await Promise.race([
    Promise.all(['400', '600', '700'].map((w) => document.fonts.load(`${w} 14pt Sarabun`, 'ใบขออนุญาต'))),
    new Promise((r) => setTimeout(r, 4000)),
  ]).catch(() => {});
  render();
  document.fonts.addEventListener?.('loadingdone', () => layout());
  if (EMBED) parent.postMessage({ type: 'print-ready' }, location.origin);
  if (qs.get('autoprint') === '1') setTimeout(() => window.print(), 300);
})();
