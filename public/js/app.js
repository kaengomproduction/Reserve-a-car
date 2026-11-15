import {
  api, ApiError, SUPABASE_MODE, addToken, getLastRequester, setLastRequester, esc, num, fmtDateTime, fmtDate, fmtDateLong, fmtDayShort, fmtTime, fmtRange,
  bkkParts, bkkIso, bkkDayStart, toLocalInput, fromLocalInput, fmtMonthYear, BOOKING_STATUS, EVENT_LABEL,
} from './util.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $('#app');
const S = { user: null, users: [], demo: {}, types: [], settings: {} };
const isAdmin = () => S.user?.role === 'admin';
const needApproval = () => S.settings.require_approval === '1';
const dayMode = () => S.settings.conflict_mode !== 'time';

// ---------- ส่วนประกอบทั่วไป ----------
const ICON = {
  car: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11"/><rect x="3" y="11" width="18" height="6" rx="2"/><circle cx="7.5" cy="17.5" r="1.6"/><circle cx="16.5" cy="17.5" r="1.6"/></svg>',
  print: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 9V3h12v6M6 18H4a1 1 0 0 1-1-1v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1h-2"/><rect x="6" y="14" width="12" height="7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 13h8M8 16h5"/></svg>',
};
/** ป้ายทะเบียนแบบไทย: หมวดและเลข บรรทัดบน จังหวัดบรรทัดล่าง */
function plateHtml(plate) {
  const m = String(plate).match(/^(\S+\s+\S+)\s+(.+)$/);
  return `<span class="plate"><b>${esc(m ? m[1] : plate)}</b>${m ? `<small>${esc(m[2])}</small>` : ''}</span>`;
}
const vBadge = (v) => `<span class="badge st-${v.state}">${esc(v.state_label)}</span>`;
const bBadge = (s) => `<span class="badge bs-${s}">${esc(BOOKING_STATUS[s])}</span>`;
const demoTag = (o) => (o?.is_demo ? ' <span class="tag" title="ข้อมูลตัวอย่าง ลบได้ที่หน้าตั้งค่า">ตัวอย่าง</span>' : '');
const empty = (msg) => `<div class="empty card">${ICON.empty}${esc(msg)}</div>`;
const vehicleName = (b) => (b.plate ? `${b.plate}` : 'ยังไม่ระบุรถ');
const typeName = (id) => S.types.find((t) => t.id === id)?.name || '';

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3500);
}
function showError(e) { toast(e instanceof ApiError || e instanceof Error ? e.message : String(e), 'err'); }

function conflictHtml(err) {
  const list = err?.data?.conflicts || err?.conflicts || [];
  return `<div class="conflict-box"><b>${esc(err.message || 'รถไม่ว่างในช่วงเวลาที่เลือก')}</b>${list.length ? `<ul>${list.map((c) => `<li>${esc(c.message)}</li>`).join('')}</ul>` : ''}</div>`;
}

/**
 * เปิดหน้าต่างโต้ตอบ — onSubmit(form) คืนค่าใด ๆ เพื่อปิด, โยน error เพื่อแสดงข้อความในหน้าต่าง
 */
function modal({ title, body, submitLabel = 'บันทึก', submitClass = 'btn-primary', onSubmit, onOpen, cancelLabel = 'ยกเลิก', hideSubmit = false }) {
  const dlg = $('#modal'), box = $('#modalBox');
  box.innerHTML = `
    <div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="modal-close" data-close aria-label="ปิด">×</button></div>
    <div class="modal-body stack">${body}</div>
    <div class="modal-error" hidden></div>
    <div class="modal-foot">
      <button type="button" class="btn" data-close>${esc(cancelLabel)}</button>
      ${hideSubmit ? '' : `<button type="submit" class="btn ${submitClass}" data-submit>${esc(submitLabel)}</button>`}
    </div>`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; dlg.close(); resolve(v); };
    $$('[data-close]', box).forEach((b) => b.addEventListener('click', () => finish(null)));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); }, { once: true });
    box.onsubmit = async (e) => {
      e.preventDefault();
      if (!onSubmit) return finish(true);
      const btn = $('[data-submit]', box), errBox = $('.modal-error', box);
      btn.disabled = true; errBox.hidden = true;
      try { const r = await onSubmit(box); finish(r ?? true); }
      catch (err) {
        errBox.hidden = false;
        errBox.innerHTML = err?.data?.conflicts ? conflictHtml(err) : `<div class="conflict-box">${esc(err.message)}</div>`;
      } finally { btn.disabled = false; }
    };
    dlg.showModal();
    onOpen?.(box);
    const first = $('input:not([type=hidden]):not([readonly]), textarea, select', box);
    first?.focus();
  });
}
const formData = (form) => Object.fromEntries(new FormData(form).entries());

function confirmDialog(title, message, label = 'ยืนยัน', cls = 'btn-primary') {
  return modal({ title, body: `<p>${esc(message)}</p>`, submitLabel: label, submitClass: cls });
}
function reasonDialog(title, label, submitLabel, cls = 'btn-danger') {
  return modal({
    title, submitLabel, submitClass: cls,
    body: `<label class="field"><span>${esc(label)} <b class="req">*</b></span><textarea name="reason" required maxlength="1000"></textarea></label>`,
    onSubmit: (f) => {
      const reason = f.reason.value.trim();
      if (!reason) throw new Error('กรุณาระบุเหตุผล');
      return reason;
    },
  });
}

// ---------- เปลือกแอป: เมนู สลับผู้ใช้ ----------
const NAV = [
  ['/', 'สถานะรถ'], ['/book', 'จองรถ'], ['/requests', 'การจอง'], ['/schedule', 'ตารางรายสัปดาห์'], ['/vehicles', 'รายการรถ'], ['/trips', 'บันทึกการใช้รถ', true], ['/settings', 'ตั้งค่า', true],
];

async function loadSession() {
  const s = await api('GET', '/api/session');
  S.demo = s.demo; S.user = s.user; S.account = s.account;
  const meta = await api('GET', '/api/meta');
  S.types = meta.types; S.settings = meta.settings; S.people = meta.people; S.presets = meta.presets;
  S.layout = meta.print_layout; S.layoutDefault = meta.print_layout_default;
  renderDatalists();
  // ไม่ต้องอนุมัติ: สถานะ approved แสดงเป็น "จองแล้ว"
  BOOKING_STATUS.approved = needApproval() ? 'อนุมัติ' : 'จองแล้ว';
  renderShell();
}

/** รายชื่อพนักงานขับรถสำหรับช่องที่พิมพ์ชื่อได้หรือเลือกจากรายการ (<input list="dlDrivers">) */
function renderDatalists() {
  let dl = document.getElementById('dlDrivers');
  if (!dl) { dl = document.createElement('datalist'); dl.id = 'dlDrivers'; document.body.append(dl); }
  dl.innerHTML = (S.people || []).filter((p) => p.active && p.is_driver).map((p) => `<option value="${esc(p.name)}">${esc(p.phone || p.position)}</option>`).join('');
}
const driverAttrs = 'list="dlDrivers" autocomplete="off" placeholder="เลือกจากรายชื่อ หรือพิมพ์ชื่อ"';

function renderShell() {
  $('#acct').innerHTML = isAdmin()
    ? `<span class="who">ผู้ดูแล: ${esc(S.user.name)}</span><button class="btn-top" id="logoutBtn">ออกจากระบบ</button>`
    : `<button class="btn-top" id="loginBtn">เข้าสู่ระบบผู้ดูแล</button>`;
  $('#loginBtn')?.addEventListener('click', loginDialog);
  $('#logoutBtn')?.addEventListener('click', logout);
  $('#orgName').textContent = S.settings.org_name || 'ส่วนกลาง';
  const banner = $('#demoBanner');
  const hasDemo = S.demo.vehicles + S.demo.bookings > 0;
  const demoNote = hasDemo ? ' · รายการที่มีป้าย <span class="tag">ตัวอย่าง</span> เป็นข้อมูลตัวอย่าง' + (isAdmin() ? ' (ลบได้ที่หน้าตั้งค่า)' : '') : '';
  banner.hidden = false;
  banner.classList.toggle('warn', !!(isAdmin() && S.account?.is_default));
  banner.innerHTML = isAdmin() && S.account?.is_default
    ? '<b>ยังใช้รหัสผ่านเริ่มต้นอยู่</b> · กรุณาเปลี่ยนที่ <a href="#/settings?tab=general">ตั้งค่า → บัญชีผู้ดูแล</a>'
    : isAdmin() ? `เข้าสู่ระบบในฐานะผู้ดูแลแล้ว${demoNote}`
      : `จองรถได้โดยไม่ต้องเข้าสู่ระบบ · การจองของคุณจะแสดงในเมนู “การจองของฉัน” บนเครื่องที่ใช้จอง${demoNote}`;
  renderNav();
}

function loginDialog() {
  return modal({
    title: 'เข้าสู่ระบบผู้ดูแล', submitLabel: 'เข้าสู่ระบบ',
    body: `<label class="field"><span>${SUPABASE_MODE ? 'อีเมลผู้ดูแล' : 'ชื่อผู้ใช้'}</span><input name="username" ${SUPABASE_MODE ? 'type="email"' : ''} autocomplete="username" required></label>
      <label class="field"><span>รหัสผ่าน</span><input name="password" type="password" autocomplete="current-password" required></label>`,
    onSubmit: async (f) => {
      await api('POST', '/api/login', { username: f.username.value, password: f.password.value });
      await loadSession();
      toast('เข้าสู่ระบบแล้ว');
      route();
      return true;
    },
  });
}
async function logout() {
  try { await api('POST', '/api/logout', {}); } catch { /* ออกต่อได้ */ }
  await loadSession();
  toast('ออกจากระบบแล้ว');
  location.hash = '#/';
  route();
}
function adminOnly() {
  app.innerHTML = `<div class="card card-pad" style="max-width:520px">
    <h2>หน้านี้สำหรับผู้ดูแลระบบ</h2><p class="muted">กรุณาเข้าสู่ระบบด้วยบัญชีผู้ดูแล</p>
    <button class="btn btn-primary" id="needLogin">เข้าสู่ระบบผู้ดูแล</button></div>`;
  $('#needLogin').onclick = loginDialog;
}

async function renderNav(pendingCount) {
  const cur = location.hash.slice(1).split('?')[0] || '/';
  const active = (p) => (p === '/' ? cur === '/' : cur.startsWith(p));
  $('#nav').innerHTML = NAV.filter(([, , adm]) => !adm || isAdmin())
    .map(([p, l]) => [p, p === '/requests' ? (isAdmin() ? 'การจองทั้งหมด' : 'การจองของฉัน') : l])
    .map(([p, l]) => `<a href="#${p}" class="${active(p) ? 'active' : ''}">${l}${p === '/requests' && pendingCount ? `<span class="count" title="รออนุมัติ">${pendingCount}</span>` : ''}</a>`).join('');
}
async function refreshPendingBadge() {
  if (!needApproval()) return;
  try {
    const rows = await api('GET', '/api/bookings?status=pending');
    renderNav(rows.length);
  } catch { /* ไม่สำคัญ */ }
}

$('#menuBtn').addEventListener('click', () => {
  const open = $('#nav').classList.toggle('open');
  $('#menuBtn').setAttribute('aria-expanded', open);
});

// ---------- เราเตอร์ ----------
function parseHash() {
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(qs || '')) };
}
async function route() {
  const { path, query } = parseHash();
  $('#nav').classList.remove('open');
  renderNav();
  refreshPendingBadge();
  const m = path.match(/^\/requests\/(\d+)$/);
  const view = m ? () => viewRequestDetail(Number(m[1]))
    : { '/': viewDashboard, '/vehicles': viewVehicles, '/schedule': viewSchedule, '/book': viewBook, '/requests': viewRequests, '/trips': viewTrips, '/settings': viewSettings }[path];
  if (!view) { app.innerHTML = empty('ไม่พบหน้าที่ต้องการ'); return; }
  app.innerHTML = '<div class="loading">กำลังโหลด…</div>';
  try { await view(query); }
  catch (e) {
    app.innerHTML = `<div class="conflict-box">${esc(e.message)}</div>`;
    if (e.status !== 403) console.error(e);
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// =====================================================================
// สถานะรถแบบปฏิทินรายเดือน
// =====================================================================
const mcal = { month: null, type_id: '', vehicle: '', selected: null };
const ymd = (iso) => toLocalInput(iso).slice(0, 10);

async function viewDashboard(query) {
  const today = bkkDayStart();
  if (query.vehicle !== undefined) mcal.vehicle = query.vehicle;
  if (!mcal.month) { const p = bkkParts(today); mcal.month = bkkIso(p.y, p.m, 1); }
  if (!mcal.selected) mcal.selected = today;
  const mp = bkkParts(mcal.month);
  const monthEnd = bkkIso(mp.y, mp.m + 1, 1);
  const gridStart = bkkDayStart(mcal.month, -((bkkParts(mcal.month).dow + 6) % 7)); // เริ่มวันจันทร์
  const weeks = Math.ceil((Date.parse(monthEnd) - Date.parse(gridStart)) / (7 * 86400e3));
  const days = Array.from({ length: weeks * 7 }, (_, i) => bkkDayStart(gridStart, i));
  const gridEnd = bkkDayStart(gridStart, weeks * 7);

  const [data, dashData] = await Promise.all([
    api('GET', `/api/schedule?from=${encodeURIComponent(gridStart)}&to=${encodeURIComponent(gridEnd)}`),
    api('GET', '/api/dashboard'),
  ]);
  const allVehicles = data.vehicles.filter((v) => !mcal.type_id || String(v.type_id) === mcal.type_id);
  const vehicles = mcal.vehicle ? allVehicles.filter((v) => String(v.id) === mcal.vehicle) : allVehicles;
  const dayEndOf = (d) => bkkDayStart(d, 1);
  const hit = (item, d) => Date.parse(item.start_at) < Date.parse(dayEndOf(d)) && (!item.end_at || Date.parse(item.end_at) > Date.parse(d));

  /** สถานะของรถแต่ละคันในวันที่ d */
  const dayInfo = (d) => vehicles.map((v) => {
    const maint = data.maintenance.filter((m) => m.vehicle_id === v.id && hit(m, d));
    const books = data.bookings.filter((b) => b.vehicle_id === v.id && hit(b, d));
    const nowMs = Date.now();
    const inUse = books.some((b) => b.status === 'approved' && Date.parse(b.start_at) <= nowMs && Date.parse(b.end_at) > nowMs);
    const state = !v.active ? 'off' : maint.length ? 'maint' : inUse ? 'inuse' : books.length ? 'booked' : 'free';
    return { v, state, maint, books };
  });
  const STATE = { free: ['ว่าง', 'st-available'], booked: ['จองแล้ว', 'st-booked'], inuse: ['กำลังใช้งาน', 'st-in_use'], maint: ['ซ่อมบำรุง', 'st-unavailable'], off: ['ปิดใช้งาน', 'st-unavailable'] };
  const who = (b) => (b.can_view ? `${b.requester_name} · ${b.destination}` : (b.requester_department || 'มีผู้จองแล้ว'));
  const c = dashData.counts;

  const cell = (d) => {
    const info = dayInfo(d);
    const inMonth = bkkParts(d).m === mp.m;
    const past = Date.parse(d) < Date.parse(today);
    const cls = ['mc-day', inMonth ? '' : 'out', past ? 'past' : '', d === today ? 'today' : '', d === mcal.selected ? 'sel' : ''].join(' ');
    let body;
    if (mcal.vehicle && info[0]) {
      const x = info[0];
      body = x.state === 'free' ? (past ? '' : '<span class="mc-tag free">ว่าง</span>')
        : ['booked', 'inuse'].includes(x.state) ? x.books.map((b) => `<span class="mc-tag booked" title="${esc(who(b))}">${fmtTime(b.start_at)}–${fmtTime(b.end_at)}<em> ${esc(who(b))}</em></span>`).join('')
          : `<span class="mc-tag maint">${STATE[x.state][0]}</span>`;
    } else {
      const usable = info.filter((x) => x.state !== 'off');
      const free = usable.filter((x) => x.state === 'free').length;
      const lvl = !usable.length ? 'none' : free === 0 ? 'full' : free <= usable.length / 3 ? 'low' : 'ok';
      const busy = info.filter((x) => ['booked', 'inuse', 'maint'].includes(x.state));
      const pill = past ? '' : `<span class="mc-free ${lvl}"><span class="hide-sm">ว่าง </span>${free}/${usable.length}</span>`;
      body = `${pill}
        <span class="mc-list">${busy.slice(0, 3).map((x) => `<span class="mc-line ${x.state}">${esc(x.v.plate.split(' ').slice(0, 2).join(' '))}</span>`).join('')}${busy.length > 3 ? `<span class="mc-more">+${busy.length - 3}</span>` : ''}</span>`;
    }
    return `<button type="button" class="${cls}" data-day="${d}" aria-label="${esc(fmtDateLong(d))}"><span class="mc-num">${bkkParts(d).d}</span>${body}</button>`;
  };

  app.innerHTML = `
    <div class="page-head">
      <div><h1>สถานะรถ</h1><p>เลือกวันในปฏิทินเพื่อดูว่ารถคันไหนว่าง แล้วกดจองได้ทันที${S.settings.require_approval === '1' ? '' : ' · จองแล้วยืนยันทันที ไม่ต้องรออนุมัติ'}</p></div>
      <a class="btn btn-primary" href="#/book">${ICON.plus} จองรถ</a>
    </div>
    <div class="stats stats-4">
      ${[['available', 'ว่างขณะนี้', c.available], ['booked', 'จองแล้ว (ยังไม่ถึงเวลา)', c.booked], ['in_use', 'กำลังใช้งาน', c.in_use], ['unavailable', 'ซ่อม/ปิดใช้งาน', c.unavailable]]
        .map(([k, l, n]) => `<div class="stat ${k}"><span class="n">${n}</span><span class="l">${l}</span></div>`).join('')}
    </div>
    <div class="alerts">${dashData.pending && S.settings.require_approval === '1' ? `<a class="alert" href="#/requests?status=pending"><b>${dashData.pending}</b> ${isAdmin() ? 'คำขอรออนุมัติ' : 'คำขอของคุณรออนุมัติ'} →</a>` : ''}
      ${dashData.overdue ? `<a class="alert red" href="#/trips?f=overdue"><b>${dashData.overdue}</b> รายการเลยกำหนดกลับแต่ยังไม่บันทึกขากลับ →</a>` : ''}</div>

    <div class="mc-layout">
      <section class="card mc-card">
        <div class="mc-toolbar">
          <button class="btn btn-sm" id="mPrev" aria-label="เดือนก่อน">‹</button>
          <h2 class="mc-title">${esc(fmtMonthYear(mcal.month))}</h2>
          <button class="btn btn-sm" id="mNext" aria-label="เดือนถัดไป">›</button>
          <button class="btn btn-sm" id="mToday">วันนี้</button>
          <span class="spacer"></span>
          <select class="input" id="mType" aria-label="ประเภทรถ"><option value="">ทุกประเภท</option>${S.types.map((t) => `<option value="${t.id}" ${String(t.id) === mcal.type_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
          <select class="input" id="mVeh" aria-label="เลือกรถ"><option value="">รถทุกคัน</option>${allVehicles.map((v) => `<option value="${v.id}" ${String(v.id) === mcal.vehicle ? 'selected' : ''}>${esc(v.plate)}</option>`).join('')}</select>
        </div>
        <div class="mc-grid">
          ${['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.'].map((w) => `<div class="mc-wd">${w}</div>`).join('')}
          ${days.map(cell).join('')}
        </div>
        <div class="legend">
          ${mcal.vehicle ? '<span><i class="lg free"></i>ว่าง</span><span><i class="lg booked"></i>จองแล้ว</span><span><i class="lg maint"></i>ซ่อม/ไม่พร้อมใช้งาน</span>'
            : '<span><i class="lg free"></i>ว่างหลายคัน</span><span><i class="lg low"></i>เหลือน้อย</span><span><i class="lg full"></i>เต็ม</span><span>ตัวเลข = รถว่าง/รถที่ใช้งานได้</span>'}
        </div>
      </section>
      <section class="card mc-panel" id="dayPanel"></section>
    </div>`;

  function renderPanel() {
    const d = mcal.selected;
    const past = Date.parse(d) < Date.parse(today);
    const info = dayInfo(d);
    const freeN = info.filter((x) => x.state === 'free').length;
    const usableN = info.filter((x) => x.state !== 'off').length;
    $('#dayPanel').innerHTML = `
      <h2>${esc(fmtDateLong(d))}${d === today ? ' <span class="tag tag-gray">วันนี้</span>' : ''}</h2>
      <p class="muted" style="margin:4px 0 12px">${info.length ? `รถว่าง ${freeN} จาก ${usableN} คันที่ใช้งานได้` : 'ไม่มีรถตามเงื่อนไข'}${past ? ' · วันที่ผ่านมาแล้ว' : ''}</p>
      <div class="day-list">${info.map((x) => `
        <div class="day-row">
          <div class="day-row-head">${plateHtml(x.v.plate)}<span class="badge ${STATE[x.state][1]}">${STATE[x.state][0]}</span></div>
          <div class="faint">${esc(x.v.brand)} ${esc(x.v.model)} · ${esc(x.v.type_name)} · ${x.v.seats} ที่นั่ง</div>
          ${x.books.map((b) => {
            const line = `<b>${esc(fmtRange(b.start_at, b.end_at))}</b><br>${esc(who(b))}${b.code ? ` <span class="faint">(${esc(b.code)})</span>` : ''}`;
            return b.can_view ? `<a class="day-book" href="#/requests/${b.id}">${line}</a>` : `<div class="day-book">${line}</div>`;
          }).join('')}
          ${x.maint.map((m) => `<div class="day-book maint">ซ่อมบำรุง: ${esc(m.description)}<br><span class="faint">ถึง ${m.end_at ? esc(fmtDateTime(m.end_at)) : 'ยังไม่กำหนด'}</span></div>`).join('')}
          ${x.state === 'free' && !past ? `<a class="btn btn-sm btn-primary" href="#/book?vehicle=${x.v.id}&date=${ymd(d)}">จองวันนี้</a>` : ''}
        </div>`).join('')}
      </div>`;
  }
  renderPanel();

  const go = (m) => { mcal.month = m; viewDashboard({}); };
  $('#mPrev').onclick = () => go(bkkIso(mp.y, mp.m - 1, 1));
  $('#mNext').onclick = () => go(bkkIso(mp.y, mp.m + 1, 1));
  $('#mToday').onclick = () => { mcal.selected = today; go(bkkIso(bkkParts(today).y, bkkParts(today).m, 1)); };
  $('#mType').onchange = (e) => { mcal.type_id = e.target.value; mcal.vehicle = ''; viewDashboard({}); };
  $('#mVeh').onchange = (e) => { mcal.vehicle = e.target.value; viewDashboard({}); };
  $('.mc-grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-day]'); if (!b) return;
    mcal.selected = b.dataset.day;
    $$('.mc-day').forEach((x) => x.classList.toggle('sel', x === b));
    renderPanel();
    if (window.innerWidth < 960) $('#dayPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function vehicleCard(v) {
  const canBook = v.active && v.state_reason !== 'maintenance';
  return `<article class="card vcard ${v.active ? '' : 'is-off'}">
    <div class="vcard-top">
      <div>${plateHtml(v.plate)}${demoTag(v)}<div class="model">${esc(v.brand)} ${esc(v.model)}</div></div>
      ${vBadge(v)}
    </div>
    ${v.state_detail ? `<div class="state-detail">${esc(v.state_detail)}</div>` : ''}
    <dl class="meta">
      <dt>ประเภท</dt><dd>${esc(v.type_name)}</dd>
      <dt>ที่นั่ง</dt><dd>${v.seats} ที่นั่ง</dd>
      <dt>พนักงานขับรถ</dt><dd>${v.driver_name ? esc(v.driver_name) : '<span class="faint">ไม่มีประจำ</span>'}</dd>
    </dl>
    ${v.next_booking ? `<div class="next">คิวถัดไป: <b>${esc(fmtRange(v.next_booking.start_at, v.next_booking.end_at))}</b> ${bBadge(v.next_booking.status)}</div>` : ''}
    <div class="vcard-actions">
      ${canBook ? `<a class="btn btn-sm btn-primary" href="#/book?vehicle=${v.id}">จองรถคันนี้</a>` : ''}
      <a class="btn btn-sm" href="#/?vehicle=${v.id}">ดูปฏิทิน</a>
    </div>
  </article>`;
}

// =====================================================================
// รายการรถ (ผู้ดูแลเพิ่ม แก้ไข ปิดใช้งาน และบันทึกการซ่อมบำรุงได้)
// =====================================================================
async function viewVehicles() {
  const vehicles = await api('GET', '/api/vehicles');
  const admin = isAdmin();
  app.innerHTML = `
    <div class="page-head">
      <div><h1>รายการรถ</h1><p>${vehicles.length} คัน · สถานะ ณ เวลาปัจจุบัน</p></div>
      ${admin ? `<button class="btn btn-primary" id="addV">${ICON.plus} เพิ่มรถ</button>` : ''}
    </div>
    ${vehicles.length ? `
    <div class="card table-wrap hide-sm"><table class="table">
      <thead><tr><th>ทะเบียน</th><th>ยี่ห้อ/รุ่น</th><th>ประเภท</th><th class="num">ที่นั่ง</th><th>พนักงานขับรถ</th><th class="num">เลขไมล์</th><th>สถานะ</th>${admin ? '<th>จัดการ</th>' : ''}</tr></thead>
      <tbody>${vehicles.map((v) => `<tr>
        <td><b>${esc(v.plate)}</b>${demoTag(v)}${v.note ? `<div class="faint">${esc(v.note)}</div>` : ''}</td>
        <td>${esc(v.brand)} ${esc(v.model)}${v.color ? `<div class="faint">สี${esc(v.color)}</div>` : ''}</td>
        <td>${esc(v.type_name)}</td>
        <td class="num">${v.seats}</td>
        <td>${v.driver_name ? esc(v.driver_name) + (v.driver_phone ? `<div class="faint">${esc(v.driver_phone)}</div>` : '') : '<span class="faint">-</span>'}</td>
        <td class="num">${num(v.mileage)}</td>
        <td>${vBadge(v)}${v.state_detail ? `<div class="faint">${esc(v.state_detail)}</div>` : ''}</td>
        ${admin ? `<td><div class="row" style="gap:6px;flex-wrap:nowrap">${vehicleActions(v)}</div></td>` : ''}
      </tr>`).join('')}</tbody></table></div>
    <div class="vehicle-grid show-sm">${vehicles.map((v) => vehicleCard(v).replace('<div class="vcard-actions">', `<div class="vcard-actions">${admin ? vehicleActions(v) : ''}`)).join('')}</div>`
    : empty('ยังไม่มีรถในระบบ')}`;

  $('#addV')?.addEventListener('click', () => vehicleForm());
}

function vehicleActions(v) {
  return `<button class="btn btn-sm" data-act="edit" data-id="${v.id}">แก้ไข</button>
    <button class="btn btn-sm" data-act="maint" data-id="${v.id}">ซ่อมบำรุง</button>
    <button class="btn btn-sm ${v.active ? 'btn-danger' : ''}" data-act="toggle" data-id="${v.id}" data-active="${v.active}">${v.active ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}</button>`;
}

async function onVehicleAction(e) {
  const b = e.target.closest('[data-act]'); if (!b || !b.dataset.id) return;
  const id = Number(b.dataset.id);
  try {
    if (b.dataset.act === 'edit') await vehicleForm(await api('GET', `/api/vehicles/${id}`));
    if (b.dataset.act === 'maint') await maintenanceDialog(id);
    if (b.dataset.act === 'toggle') {
      const active = b.dataset.active === '1';
      const ok = await confirmDialog(active ? 'ปิดใช้งานรถ' : 'เปิดใช้งานรถ',
        active ? 'รถที่ปิดใช้งานจะจองไม่ได้จนกว่าจะเปิดใช้งานอีกครั้ง ต้องการดำเนินการต่อหรือไม่' : 'เปิดให้จองรถคันนี้ได้อีกครั้ง',
        active ? 'ปิดใช้งาน' : 'เปิดใช้งาน', active ? 'btn-danger' : 'btn-primary');
      if (!ok) return;
      const r = await api('POST', `/api/vehicles/${id}/active`, { active: !active });
      toast(active ? 'ปิดใช้งานรถแล้ว' : 'เปิดใช้งานรถแล้ว');
      warnAffected(r.warnings);
      route();
    }
  } catch (err) { showError(err); }
}

function warnAffected(list) {
  if (!list?.length) return;
  modal({
    title: 'มีคำขอที่ได้รับผลกระทบ', hideSubmit: true, cancelLabel: 'ปิด',
    body: `<p>รถคันนี้มีคำขอที่ยังค้างอยู่ในช่วงเวลาดังกล่าว กรุณาเปลี่ยนรถหรือแจ้งผู้ขอ</p>
      <ul>${list.map((b) => `<li><a href="#/requests/${b.id}">${esc(b.code)}</a> ${bBadge(b.status)} ${esc(fmtRange(b.start_at, b.end_at))}</li>`).join('')}</ul>`,
  });
}

async function vehicleForm(v = null) {
  const types = S.types.filter((t) => t.active || t.id === v?.type_id);
  const r = await modal({
    title: v ? `แก้ไขข้อมูลรถ ${v.plate}` : 'เพิ่มรถ',
    body: `<div class="form-grid">
      <label class="field"><span>ทะเบียนรถ <b class="req">*</b></span><input name="plate" required value="${esc(v?.plate)}" placeholder="เช่น กข 1234 กรุงเทพมหานคร"></label>
      <label class="field"><span>ประเภทรถ <b class="req">*</b></span><select name="type_id" required>${types.map((t) => `<option value="${t.id}" ${t.id === v?.type_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      <label class="field"><span>ยี่ห้อ</span><input name="brand" value="${esc(v?.brand)}"></label>
      <label class="field"><span>รุ่น</span><input name="model" value="${esc(v?.model)}"></label>
      <label class="field"><span>จำนวนที่นั่ง <b class="req">*</b></span><input name="seats" type="number" min="1" max="100" required value="${esc(v?.seats ?? 4)}"></label>
      <label class="field"><span>สี</span><input name="color" value="${esc(v?.color)}"></label>
      <label class="field"><span>พนักงานขับรถประจำ</span><input name="driver_name" value="${esc(v?.driver_name)}" ${driverAttrs}></label>
      <label class="field"><span>เบอร์โทรพนักงานขับรถ</span><input name="driver_phone" value="${esc(v?.driver_phone)}"></label>
      <label class="field"><span>เลขไมล์ปัจจุบัน (กม.)</span><input name="mileage" type="number" min="0" value="${esc(v?.mileage ?? '')}"></label>
      <label class="field"><span>เลขลำดับเอกสารเริ่มต้น</span><input name="seq_start" type="number" min="1" value="${esc(v?.seq_start ?? 1)}"><small>${v ? `เลขถัดไปของรถคันนี้: <b>${v.next_seq}</b> · ` : ''}ใช้เมื่อเคยออกเลขด้วยกระดาษไปแล้ว เช่น ใส่ 58 ถ้าใบล่าสุดคือ 57</small></label>
      <label class="field full"><span>หมายเหตุ</span><textarea name="note">${esc(v?.note)}</textarea></label>
    </div>`,
    onOpen: (box) => box.driver_name.addEventListener('change', () => {
      const p = S.people.find((x) => x.name === box.driver_name.value.trim());
      if (p && p.phone) box.driver_phone.value = p.phone;
    }),
    onSubmit: (f) => api(v ? 'PUT' : 'POST', v ? `/api/vehicles/${v.id}` : '/api/vehicles', formData(f)),
  });
  if (r) { toast(v ? 'บันทึกข้อมูลรถแล้ว' : 'เพิ่มรถแล้ว'); route(); }
}

async function maintenanceDialog(vehicleId) {
  const v = await api('GET', `/api/vehicles/${vehicleId}`);
  const now = new Date().toISOString();
  const rows = v.maintenance.map((m) => {
    const ongoing = Date.parse(m.start_at) <= Date.now() && (!m.end_at || Date.parse(m.end_at) > Date.now());
    return `<li style="margin-bottom:10px">
      <b>${esc(fmtDateTime(m.start_at))}</b> ถึง <b>${m.end_at ? esc(fmtDateTime(m.end_at)) : 'ยังไม่กำหนด'}</b>
      ${ongoing ? '<span class="badge st-unavailable">กำลังซ่อม</span>' : ''}${demoTag(m)}
      <div>${esc(m.description)}</div>
      <div class="row" style="gap:6px;margin-top:4px">
        ${ongoing ? `<button type="button" class="btn btn-sm" data-mdone="${m.id}">ซ่อมเสร็จแล้ว (บันทึกเวลาปัจจุบัน)</button>` : ''}
        <button type="button" class="btn btn-sm btn-danger" data-mdel="${m.id}">ลบ</button>
      </div></li>`;
  }).join('');
  const r = await modal({
    title: `ซ่อมบำรุง · ${v.plate}`, submitLabel: 'บันทึกการซ่อมบำรุง',
    body: `
      <div>${rows ? `<ul style="padding-left:18px;margin:0">${rows}</ul>` : '<p class="muted">ยังไม่มีประวัติการซ่อมบำรุง</p>'}</div>
      <hr style="border:0;border-top:1px solid var(--line);width:100%">
      <h3>บันทึกการซ่อมบำรุงใหม่</h3>
      <div class="form-grid">
        <label class="field"><span>เริ่ม <b class="req">*</b></span><input type="datetime-local" name="start_at" required value="${toLocalInput(now)}"></label>
        <label class="field"><span>คาดว่าจะเสร็จ</span><input type="datetime-local" name="end_at"><small>เว้นว่าง = ยังไม่กำหนด (รถจะไม่พร้อมใช้งานจนกว่าจะบันทึกว่าเสร็จ)</small></label>
        <label class="field full"><span>รายละเอียด <b class="req">*</b></span><textarea name="description" required placeholder="เช่น เปลี่ยนถ่ายน้ำมันเครื่อง ตรวจเช็กระยะ"></textarea></label>
      </div>`,
    onOpen: (box) => {
      box.addEventListener('click', async (e) => {
        const done = e.target.closest('[data-mdone]'), del = e.target.closest('[data-mdel]');
        try {
          if (done) { await api('PUT', `/api/maintenance/${done.dataset.mdone}`, { end_at: new Date().toISOString() }); toast('บันทึกว่าซ่อมเสร็จแล้ว รถพร้อมใช้งาน'); }
          else if (del) { await api('DELETE', `/api/maintenance/${del.dataset.mdel}`); toast('ลบรายการซ่อมบำรุงแล้ว'); }
          else return;
          $('#modal').close(); maintenanceDialog(vehicleId); route();
        } catch (err) { showError(err); }
      });
    },
    onSubmit: (f) => {
      const d = formData(f);
      return api('POST', `/api/vehicles/${vehicleId}/maintenance`, { start_at: fromLocalInput(d.start_at), end_at: d.end_at ? fromLocalInput(d.end_at) : null, description: d.description });
    },
  });
  if (r && r !== true) { toast('บันทึกการซ่อมบำรุงแล้ว'); warnAffected(r.warnings); route(); }
}

// =====================================================================
// ปฏิทินคิวรถ (ตารางรายสัปดาห์ / รายการ)
// =====================================================================
const cal = { start: null, mode: window.innerWidth < 760 ? 'list' : 'grid', type_id: '', vehicle: '' };

async function viewSchedule(query) {
  if (query.vehicle) cal.vehicle = query.vehicle;
  if (!cal.start) {
    const today = bkkDayStart();
    const dow = bkkParts(today).dow; // 0 = อาทิตย์
    cal.start = bkkDayStart(today, -((dow + 6) % 7)); // เริ่มวันจันทร์
  }
  const days = Array.from({ length: 7 }, (_, i) => bkkDayStart(cal.start, i));
  const end = bkkDayStart(cal.start, 7);
  const data = await api('GET', `/api/schedule?from=${encodeURIComponent(cal.start)}&to=${encodeURIComponent(end)}`);
  const todayKey = bkkDayStart();
  let vehicles = data.vehicles.filter((v) => (!cal.type_id || String(v.type_id) === cal.type_id) && (!cal.vehicle || String(v.id) === cal.vehicle));
  const vIds = new Set(vehicles.map((v) => v.id));
  const selType = typeName(Number(cal.type_id));
  // คำขอที่ยังไม่ระบุรถ แสดงเมื่อไม่ได้กรองรายคัน (และตรงประเภทถ้ากรองประเภท)
  const bookings = data.bookings.filter((b) => (b.vehicle_id ? vIds.has(b.vehicle_id) : !cal.vehicle && (!cal.type_id || b.type_name === selType)));
  const maint = data.maintenance.filter((m) => vIds.has(m.vehicle_id));
  vehicles = vehicles.filter((v) => v.active || bookings.some((b) => b.vehicle_id === v.id) || maint.some((m) => m.vehicle_id === v.id));
  const unassigned = bookings.filter((b) => !b.vehicle_id);

  app.innerHTML = `
    <div class="page-head">
      <div><h1>ตารางคิวรถรายสัปดาห์</h1><p>ช่วงเวลาที่รถถูกจอง กำลังใช้งาน หรือซ่อมบำรุง แยกตามรถแต่ละคัน</p></div>
      <a class="btn btn-primary" href="#/book">${ICON.plus} จองรถ</a>
    </div>
    <div class="cal-toolbar">
      <button class="btn btn-sm" id="prevW" aria-label="สัปดาห์ก่อน">‹ ก่อนหน้า</button>
      <button class="btn btn-sm" id="todayW">สัปดาห์นี้</button>
      <button class="btn btn-sm" id="nextW" aria-label="สัปดาห์ถัดไป">ถัดไป ›</button>
      <span class="range">${esc(fmtDate(cal.start))} – ${esc(fmtDate(days[6]))}</span>
      <span class="spacer"></span>
      <select class="input" id="calType" style="width:auto"><option value="">ทุกประเภท</option>${S.types.map((t) => `<option value="${t.id}" ${String(t.id) === cal.type_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      <select class="input" id="calVeh" style="width:auto"><option value="">ทุกคัน</option>${data.vehicles.map((v) => `<option value="${v.id}" ${String(v.id) === cal.vehicle ? 'selected' : ''}>${esc(v.plate)}</option>`).join('')}</select>
      <div class="tabs" style="margin:0;border:0">
        <button class="${cal.mode === 'grid' ? 'on' : ''}" data-mode="grid">ตาราง</button>
        <button class="${cal.mode === 'list' ? 'on' : ''}" data-mode="list">รายการ</button>
      </div>
    </div>
    <div id="calBody"></div>
    <div class="legend">
      <span><i class="ev pending"></i>รออนุมัติ</span><span><i class="ev approved"></i>อนุมัติ</span>
      <span><i class="ev completed"></i>เสร็จสิ้น</span><span><i class="ev maint"></i>ซ่อมบำรุง</span><span><i class="ev unassigned"></i>ยังไม่ระบุรถ</span>
    </div>
    ${!isAdmin() ? '<p class="faint" style="margin-top:8px">คำขอของผู้อื่นแสดงเฉพาะช่วงเวลาและหน่วยงาน เพื่อความเป็นส่วนตัว</p>' : ''}`;

  const shift = (n) => { cal.start = bkkDayStart(cal.start, n); viewSchedule({}); };
  $('#prevW').onclick = () => shift(-7);
  $('#nextW').onclick = () => shift(7);
  $('#todayW').onclick = () => { cal.start = null; viewSchedule({}); };
  $('#calType').onchange = (e) => { cal.type_id = e.target.value; viewSchedule({}); };
  $('#calVeh').onchange = (e) => { cal.vehicle = e.target.value; if (!e.target.value) history.replaceState(null, '', '#/schedule'); viewSchedule({}); };
  $$('[data-mode]').forEach((b) => (b.onclick = () => { cal.mode = b.dataset.mode; viewSchedule({}); }));

  const evHtml = (item, day) => {
    const dayEnd = bkkDayStart(day, 1);
    const s = Date.parse(item.start_at) < Date.parse(day) ? '00:00' : fmtTime(item.start_at);
    const e = !item.end_at || Date.parse(item.end_at) > Date.parse(dayEnd) ? '24:00' : fmtTime(item.end_at);
    if (item.kind === 'maint') return `<span class="ev maint" title="${esc(item.description)}">${s}–${e} ซ่อมบำรุง</span>`;
    const label = `${s}–${e} ${item.can_view ? esc(item.destination || '') : esc(item.requester_department || 'จองแล้ว')}`;
    const cls = `ev ${item.vehicle_id ? item.status : 'unassigned'}`;
    const title = `${item.code} · ${BOOKING_STATUS[item.status]}`;
    return item.can_view ? `<a class="${cls}" href="#/requests/${item.id}" title="${esc(title)}">${label}</a>` : `<span class="${cls}" title="${esc(title)}">${label}</span>`;
  };
  const inDay = (item, day) => Date.parse(item.start_at) < Date.parse(bkkDayStart(day, 1)) && (!item.end_at || Date.parse(item.end_at) > Date.parse(day));
  const allItems = [...bookings.map((b) => ({ ...b, kind: 'booking' })), ...maint.map((m) => ({ ...m, kind: 'maint' }))];

  if (cal.mode === 'grid') {
    const rows = [...vehicles.map((v) => ({ v, items: allItems.filter((i) => i.vehicle_id === v.id) }))];
    if (unassigned.length) rows.push({ v: { plate: 'ยังไม่ระบุรถ', type_name: 'รอผู้ดูแลจัดรถ' }, items: unassigned.map((b) => ({ ...b, kind: 'booking' })) });
    $('#calBody').innerHTML = rows.length ? `<div class="cal-wrap"><div class="cal" style="grid-template-columns: 170px repeat(7, minmax(110px, 1fr))">
      <div class="h v">รถ</div>${days.map((d) => `<div class="h ${d === todayKey ? 'today' : ''}">${esc(fmtDayShort(d))}</div>`).join('')}
      ${rows.map(({ v, items }) => `<div class="v"><b>${esc(v.plate)}</b><span class="faint">${esc(v.type_name)}${v.seats ? ` · ${v.seats} ที่นั่ง` : ''}</span>${v.active === 0 ? ' <span class="tag tag-gray">ปิดใช้งาน</span>' : ''}</div>
        ${days.map((d) => `<div class="cell ${d === todayKey ? 'today' : ''}">${items.filter((i) => inDay(i, d)).map((i) => evHtml(i, d)).join('')}</div>`).join('')}`).join('')}
    </div></div>` : empty('ไม่มีรถตามเงื่อนไขที่เลือก');
  } else {
    const groups = days.map((d) => ({ d, items: allItems.filter((i) => inDay(i, d) && (i.kind === 'maint' || !i.vehicle_id || vIds.has(i.vehicle_id))) }));
    $('#calBody').innerHTML = groups.some((g) => g.items.length) ? groups.filter((g) => g.items.length).map((g) => `
      <div class="day-group"><h3>${esc(fmtDateLong(g.d))}${g.d === todayKey ? ' · วันนี้' : ''}</h3>
      <div class="card">${g.items.map((i) => {
        const time = `${Date.parse(i.start_at) < Date.parse(g.d) ? '(ต่อ) ' : ''}${fmtTime(i.start_at)}–${i.end_at ? fmtTime(i.end_at) : '…'} น.`;
        if (i.kind === 'maint') return `<div class="agenda-item"><span class="time">${time}</span><span><b>${esc(i.plate)}</b> · ซ่อมบำรุง: ${esc(i.description)}</span><span class="badge st-unavailable">ไม่พร้อมใช้งาน</span></div>`;
        const inner = `<span class="time">${time}</span><span><b>${esc(vehicleName(i))}</b> · ${i.can_view ? esc(`${i.destination} (${i.requester_name})`) : esc(i.requester_department || 'จองแล้ว')}<br><span class="faint">${esc(i.code)}</span></span>${bBadge(i.status)}`;
        return i.can_view ? `<a class="agenda-item" href="#/requests/${i.id}">${inner}</a>` : `<div class="agenda-item">${inner}</div>`;
      }).join('')}</div></div>`).join('') : empty('ไม่มีคิวรถในสัปดาห์นี้');
  }
}

// =====================================================================
// แบบฟอร์มจองรถ
// =====================================================================
async function viewBook(query) {
  const u = getLastRequester() || { name: '', position: '', department: '', phone: '' };
  const vehicles = (await api('GET', '/api/vehicles')).filter((v) => v.active);
  const preV = vehicles.find((v) => String(v.id) === query.vehicle);
  const tomorrow = toLocalInput(bkkDayStart(undefined, 1)).slice(0, 11);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(query.date || '') ? query.date : tomorrow.slice(0, 10);
  let start = query.start ? toLocalInput(query.start) : `${day}T08:30`;
  let end = query.end ? toLocalInput(query.end) : `${day}T16:30`;
  if (!query.start && Date.parse(fromLocalInput(start)) < Date.now()) {
    // จองวันนี้แต่เลย 08:30 แล้ว → เริ่มครึ่งชั่วโมงถัดไป อย่างน้อย 2 ชั่วโมง
    const s = Math.ceil((Date.now() + 5 * 60e3) / 1800e3) * 1800e3;
    start = toLocalInput(new Date(s).toISOString());
    if (Date.parse(fromLocalInput(end)) < s + 2 * 3600e3) end = toLocalInput(new Date(s + 2 * 3600e3).toISOString());
  }
  const types = S.types.filter((t) => t.active);
  const selType = preV ? preV.type_id : types[0]?.id;
  const staff = S.people.filter((p) => p.active && p.is_staff);
  const presetSelect = (kind) => {
    const items = S.presets.filter((p) => p.kind === kind);
    return items.length ? `<select class="input preset-pick" data-preset="${kind}" aria-label="เลือกจากรายการที่ใช้บ่อย"><option value="">— เลือกจากรายการที่ใช้บ่อย —</option>${items.map((p) => `<option value="${esc(p.text)}">${esc(p.text)}</option>`).join('')}</select>` : '';
  };

  app.innerHTML = `
    <div class="page-head"><div><h1>แบบฟอร์มขอใช้รถ</h1><p>${needApproval() ? 'กรอกข้อมูลให้ครบ ระบบจะตรวจว่ารถว่างก่อนส่งคำขอให้ผู้ดูแลอนุมัติ' : 'กรอกข้อมูลแล้วเลือกรถที่ว่าง กดยืนยันแล้วจองสำเร็จทันที ไม่ต้องรออนุมัติ'}</p></div></div>
    <form id="bookForm" novalidate>
      <section class="card form-section">
        <h2><span class="step">1</span>ผู้ขออนุญาต</h2>
        <div class="form-grid">
          ${staff.length ? `<label class="field full"><span>เลือกจากรายชื่อบุคลากร</span><select class="input" id="pickPerson"><option value="">— กรอกเอง —</option>${staff.map((p) => `<option value="${p.id}" ${p.name === u.name ? 'selected' : ''}>${esc(p.name)}${p.position ? ` · ${esc(p.position)}` : ''}</option>`).join('')}</select><small>เลือกแล้วระบบเติมตำแหน่ง ฝ่าย และเบอร์โทรให้ (แก้ไขต่อได้)</small></label>` : ''}
          <label class="field"><span>ชื่อ-นามสกุล <b class="req">*</b></span><input name="requester_name" required value="${esc(u.name)}"></label>
          <label class="field"><span>ตำแหน่ง</span><input name="requester_position" value="${esc(u.position)}"></label>
          <label class="field"><span>ฝ่าย/สังกัด <b class="req">*</b></span><input name="requester_department" required value="${esc(u.department)}"></label>
          <label class="field"><span>เบอร์โทรติดต่อ</span><input name="requester_phone" type="tel" value="${esc(u.phone)}"></label>
        </div>
      </section>
      <section class="card form-section">
        <h2><span class="step">2</span>รายละเอียดการเดินทาง</h2>
        <div class="form-grid">
          <div class="field full"><span>สถานที่ไป/จุดหมาย <b class="req">*</b></span>${presetSelect('destination')}<input name="destination" required placeholder="เช่น ศาลากลางจังหวัดเชียงใหม่"></div>
          <div class="field full"><span>วัตถุประสงค์/เหตุผล <b class="req">*</b></span>${presetSelect('purpose')}<textarea name="purpose" required placeholder="เช่น ประชุม… / นำส่งหนังสือราชการ…"></textarea></div>
          <label class="field full"><span>ผู้ร่วมเดินทาง</span><textarea name="companions" placeholder="ระบุชื่อผู้ร่วมเดินทาง คั่นด้วยเครื่องหมายจุลภาค หรือขึ้นบรรทัดใหม่"></textarea></label>
          <label class="field"><span>จำนวนผู้เดินทางทั้งหมด (รวมผู้ขอ) <b class="req">*</b></span><input name="passenger_count" type="number" min="1" max="100" required value="1" inputmode="numeric"></label>
          <label class="field" style="justify-content:flex-end"><span class="check"><input type="checkbox" name="need_driver" checked> ต้องการพนักงานขับรถ</span></label>
          <label class="field"><span>วันเวลาออกเดินทาง <b class="req">*</b></span><input name="start_at" type="datetime-local" required value="${start}"></label>
          <label class="field"><span>วันเวลากลับ <b class="req">*</b></span><input name="end_at" type="datetime-local" required value="${end}"></label>
          <div class="full faint" id="durNote"></div>
        </div>
      </section>
      <section class="card form-section">
        <h2><span class="step">3</span>ประเภทรถและรถที่ต้องการ</h2>
        <div class="field"><span>ประเภทรถ <b class="req">*</b></span>
          <div class="type-options">
            ${types.map((t) => `<label><input type="radio" name="type_id" value="${t.id}" ${t.id === selType ? 'checked' : ''}> ${esc(t.name)}</label>`).join('')}
            ${needApproval() ? '<label><input type="radio" name="type_id" value="other"> อื่น ๆ</label>' : ''}
          </div>
        </div>
        <label class="field" id="typeOtherWrap" hidden style="margin-top:10px"><span>ระบุประเภทรถ</span><input name="type_other" placeholder="เช่น รถบรรทุก 6 ล้อ"></label>
        <div class="info-box" style="margin-top:14px">${dayMode() ? 'รถ 1 คันจองได้ 1 รายการต่อวัน — คันที่มีคนจองในวันนั้นแล้วจะเลือกไม่ได้' : 'ช่วงเวลาที่จองต้องไม่ทับกับการจองอื่นของรถคันเดียวกัน'}</div>
        <div class="field" style="margin-top:14px"><span>เลือกรถ${needApproval() ? '' : ' <b class="req">*</b>'}</span><div id="vpick" class="vpick"></div></div>
      </section>
      <section class="card form-section">
        <h2><span class="step">4</span>ข้อมูลประกอบอื่น ๆ</h2>
        <label class="field"><span>หมายเหตุ</span><textarea name="note" placeholder="เช่น ต้องการรถที่มีที่วางสัมภาระ / จุดรับ-ส่ง / เบอร์ผู้ประสานงานปลายทาง"></textarea></label>
      </section>
      <div id="formError" style="margin-top:16px"></div>
      <div class="form-actions">
        <a class="btn" href="#/">ยกเลิก</a>
        <button class="btn btn-primary" type="submit" id="submitBtn">${needApproval() ? 'ส่งคำขอใช้รถ' : 'ยืนยันการจอง'}</button>
      </div>
    </form>`;

  const f = $('#bookForm');
  let chosen = preV ? String(preV.id) : '';
  $('#pickPerson')?.addEventListener('change', (e) => {
    const p = staff.find((x) => String(x.id) === e.target.value);
    if (!p) return;
    f.requester_name.value = p.name; f.requester_position.value = p.position;
    f.requester_department.value = p.department; f.requester_phone.value = p.phone;
  });
  f.querySelectorAll('select[data-preset]').forEach((sel) => sel.addEventListener('change', () => {
    if (sel.value) { f[sel.dataset.preset].value = sel.value; sel.value = ''; }
  }));
  let seq = 0;

  async function refreshVehicles() {
    const my = ++seq;
    const type = f.type_id.value;
    $('#typeOtherWrap').hidden = type !== 'other';
    const s = fromLocalInput(f.start_at.value), e = fromLocalInput(f.end_at.value);
    const pax = Number(f.passenger_count.value) || 1;
    const durOk = s && e && Date.parse(e) > Date.parse(s);
    $('#durNote').innerHTML = !s || !e ? '' : durOk
      ? `ระยะเวลา ${fmtDuration(Date.parse(e) - Date.parse(s))} · ${esc(fmtRange(s, e))}`
      : '<span style="color:var(--danger)">วันเวลากลับต้องอยู่หลังวันเวลาออกเดินทาง</span>';
    const list = type === 'other' ? [] : vehicles.filter((v) => String(v.type_id) === type);
    const checks = durOk ? await Promise.all(list.map((v) => api('POST', '/api/availability', { vehicle_id: v.id, start_at: s, end_at: e }).catch((err) => ({ available: false, conflicts: [{ message: err.message }] })))) : [];
    if (my !== seq) return; // มีการเปลี่ยนค่าระหว่างรอผล
    if (chosen && !list.some((v) => String(v.id) === chosen)) chosen = '';
    const items = list.map((v, i) => {
      const c = checks[i];
      const seatsOk = v.seats >= pax;
      const ok = durOk && c?.available && seatsOk;
      if (!ok && String(v.id) === chosen) chosen = '';
      const why = !durOk ? 'เลือกช่วงเวลาก่อน' : !c?.available ? c.conflicts.map((x) => x.message).join(' · ') : !seatsOk ? `ที่นั่งไม่พอ (${v.seats} ที่นั่ง)` : '';
      return `<label class="${ok ? '' : 'disabled'}"><input type="radio" name="vehicle_id" value="${v.id}" ${ok ? '' : 'disabled'} ${String(v.id) === chosen ? 'checked' : ''}>
        <span><b>${esc(v.plate)}</b>${demoTag(v)}<br><span class="faint">${esc(v.brand)} ${esc(v.model)} · ${v.seats} ที่นั่ง${v.driver_name ? ` · ${esc(v.driver_name)}` : ''}</span>
        ${ok ? '<div class="ok">✓ ว่างในช่วงเวลานี้</div>' : `<div class="why">ไม่ว่าง: ${esc(why)}</div>`}</span></label>`;
    });
    const anyOption = needApproval() ? `<label><input type="radio" name="vehicle_id" value="" ${chosen ? '' : 'checked'}><span><b>ไม่ระบุคัน</b><br><span class="faint">ให้ผู้ดูแลจัดรถตามประเภทที่เลือก</span></span></label>` : '';
    $('#vpick').innerHTML = `${anyOption}${items.join('')}
      ${type !== 'other' && !list.length ? `<p class="faint">ยังไม่มีรถประเภทนี้ในระบบ${needApproval() ? ' ผู้ดูแลจะพิจารณาจัดรถให้' : ''}</p>` : ''}`;
  }
  f.addEventListener('change', (e) => {
    if (e.target.name === 'vehicle_id') { chosen = e.target.value; return; }
    if (['type_id', 'start_at', 'end_at', 'passenger_count'].includes(e.target.name)) refreshVehicles();
  });
  f.passenger_count.addEventListener('input', debounce(refreshVehicles, 400));
  refreshVehicles();

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(f);
    const missing = [['requester_name', 'ชื่อผู้ขอ'], ['requester_department', 'ฝ่าย/สังกัด'], ['destination', 'สถานที่ไป'], ['purpose', 'วัตถุประสงค์'], ['start_at', 'วันเวลาออกเดินทาง'], ['end_at', 'วันเวลากลับ']]
      .filter(([k]) => !String(d[k] || '').trim());
    if (missing.length) {
      $('#formError').innerHTML = `<div class="conflict-box">กรุณากรอก: ${esc(missing.map(([, l]) => l).join(', '))}</div>`;
      f[missing[0][0]].focus();
      return;
    }
    if (!needApproval() && !chosen) {
      $('#formError').innerHTML = '<div class="conflict-box">กรุณาเลือกรถที่ว่างในวันที่ต้องการ</div>';
      $('#vpick').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const body = {
      ...d, need_driver: f.need_driver.checked, start_at: fromLocalInput(d.start_at), end_at: fromLocalInput(d.end_at),
      type_id: d.type_id === 'other' ? '' : d.type_id, type_other: d.type_id === 'other' ? d.type_other : '', vehicle_id: chosen || '',
    };
    $('#submitBtn').disabled = true; $('#formError').innerHTML = '';
    try {
      const b = await api('POST', '/api/bookings', body);
      addToken(b.owner_token); // ให้เครื่องนี้ดู/ยกเลิก/พิมพ์การจองนี้ได้
      setLastRequester({ name: body.requester_name, position: body.requester_position, department: body.requester_department, phone: body.requester_phone });
      toast(b.status === 'pending' ? `ส่งคำขอเรียบร้อย เลขที่ ${b.code} (รออนุมัติ)` : `จองรถ ${b.plate} สำเร็จ เลขที่ ${b.code}`);
      location.hash = `#/requests/${b.id}`;
    } catch (err) {
      $('#formError').innerHTML = err.data?.conflicts ? conflictHtml(err) + '<p class="faint">กรุณาเลือกช่วงเวลาอื่น หรือเลือกรถคันอื่นที่ว่าง</p>' : `<div class="conflict-box">${esc(err.message)}</div>`;
      $('#formError').scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (err.data?.conflicts) refreshVehicles();
    } finally { $('#submitBtn').disabled = false; }
  });
}

function fmtDuration(ms) {
  const min = Math.round(ms / 60000), d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return [d && `${d} วัน`, h && `${h} ชั่วโมง`, m && `${m} นาที`].filter(Boolean).join(' ') || '0 นาที';
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// =====================================================================
// รายการคำขอ
// =====================================================================
const reqState = { status: '', q: '', mine: false };

async function viewRequests(query) {
  if (query.status !== undefined) reqState.status = query.status;
  const admin = isAdmin();
  app.innerHTML = `
    <div class="page-head">
      <div><h1>${admin ? 'การจองทั้งหมด' : 'การจองของฉัน'}</h1><p>${admin ? (needApproval() ? 'พิจารณาอนุมัติ กำหนดรถ และติดตามสถานะ' : 'ติดตาม ยกเลิก และบันทึกการใช้รถ') : 'ติดตามและยกเลิกการจองของคุณ'}</p></div>
      <a class="btn btn-primary" href="#/book">${ICON.plus} จองรถ</a>
    </div>
    <div class="row" style="margin-bottom:12px">
      <input class="input" id="rq" type="search" placeholder="ค้นหาเลขที่คำขอ ชื่อผู้ขอ ปลายทาง หรือทะเบียนรถ" value="${esc(reqState.q)}" style="flex:1;min-width:220px">
      ${admin ? '' : '<span class="faint">แสดงเฉพาะการจองที่ทำจากเครื่องนี้ · ถ้าจองจากเครื่องอื่นหรือล้างข้อมูลเบราว์เซอร์ ติดต่อผู้ดูแลเพื่อดูหรือยกเลิก</span>'}
    </div>
    <div class="tabs" id="rtabs"></div>
    <div id="rlist"><div class="loading">กำลังโหลด…</div></div>`;

  let all = [];
  async function load() {
    const p = new URLSearchParams({ q: reqState.q });
    all = await api('GET', '/api/bookings?' + p);
    render();
  }
  function render() {
    const counts = Object.fromEntries(Object.keys(BOOKING_STATUS).map((k) => [k, all.filter((b) => b.status === k).length]));
    // โหมดไม่ต้องอนุมัติ: ซ่อนแท็บรออนุมัติ/ไม่อนุมัติ (ยกเว้นมีข้อมูลเก่าค้างอยู่)
    const shown = Object.entries(BOOKING_STATUS).filter(([k]) => needApproval() || !['pending', 'rejected'].includes(k) || counts[k]);
    $('#rtabs').innerHTML = [['', 'ทั้งหมด', all.length], ...shown.map(([k, l]) => [k, l, counts[k]])]
      .map(([k, l, n]) => `<button class="${reqState.status === k ? 'on' : ''}" data-s="${k}">${l}<span class="c">${n}</span></button>`).join('');
    const rows = all.filter((b) => !reqState.status || b.status === reqState.status);
    $('#rlist').innerHTML = !rows.length ? empty('ไม่มีคำขอในหมวดนี้') : `
      <div class="card table-wrap hide-sm"><table class="table">
        <thead><tr><th>เลขที่</th><th>ผู้ขอ</th><th>จุดหมาย</th><th>วันเวลาเดินทาง</th><th>รถ</th><th>สถานะ</th><th></th></tr></thead>
        <tbody>${rows.map((b) => `<tr class="clickable" data-href="#/requests/${b.id}">
          <td><b>${esc(b.code)}</b>${demoTag(b)}<div class="faint">${esc(fmtDate(b.created_at))}</div></td>
          <td>${esc(b.requester_name)}<div class="faint">${esc(b.requester_department)}</div></td>
          <td>${esc(b.destination)}<div class="faint">${b.passenger_count} คน</div></td>
          <td>${esc(fmtRange(b.start_at, b.end_at))}</td>
          <td>${b.plate ? esc(b.plate) : `<span class="faint">ยังไม่ระบุ (${esc(b.type_name || b.type_other)})</span>`}</td>
          <td>${bBadge(b.status)}${b.overdue ? '<div class="faint" style="color:var(--danger)">เลยกำหนดกลับ</div>' : ''}</td>
          <td><a class="btn btn-sm" href="#/requests/${b.id}">เปิด</a></td>
        </tr>`).join('')}</tbody></table></div>
      <div class="req-list show-sm">${rows.map((b) => `<a class="card req-item" href="#/requests/${b.id}">
        <span><span class="code">${esc(b.code)}</span>${demoTag(b)}<div class="dest">${esc(b.destination)}</div></span>${bBadge(b.status)}
        <span class="sub">${esc(fmtRange(b.start_at, b.end_at))}<br>${esc(vehicleName(b))} · ${esc(b.requester_name)}</span></a>`).join('')}</div>`;
  }
  $('#rtabs').addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (b) { reqState.status = b.dataset.s; render(); } });
  $('#rlist').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-href]'); if (tr && !e.target.closest('a')) location.hash = tr.dataset.href; });
  $('#rq').addEventListener('input', debounce((e) => { reqState.q = e.target.value; load(); }, 300));
  await load();
}

// =====================================================================
// รายละเอียดคำขอ + การอนุมัติ + บันทึกการใช้รถ + พิมพ์
// =====================================================================
async function viewRequestDetail(id) {
  const b = await api('GET', `/api/bookings/${id}`);
  const admin = isAdmin();
  const owner = !admin; // ผู้ไม่ได้ล็อกอินเปิดได้เฉพาะการจองของตน (ถือรหัสลับ)
  const departed = !!b.depart_at;
  const actions = [];
  actions.push(`<a class="btn btn-primary" href="print.html?id=${b.id}" target="_blank" rel="noopener">${ICON.print} ดูตัวอย่าง / พิมพ์เอกสาร</a>`);
  if (admin && b.status === 'pending') {
    actions.push('<button class="btn btn-success" data-a="approve">อนุมัติ…</button>', '<button class="btn btn-danger" data-a="reject">ไม่อนุมัติ…</button>');
  }
  if (admin && ['pending', 'approved'].includes(b.status) && !departed) actions.push(`<button class="btn" data-a="assign">${b.vehicle_id ? 'เปลี่ยนรถ/พนักงานขับรถ' : 'กำหนดรถ'}…</button>`);
  if (admin && ['approved', 'completed'].includes(b.status) && b.vehicle_id) actions.push(`<button class="btn" data-a="trip">${departed ? 'แก้ไขบันทึกการใช้รถ' : 'บันทึกการใช้รถ'}…</button>`);
  if (admin && b.status === 'approved' && (!departed || b.return_at)) actions.push('<button class="btn" data-a="complete">ปิดงาน (เสร็จสิ้น)</button>');
  if ((admin || owner) && ['pending', 'approved'].includes(b.status) && !departed) actions.push('<button class="btn btn-danger" data-a="cancel">ยกเลิกการจอง…</button>');

  const decisionBox = b.status === 'rejected'
    ? `<div class="decision st-unavailable"><b>เหตุผลที่ไม่อนุมัติ:</b> ${esc(b.decision_note)}<div class="faint">โดย ${esc(b.decided_by_name || '-')} · ${esc(fmtDateTime(b.decided_at))}</div></div>`
    : ['approved', 'completed'].includes(b.status) && !b.decided_by
      ? '<div class="decision st-available"><b>จองสำเร็จ</b> — ยืนยันอัตโนมัติ ไม่ต้องรออนุมัติ</div>'
    : ['approved', 'completed'].includes(b.status) && b.decided_at
      ? `<div class="decision st-available"><b>อนุมัติแล้ว</b>${b.decision_note ? `: ${esc(b.decision_note)}` : ''}<div class="faint">โดย ${esc(b.decided_by_name || '-')} · ${esc(fmtDateTime(b.decided_at))}</div></div>`
      : b.status === 'cancelled'
        ? `<div class="decision bs-cancelled"><b>ยกเลิก:</b> ${esc(b.cancel_reason)}</div>`
        : '<div class="decision st-booked"><b>รอผู้ดูแลพิจารณา</b></div>';

  app.innerHTML = `
    <div class="page-head">
      <div>
        <a href="#/requests" class="faint">← กลับไปหน้าการจอง</a>
        <h1 style="margin-top:4px">การจองเลขที่ ${esc(b.code)} ${demoTag(b)}</h1>
        <p>ยื่นเมื่อ ${esc(fmtDateTime(b.created_at))}</p>
      </div>
      <div>${bBadge(b.status)}</div>
    </div>
    <div class="detail-layout">
      <div class="stack">
        <section class="card card-pad">
          <h2 style="margin-bottom:12px">รายละเอียดคำขอ</h2>
          <dl class="kv">
            <dt>ผู้ขออนุญาต</dt><dd>${esc(b.requester_name)}${b.requester_phone ? ` · โทร ${esc(b.requester_phone)}` : ''}</dd>
            <dt>ตำแหน่ง</dt><dd>${esc(b.requester_position || '-')}</dd>
            <dt>ฝ่าย/สังกัด</dt><dd>${esc(b.requester_department)}</dd>
            <dt>สถานที่ไป/จุดหมาย</dt><dd>${esc(b.destination)}</dd>
            <dt>วัตถุประสงค์/เหตุผล</dt><dd>${esc(b.purpose)}</dd>
            <dt>จำนวนผู้เดินทาง</dt><dd>${b.passenger_count} คน</dd>
            <dt>ผู้ร่วมเดินทาง</dt><dd>${esc(b.companions || '-')}</dd>
            <dt>ออกเดินทาง</dt><dd>${esc(fmtDateTime(b.start_at))}</dd>
            <dt>กลับ</dt><dd>${esc(fmtDateTime(b.end_at))}</dd>
            <dt>ประเภทรถ</dt><dd>${esc(b.type_name || b.type_other || '-')}${b.need_driver ? ' · ต้องการพนักงานขับรถ' : ' · ไม่ต้องการพนักงานขับรถ'}</dd>
            ${b.vehicle_seq ? `<dt>เลขที่ตามทะเบียนรถ</dt><dd><b>${b.vehicle_seq}</b> <span class="faint">(ลำดับที่ ${b.vehicle_seq} ของรถ ${esc(b.plate || '')})</span></dd>` : ''}
            <dt>รถที่ใช้</dt><dd>${b.plate ? `<b>${esc(b.plate)}</b> ${esc(b.brand)} ${esc(b.model)} (${b.vehicle_seats} ที่นั่ง)` : '<span class="faint">ยังไม่ระบุ — ผู้ดูแลจะจัดรถให้</span>'}</dd>
            <dt>พนักงานขับรถ</dt><dd>${esc(b.assigned_driver || b.vehicle_driver || '-')}</dd>
            ${b.note ? `<dt>หมายเหตุ</dt><dd>${esc(b.note)}</dd>` : ''}
          </dl>
        </section>
        <section class="card card-pad">
          <h2 style="margin-bottom:12px">${needApproval() ? 'ผลการพิจารณา' : 'สถานะการจอง'}</h2>
          ${decisionBox}
          ${b.overdue ? '<div class="conflict-box" style="margin-top:10px">เลยกำหนดเวลากลับแล้ว แต่ยังไม่ได้บันทึกขากลับ</div>' : ''}
        </section>
        <section class="card card-pad">
          <h2 style="margin-bottom:12px">บันทึกการใช้รถ</h2>
          ${departed ? `<div class="trip-summary">
              <div><span class="faint">ออกเดินทาง</span><div><b>${esc(fmtDateTime(b.depart_at))}</b></div><div class="faint">เลขไมล์ ${num(b.depart_mileage)}</div></div>
              <div><span class="faint">กลับถึง</span><div><b>${b.return_at ? esc(fmtDateTime(b.return_at)) : 'ยังไม่กลับ'}</b></div><div class="faint">เลขไมล์ ${num(b.return_mileage)}</div></div>
              <div><span class="faint">ระยะทางรวม</span><div class="big">${b.distance !== null ? `${num(b.distance)} กม.` : '-'}</div><div class="faint">ผู้ขับ ${esc(b.trip_driver || '-')}</div></div>
            </div>${b.trip_note ? `<p class="muted">หมายเหตุ: ${esc(b.trip_note)}</p>` : ''}`
          : `<p class="muted">${['approved'].includes(b.status) ? 'ยังไม่ได้บันทึกการออกเดินทาง' : 'จะบันทึกได้หลังคำขอได้รับอนุมัติ'}</p>`}
        </section>
      </div>
      <aside class="stack">
        <section class="card card-pad"><h3 style="margin-bottom:10px">การดำเนินการ</h3><div class="action-stack">${actions.join('')}</div>
          <p class="faint" style="margin:10px 0 0">เอกสารพิมพ์จะเติมข้อมูลจากคำขอให้อัตโนมัติ ส่วนความเห็น คำสั่งอนุมัติ และบันทึกการใช้รถเว้นว่างไว้ให้กรอกด้วยมือ</p></section>
        <section class="card card-pad"><h3 style="margin-bottom:12px">ประวัติการดำเนินการ</h3>
          <ul class="timeline">${b.events.map((ev) => `<li><b>${esc(EVENT_LABEL[ev.action] || ev.action)}</b> · ${esc(ev.user_name)}${ev.note ? `<div>${esc(ev.note)}</div>` : ''}<div class="when">${esc(fmtDateTime(ev.at))}</div></li>`).join('')}</ul>
        </section>
      </aside>
    </div>`;

  app.querySelector('.action-stack').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    try {
      let r;
      if (a === 'approve') r = await assignDialog(b, true);
      if (a === 'assign') r = await assignDialog(b, false);
      if (a === 'reject') {
        const reason = await reasonDialog('ไม่อนุมัติคำขอ', 'เหตุผลที่ไม่อนุมัติ (จะแจ้งให้ผู้ขอทราบ)', 'ยืนยันไม่อนุมัติ');
        if (reason) r = await api('POST', `/api/bookings/${b.id}/reject`, { reason });
      }
      if (a === 'cancel') {
        const reason = await reasonDialog('ยกเลิกการจอง', 'เหตุผลการยกเลิก', 'ยืนยันยกเลิก');
        if (reason) r = await api('POST', `/api/bookings/${b.id}/cancel`, { reason });
      }
      if (a === 'complete') {
        if (await confirmDialog('ปิดงาน', departed ? 'ยืนยันปิดงานคำขอนี้เป็น “เสร็จสิ้น”' : 'ยังไม่มีบันทึกการใช้รถ ต้องการปิดงานเป็น “เสร็จสิ้น” โดยไม่บันทึกเลขไมล์หรือไม่')) {
          r = await api('POST', `/api/bookings/${b.id}/complete`, {});
        }
      }
      if (a === 'trip') r = await tripDialog(b);
      if (r) { toast(`บันทึกเรียบร้อย · สถานะ: ${BOOKING_STATUS[r.status]}`); viewRequestDetail(b.id); refreshPendingBadge(); }
    } catch (err) { showError(err); }
  });
}

/** เลือกรถ (แสดงว่าคันไหนว่าง) และพนักงานขับรถ — ใช้ทั้งตอนอนุมัติและเปลี่ยนรถ */
async function assignDialog(b, approving) {
  const vehicles = (await api('GET', '/api/vehicles')).filter((v) => v.active);
  const checks = await Promise.all(vehicles.map((v) => api('POST', '/api/availability', { vehicle_id: v.id, start_at: b.start_at, end_at: b.end_at, exclude_booking_id: b.id })));
  const opts = vehicles.map((v, i) => ({ v, ok: checks[i].available && v.seats >= b.passenger_count, why: !checks[i].available ? checks[i].conflicts.map((c) => c.message).join(' · ') : v.seats < b.passenger_count ? `ที่นั่งไม่พอ (${v.seats})` : '' }))
    .sort((x, y) => (y.ok - x.ok) || ((y.v.type_id === b.type_id) - (x.v.type_id === b.type_id)));
  return modal({
    title: approving ? `อนุมัติคำขอ ${b.code}` : `กำหนดรถ · ${b.code}`,
    submitLabel: approving ? 'ยืนยันอนุมัติ' : 'บันทึก', submitClass: approving ? 'btn-success' : 'btn-primary',
    body: `
      <div class="info-box">${esc(fmtRange(b.start_at, b.end_at))} · ${b.passenger_count} คน · ขอ${esc(b.type_name || b.type_other)}</div>
      <div class="field"><span>เลือกรถ <b class="req">*</b></span><div class="vpick" style="grid-template-columns:1fr">
        ${opts.map(({ v, ok, why }) => `<label class="${ok ? '' : 'disabled'}"><input type="radio" name="vehicle_id" value="${v.id}" data-driver="${esc(v.driver_name)}" ${ok ? '' : 'disabled'} ${ok && v.id === b.vehicle_id ? 'checked' : ''}>
          <span><b>${esc(v.plate)}</b> <span class="faint">${esc(v.type_name)} · ${v.seats} ที่นั่ง</span>${v.type_id !== b.type_id ? ' <span class="tag tag-gray">ต่างประเภท</span>' : ''}
          ${ok ? '<div class="ok">✓ ว่าง</div>' : `<div class="why">${esc(why)}</div>`}</span></label>`).join('')}
      </div></div>
      <label class="field"><span>พนักงานขับรถ</span><input name="assigned_driver" value="${esc(b.assigned_driver || b.vehicle_driver || '')}" ${driverAttrs}><small>เว้นว่างได้ถ้าผู้ขอขับเอง</small></label>
      ${approving ? '<label class="field"><span>หมายเหตุการอนุมัติ</span><textarea name="note" placeholder="เช่น อนุมัติ ให้รับรถที่อาคารจอดรถ"></textarea></label>' : ''}`,
    onOpen: (box) => box.addEventListener('change', (e) => {
      if (e.target.name === 'vehicle_id' && e.target.dataset.driver) box.assigned_driver.value = e.target.dataset.driver;
    }),
    onSubmit: (f) => {
      const d = formData(f);
      if (!d.vehicle_id) throw new Error('กรุณาเลือกรถที่ว่าง');
      return api('POST', `/api/bookings/${b.id}/${approving ? 'approve' : 'assign'}`, d);
    },
  });
}

async function tripDialog(b) {
  const v = await api('GET', `/api/vehicles/${b.vehicle_id}`);
  return modal({
    title: `บันทึกการใช้รถ · ${b.plate}`,
    body: `
      <div class="info-box">${esc(b.code)} · กำหนดการ ${esc(fmtRange(b.start_at, b.end_at))} · เลขไมล์ล่าสุดของรถ ${num(v.mileage)}</div>
      <label class="field"><span>พนักงานขับรถ</span><input name="driver_name" value="${esc(b.trip_driver || b.assigned_driver || b.vehicle_driver || '')}" ${driverAttrs}></label>
      <div class="form-grid">
        <label class="field"><span>วันเวลาออกเดินทาง</span><input type="datetime-local" name="depart_at" value="${toLocalInput(b.depart_at) || toLocalInput(new Date().toISOString())}"></label>
        <label class="field"><span>เลขไมล์ขาออก</span><input type="number" min="0" name="depart_mileage" inputmode="numeric" value="${b.depart_mileage ?? v.mileage ?? ''}"></label>
        <label class="field"><span>วันเวลากลับถึง</span><input type="datetime-local" name="return_at" value="${toLocalInput(b.return_at)}"><small>เว้นว่างไว้ถ้ายังไม่กลับ</small></label>
        <label class="field"><span>เลขไมล์ขากลับ</span><input type="number" min="0" name="return_mileage" inputmode="numeric" value="${b.return_mileage ?? ''}"></label>
      </div>
      <div class="info-box" id="distOut">ระยะทางรวม: -</div>
      <label class="field"><span>หมายเหตุ</span><textarea name="note">${esc(b.trip_note || '')}</textarea></label>
      <p class="faint" style="margin:0">เมื่อบันทึกเวลาและเลขไมล์ขากลับครบ คำขอจะเปลี่ยนเป็น “เสร็จสิ้น” อัตโนมัติ และอัปเดตเลขไมล์ของรถ</p>`,
    onOpen: (box) => {
      const calc = () => {
        const a = Number(box.depart_mileage.value), r = Number(box.return_mileage.value);
        const ok = box.depart_mileage.value !== '' && box.return_mileage.value !== '';
        $('#distOut', box).innerHTML = ok ? (r >= a ? `ระยะทางรวม: <b>${num(r - a)} กม.</b>` : '<span style="color:var(--danger)">เลขไมล์ขากลับน้อยกว่าขาออก</span>') : 'ระยะทางรวม: -';
      };
      box.addEventListener('input', calc); calc();
    },
    onSubmit: (f) => {
      const d = formData(f);
      return api('PUT', `/api/bookings/${b.id}/trip`, {
        driver_name: d.driver_name, note: d.note,
        depart_at: d.depart_at ? fromLocalInput(d.depart_at) : null, depart_mileage: d.depart_mileage,
        return_at: d.return_at ? fromLocalInput(d.return_at) : null, return_mileage: d.return_mileage,
      });
    },
  });
}

// =====================================================================
// บันทึกการใช้รถ (ผู้ดูแล)
// =====================================================================
const tripState = { f: 'waiting' };
async function viewTrips(query) {
  if (!isAdmin()) return adminOnly();
  if (query.f) tripState.f = query.f;
  const rows = await api('GET', '/api/bookings?trip=1&order=start');
  const F = {
    waiting: ['รอออกเดินทาง', (b) => b.status === 'approved' && !b.depart_at],
    out: ['กำลังเดินทาง', (b) => b.depart_at && !b.return_at && b.status === 'approved'],
    overdue: ['เลยกำหนดกลับ', (b) => b.overdue],
    done: ['บันทึกครบแล้ว', (b) => !!b.return_at],
    all: ['ทั้งหมด', () => true],
  };
  const list = rows.filter(F[tripState.f][1]);
  if (tripState.f === 'done') list.reverse();
  const total = list.reduce((s, b) => s + (b.distance || 0), 0);
  app.innerHTML = `
    <div class="page-head"><div><h1>บันทึกการใช้รถ</h1><p>บันทึกเวลาและเลขไมล์ขาออก-ขากลับ ระบบคำนวณระยะทางรวมให้อัตโนมัติ</p></div></div>
    <div class="tabs">${Object.entries(F).map(([k, [l, fn]]) => `<button class="${tripState.f === k ? 'on' : ''}" data-f="${k}">${l}<span class="c">${rows.filter(fn).length}</span></button>`).join('')}</div>
    ${list.length ? `<div class="card table-wrap"><table class="table">
      <thead><tr><th>เลขที่/รถ</th><th>ผู้ขอ/จุดหมาย</th><th>กำหนดการ</th><th>พนักงานขับรถ</th><th>ขาออก</th><th>ขากลับ</th><th class="num">ระยะทาง (กม.)</th><th></th></tr></thead>
      <tbody>${list.map((b) => `<tr>
        <td><a href="#/requests/${b.id}"><b>${esc(b.code)}</b></a>${demoTag(b)}<div>${esc(b.plate)}</div></td>
        <td>${esc(b.requester_name)}<div class="faint">${esc(b.destination)}</div></td>
        <td>${esc(fmtRange(b.start_at, b.end_at))}${b.overdue ? '<div style="color:var(--danger);font-size:.82rem">เลยกำหนดกลับ</div>' : ''}</td>
        <td>${esc(b.trip_driver || b.assigned_driver || '-')}</td>
        <td>${b.depart_at ? `${esc(fmtDateTime(b.depart_at))}<div class="faint">ไมล์ ${num(b.depart_mileage)}</div>` : '<span class="faint">-</span>'}</td>
        <td>${b.return_at ? `${esc(fmtDateTime(b.return_at))}<div class="faint">ไมล์ ${num(b.return_mileage)}</div>` : '<span class="faint">-</span>'}</td>
        <td class="num"><b>${b.distance !== null ? num(b.distance) : '-'}</b></td>
        <td><button class="btn btn-sm" data-trip="${b.id}">${b.depart_at ? 'แก้ไข' : 'บันทึก'}</button></td>
      </tr>`).join('')}</tbody>
      ${total ? `<tfoot><tr><td colspan="6" style="text-align:right"><b>รวม</b></td><td class="num"><b>${num(total)}</b></td><td></td></tr></tfoot>` : ''}
    </table></div>` : empty('ไม่มีรายการในหมวดนี้')}`;
  $$('.tabs [data-f]').forEach((b) => (b.onclick = () => { tripState.f = b.dataset.f; viewTrips({}); }));
}

async function onTripAction(e) {
  const btn = e.target.closest('[data-trip]'); if (!btn) return;
  try {
    const b = await api('GET', `/api/bookings/${btn.dataset.trip}`);
    const r = await tripDialog(b);
    if (r) { toast(`บันทึกเรียบร้อย · สถานะ: ${BOOKING_STATUS[r.status]}`); viewTrips({}); }
  } catch (err) { showError(err); }
}

// ตัวจัดการคลิกแบบรวมศูนย์ (ลงทะเบียนครั้งเดียว ไม่ซ้ำเมื่อเปลี่ยนหน้า)
app.addEventListener('click', (e) => { onVehicleAction(e); onTripAction(e); });

// =====================================================================
// ตั้งค่า (ผู้ดูแล)
// =====================================================================
const SETTINGS_TABS = [['general', 'ทั่วไป'], ['people', 'บุคลากร'], ['presets', 'รายการที่ใช้บ่อย'], ['print', 'รูปแบบหน้าพิมพ์']];
const ROLES = [['is_staff', 'ผู้ขอใช้รถ'], ['is_driver', 'พนักงานขับรถยนต์'], ['is_responsible', 'เจ้าหน้าที่ผู้รับผิดชอบ'], ['is_approver', 'ผู้มีอำนาจ']];

async function viewSettings(query = {}) {
  if (!isAdmin()) return adminOnly();
  const tab = SETTINGS_TABS.some(([k]) => k === query.tab) ? query.tab : 'general';
  app.innerHTML = `
    <div class="page-head"><div><h1>ตั้งค่าระบบ</h1><p>กฎการจอง รายชื่อบุคลากร รายการที่ใช้บ่อย และรูปแบบหน้าพิมพ์</p></div></div>
    <div class="tabs">${SETTINGS_TABS.map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div id="setBody"></div>`;
  $$('.tabs [data-tab]').forEach((b) => (b.onclick = () => { location.hash = `#/settings?tab=${b.dataset.tab}`; }));
  const el = $('#setBody');
  if (tab === 'people') return settingsPeople(el);
  if (tab === 'presets') return settingsPresets(el);
  if (tab === 'print') return settingsPrint(el);
  return settingsGeneral(el);
}

/** โหลดรายชื่อ/รายการ/รูปแบบใหม่หลังแก้ไข */
async function reloadMeta() {
  const meta = await api('GET', '/api/meta');
  S.types = meta.types; S.settings = meta.settings; S.people = meta.people; S.presets = meta.presets;
  S.layout = meta.print_layout; S.layoutDefault = meta.print_layout_default;
  renderDatalists();
}

// ---------- แท็บทั่วไป ----------
function settingsGeneral(el) {
  el.innerHTML = `
    <div class="stack">
      <form class="card form-section" id="ruleForm">
        <h2>กฎการจอง</h2>
        <div class="stack">
          <label class="check"><input type="checkbox" name="require_approval" ${needApproval() ? 'checked' : ''}> ต้องให้ผู้ดูแลอนุมัติก่อน (ถ้าไม่ติ๊ก = จองแล้วยืนยันทันที)</label>
          <div class="field"><span>ตรวจการจองซ้ำ</span>
            <label class="check"><input type="radio" name="conflict_mode" value="day" ${dayMode() ? 'checked' : ''}> รายวัน — รถ 1 คันจองได้ 1 รายการต่อวัน</label>
            <label class="check"><input type="radio" name="conflict_mode" value="time" ${dayMode() ? '' : 'checked'}> รายช่วงเวลา — วันเดียวกันจองได้หลายรายการถ้าเวลาไม่ทับกัน</label>
          </div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">บันทึกกฎการจอง</button></div>
      </form>

      <section class="card form-section">
        <h2>ประเภทรถ</h2>
        <p class="faint" style="margin-top:-6px">ประเภทที่เปิดใช้งานจะแสดงเป็นช่องทำเครื่องหมายบนแบบพิมพ์ (เรียงตามลำดับนี้) และในแบบฟอร์มจอง</p>
        <div id="typeList" class="stack"></div>
        <form class="row" id="typeAdd" style="margin-top:12px"><input class="input" name="name" placeholder="ชื่อประเภทรถใหม่" style="flex:1;min-width:200px" required><button class="btn" type="submit">${ICON.plus} เพิ่มประเภท</button></form>
      </section>

      <section class="card form-section">
        <h2>ข้อมูลตัวอย่าง</h2>
        <p>ขณะนี้มีรถตัวอย่าง <b>${S.demo.vehicles}</b> คัน และการจองตัวอย่าง <b>${S.demo.bookings}</b> รายการ (เลขที่ขึ้นต้นด้วย DEMO-) ข้อมูลที่เพิ่มเองจะไม่ถูกลบ</p>
        <div class="row">
          <button class="btn btn-danger" id="demoClear">ลบข้อมูลตัวอย่างทั้งหมด</button>
          ${SUPABASE_MODE ? '' : '<button class="btn" id="demoReset">รีเซ็ตข้อมูลตัวอย่างใหม่</button>'}
        </div>
        <p class="faint">ถ้าการจองที่สร้างเองใช้รถตัวอย่าง การลบข้อมูลตัวอย่างจะทำให้การจองนั้นไม่มีรถ</p>
      </section>

      <form class="card form-section" id="acctForm" autocomplete="off">
        <h2>บัญชีผู้ดูแล</h2>
        <p class="faint" style="margin-top:-6px">ระบบมีบัญชีผู้ดูแลบัญชีเดียว เจ้าหน้าที่ทั่วไปจองได้โดยไม่ต้องเข้าสู่ระบบ</p>
        ${S.account?.is_default ? '<div class="conflict-box" style="margin-bottom:12px">ยังใช้รหัสผ่านเริ่มต้นอยู่ กรุณาตั้งรหัสผ่านใหม่</div>' : ''}
        <div class="form-grid">
          <label class="field"><span>${SUPABASE_MODE ? 'อีเมลผู้ดูแล' : 'ชื่อผู้ใช้'}</span><input name="username" value="${esc(S.account?.username || '')}" autocomplete="username" ${SUPABASE_MODE ? 'readonly' : ''}><small>${SUPABASE_MODE ? 'เปลี่ยนอีเมลได้ที่ Supabase → Authentication → Users' : 'ตัวอักษรอังกฤษ ตัวเลข หรือ . _ @ -'}</small></label>
          <label class="field"><span>ชื่อที่แสดงในประวัติการดำเนินการ</span><input name="display_name" value="${esc(S.account?.display_name || '')}"></label>
          <label class="field"><span>รหัสผ่านใหม่</span><input name="new_password" type="password" autocomplete="new-password"><small>อย่างน้อย 8 ตัวอักษร · เว้นว่างถ้าไม่เปลี่ยน</small></label>
          <label class="field"><span>ยืนยันรหัสผ่านใหม่</span><input name="confirm_password" type="password" autocomplete="new-password"></label>
          <label class="field full"><span>รหัสผ่านปัจจุบัน <b class="req">*</b></span><input name="current_password" type="password" autocomplete="current-password" required><small>ต้องใส่ทุกครั้งที่แก้ไขบัญชี</small></label>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">บันทึกบัญชีผู้ดูแล</button></div>
      </form>

      <section class="card form-section" hidden>
        <h2>สิทธิ์ผู้ใช้งาน</h2>
        <div class="info-box">ขณะนี้เป็น <b>โหมดสาธิตบทบาท</b>: เลือกผู้ใช้จากเมนูด้านบนโดยไม่ต้องใช้รหัสผ่าน ผู้ใช้ทั่วไปจองและดูการจองของตนเอง ผู้ดูแลจัดการรถ บุคลากร บันทึกการใช้รถ และตั้งค่าได้ — ดูวิธีเปลี่ยนเป็นระบบล็อกอินจริงใน README.md</div>
      </section>
    </div>`;

  $('#acctForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.new_password.value !== f.confirm_password.value) return showError(new Error('รหัสผ่านใหม่และการยืนยันไม่ตรงกัน'));
    try {
      await api('PUT', '/api/account', { username: f.username.value, display_name: f.display_name.value, new_password: f.new_password.value, current_password: f.current_password.value });
      await loadSession();
      toast('บันทึกบัญชีผู้ดูแลแล้ว');
      viewSettings({ tab: 'general' });
    } catch (err) { showError(err); }
  });
  $('#ruleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('PUT', '/api/settings', { require_approval: f.require_approval.checked ? '1' : '0', conflict_mode: f.conflict_mode.value });
      await loadSession();
      toast('บันทึกกฎการจองแล้ว (มีผลกับการจองใหม่)');
      viewSettings({ tab: 'general' });
    } catch (err) { showError(err); }
  });
  const renderTypes = () => {
    $('#typeList').innerHTML = S.types.map((t) => `<form class="row" data-type="${t.id}">
      <input class="input" name="name" value="${esc(t.name)}" style="flex:1;min-width:180px">
      <label class="check"><input type="checkbox" name="active" ${t.active ? 'checked' : ''}> เปิดใช้งาน</label>
      <button class="btn btn-sm" type="submit">บันทึก</button></form>`).join('');
  };
  renderTypes();
  $('#typeList').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, t = S.types.find((x) => String(x.id) === f.dataset.type);
    try {
      await api('PUT', `/api/vehicle-types/${t.id}`, { name: f.name.value, active: f.active.checked, sort_order: t.sort_order });
      await reloadMeta(); renderTypes(); toast('บันทึกประเภทรถแล้ว');
    } catch (err) { showError(err); }
  });
  $('#typeAdd').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/vehicle-types', { name: e.target.name.value }); e.target.reset(); await reloadMeta(); renderTypes(); toast('เพิ่มประเภทรถแล้ว'); }
    catch (err) { showError(err); }
  });
  $('#demoClear').addEventListener('click', async () => {
    if (!(await confirmDialog('ลบข้อมูลตัวอย่าง', 'ลบรถ การจอง รายการซ่อมบำรุง บุคลากร และรายการที่ใช้บ่อยที่เป็นข้อมูลตัวอย่างทั้งหมด (ข้อมูลที่เพิ่มเองไม่ถูกลบ) ยืนยันหรือไม่', 'ลบข้อมูลตัวอย่าง', 'btn-danger'))) return;
    try { await api('POST', '/api/demo/clear'); await loadSession(); toast('ลบข้อมูลตัวอย่างแล้ว'); viewSettings({ tab: 'general' }); } catch (err) { showError(err); }
  });
  $('#demoReset')?.addEventListener('click', async () => {
    if (!(await confirmDialog('รีเซ็ตข้อมูลตัวอย่าง', 'ลบข้อมูลตัวอย่างเดิมแล้วสร้างใหม่โดยอิงวันที่ปัจจุบัน ยืนยันหรือไม่', 'รีเซ็ต'))) return;
    try { await api('POST', '/api/demo/reset'); await loadSession(); toast('รีเซ็ตข้อมูลตัวอย่างแล้ว'); viewSettings({ tab: 'general' }); } catch (err) { showError(err); }
  });
}

// ---------- แท็บบุคลากร ----------
function settingsPeople(el) {
  const rows = S.people;
  el.innerHTML = `
    <section class="card form-section">
      <div class="row"><h2 style="margin:0">รายชื่อบุคลากร</h2><span class="spacer"></span>
        <button class="btn" id="importPeople">นำเข้าจาก Excel</button>
        <button class="btn btn-primary" id="addPerson">${ICON.plus} เพิ่มรายชื่อ</button></div>
      <p class="faint">รายชื่อเหล่านี้เป็นตัวเลือกใน: <b>แบบฟอร์มจอง</b> (ผู้ขอใช้รถ — เลือกแล้วเติมตำแหน่ง ฝ่าย เบอร์โทรให้) · <b>ช่องพนักงานขับรถ</b> (ข้อมูลรถ การกำหนดรถ บันทึกการใช้รถ) · <b>ผู้ลงนามบนหน้าพิมพ์</b> (เจ้าหน้าที่ผู้รับผิดชอบ / ผู้มีอำนาจ)</p>
      ${rows.length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>ชื่อ-นามสกุล</th><th>ฝ่าย/กลุ่มงาน</th><th>โทร</th><th>หน้าที่</th><th>สถานะ</th><th></th></tr></thead>
        <tbody>${rows.map((p) => `<tr>
          <td><b>${esc(p.name)}</b>${demoTag(p)}<div class="faint">${esc(p.position)}</div></td>
          <td>${esc(p.department || '-')}</td>
          <td>${esc(p.phone || '-')}</td>
          <td><div class="role-chips">${ROLES.filter(([k]) => p[k]).map(([, l]) => `<span class="tag tag-gray">${l}</span>`).join('')}</div></td>
          <td>${p.active ? '<span class="badge st-available">ใช้งาน</span>' : '<span class="badge bs-cancelled">ปิด</span>'}</td>
          <td><div class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn btn-sm" data-pedit="${p.id}">แก้ไข</button><button class="btn btn-sm btn-danger" data-pdel="${p.id}">ลบ</button></div></td>
        </tr>`).join('')}</tbody></table></div>` : empty('ยังไม่มีรายชื่อ กด “เพิ่มรายชื่อ” เพื่อเริ่มต้น')}
    </section>`;
  $('#addPerson').onclick = () => personForm();
  $('#importPeople').onclick = () => importDialog();
  el.onclick = async (e) => {
    const ed = e.target.closest('[data-pedit]'), del = e.target.closest('[data-pdel]');
    if (ed) personForm(S.people.find((p) => p.id === Number(ed.dataset.pedit)));
    if (del) {
      const p = S.people.find((x) => x.id === Number(del.dataset.pdel));
      if (!(await confirmDialog('ลบรายชื่อ', `ลบ “${p.name}” ออกจากรายชื่อ (การจองเดิมที่มีชื่อนี้จะไม่ถูกแก้ไข) ยืนยันหรือไม่`, 'ลบ', 'btn-danger'))) return;
      try { await api('DELETE', `/api/people/${p.id}`); await reloadMeta(); toast('ลบรายชื่อแล้ว'); settingsPeople(el); } catch (err) { showError(err); }
    }
  };
}

/** นำเข้ารายชื่อจาก Excel (.xlsx) หรือ CSV: เลือกไฟล์ → ตรวจตัวอย่าง → นำเข้า */
async function importDialog() {
  let file = null, preview = null;
  const template = '\uFEFFชื่อ-นามสกุล *,ตำแหน่ง,ฝ่าย/กลุ่มงาน,เบอร์โทร\r\nนายสมชาย ใจดี,เจ้าพนักงานธุรการ,กลุ่มงานบริหารทั่วไป,081-234-5678\r\n';
  const templateUrl = URL.createObjectURL(new Blob([template], { type: 'text/csv;charset=utf-8' }));
  const roles = () => Object.fromEntries(ROLES.map(([k]) => [k, $(`#modalBox input[name="imp_${k}"]`).checked]));
  const r = await modal({
    title: 'นำเข้าบุคลากรจาก Excel', submitLabel: 'นำเข้า',
    body: `
      <div class="info-box">ไฟล์ .xlsx หรือ .csv ที่มีคอลัมน์ <b>ชื่อ-นามสกุล</b> (จำเป็น) และ <b>ตำแหน่ง</b> · มี <b>ฝ่าย/กลุ่มงาน</b> และ <b>เบอร์โทร</b> ได้ (ไม่บังคับ) · ระบบหาแถวหัวตารางให้เอง ใช้แผ่นงานแรก
        <br><a href="${templateUrl}" download="แบบฟอร์มนำเข้าบุคลากร.csv">ดาวน์โหลดไฟล์ตัวอย่าง</a></div>
      <label class="field"><span>เลือกไฟล์</span><input type="file" id="impFile" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"></label>
      <div class="field"><span>หน้าที่ของรายชื่อที่นำเข้า</span>
        <div class="type-options">${ROLES.map(([k, l]) => `<label><input type="checkbox" name="imp_${k}" ${k === 'is_staff' ? 'checked' : ''}> ${l}</label>`).join('')}</div>
        <small>ชื่อที่มีอยู่แล้ว: อัปเดตตำแหน่ง (และฝ่าย/เบอร์ถ้ามีในไฟล์) และเพิ่มหน้าที่ที่เลือก โดยไม่ลบหน้าที่เดิม</small>
      </div>
      <div id="impPreview"></div>`,
    onOpen: (box) => {
      const show = async () => {
        if (!file) return;
        $('#impPreview', box).innerHTML = '<div class="loading">กำลังอ่านไฟล์…</div>';
        try {
          preview = await api('POST', '/api/people/import', { filename: file.name, data: file.data, roles: roles() });
          const c = preview.counts;
          const label = { new: ['เพิ่มใหม่', 'st-available'], update: ['อัปเดต', 'st-in_use'], skip: ['ข้าม', 'bs-cancelled'] };
          $('#impPreview', box).innerHTML = `
            <p><b>พบหัวตารางที่แถว ${preview.headerRow}</b> (${Object.values(preview.columns).map(esc).join(', ')}) ·
              เพิ่มใหม่ <b>${c.new}</b> · อัปเดต <b>${c.update}</b> · ข้าม <b>${c.skip}</b></p>
            <div class="import-preview"><table class="table"><thead><tr><th>แถว</th><th>ชื่อ-นามสกุล</th><th>ตำแหน่ง</th><th>ผล</th></tr></thead>
            <tbody>${preview.rows.map((x) => `<tr><td>${x.row}</td><td>${esc(x.name || '-')}</td><td>${esc(x.position || '-')}</td>
              <td><span class="badge ${label[x.action][1]}">${label[x.action][0]}</span>${x.note ? `<div class="faint">${esc(x.note)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
        } catch (err) { preview = null; $('#impPreview', box).innerHTML = `<div class="conflict-box">${esc(err.message)}</div>`; }
      };
      $('#impFile', box).addEventListener('change', (e) => {
        const f = e.target.files[0]; if (!f) return;
        if (f.size > 5e6) { $('#impPreview', box).innerHTML = '<div class="conflict-box">ไฟล์ใหญ่เกิน 5 MB</div>'; return; }
        const rd = new FileReader();
        rd.onload = () => { file = { name: f.name, data: String(rd.result).split(',')[1] }; show(); };
        rd.readAsDataURL(f);
      });
    },
    onSubmit: async () => {
      if (!file || !preview) throw new Error('กรุณาเลือกไฟล์และตรวจตัวอย่างก่อนนำเข้า');
      if (!preview.counts.new && !preview.counts.update) throw new Error('ไม่มีรายชื่อที่นำเข้าได้');
      return api('POST', '/api/people/import', { filename: file.name, data: file.data, roles: roles(), commit: true });
    },
  });
  URL.revokeObjectURL(templateUrl);
  if (r) { await reloadMeta(); toast(`นำเข้าแล้ว ${r.imported} รายชื่อ (เพิ่มใหม่ ${r.counts.new} · อัปเดต ${r.counts.update})`); viewSettings({ tab: 'people' }); }
}

async function personForm(p = null) {
  const r = await modal({
    title: p ? `แก้ไขรายชื่อ · ${p.name}` : 'เพิ่มรายชื่อบุคลากร',
    body: `<div class="form-grid">
      <label class="field full"><span>ชื่อ-นามสกุล <b class="req">*</b></span><input name="name" required value="${esc(p?.name)}" placeholder="เช่น นายสมชาย ใจดี"></label>
      <label class="field"><span>ตำแหน่ง</span><input name="position" value="${esc(p?.position)}"></label>
      <label class="field"><span>ฝ่าย/กลุ่มงาน</span><input name="department" value="${esc(p?.department)}"></label>
      <label class="field"><span>เบอร์โทร</span><input name="phone" value="${esc(p?.phone)}"></label>
      <label class="field" style="justify-content:flex-end"><span class="check"><input type="checkbox" name="active" ${!p || p.active ? 'checked' : ''}> เปิดใช้งาน (แสดงในตัวเลือก)</span></label>
      <div class="field full"><span>หน้าที่ (เลือกได้หลายอย่าง) <b class="req">*</b></span>
        <div class="type-options">${ROLES.map(([k, l]) => `<label><input type="checkbox" name="${k}" ${p ? (p[k] ? 'checked' : '') : (k === 'is_staff' ? 'checked' : '')}> ${l}</label>`).join('')}</div>
      </div>
    </div>`,
    onSubmit: (f) => {
      const body = { name: f.name.value, position: f.position.value, department: f.department.value, phone: f.phone.value, active: f.active.checked };
      ROLES.forEach(([k]) => { body[k] = f[k].checked; });
      return api(p ? 'PUT' : 'POST', p ? `/api/people/${p.id}` : '/api/people', body);
    },
  });
  if (r) { await reloadMeta(); toast(p ? 'บันทึกรายชื่อแล้ว' : 'เพิ่มรายชื่อแล้ว'); viewSettings({ tab: 'people' }); }
}

// ---------- แท็บรายการที่ใช้บ่อย ----------
function settingsPresets(el) {
  const block = (kind, title, hint) => {
    const items = S.presets.filter((p) => p.kind === kind);
    return `<section class="card form-section">
      <h2>${title}</h2><p class="faint" style="margin-top:-6px">${hint}</p>
      <ul class="preset-list">${items.map((p) => `<li><span>${esc(p.text)}${demoTag(p)}</span><button class="btn btn-sm btn-ghost" data-prdel="${p.id}" aria-label="ลบ">✕</button></li>`).join('') || '<li class="faint">ยังไม่มีรายการ</li>'}</ul>
      <form class="row" data-kind="${kind}" style="margin-top:10px"><input class="input" name="text" required placeholder="เพิ่มรายการใหม่" style="flex:1;min-width:200px"><button class="btn" type="submit">${ICON.plus} เพิ่ม</button></form>
    </section>`;
  };
  el.innerHTML = `<div class="preset-grid">
    ${block('destination', 'สถานที่ที่ไปบ่อย', 'แสดงเป็นตัวเลือกในช่อง “สถานที่ไป/จุดหมาย” ของแบบฟอร์มจอง')}
    ${block('purpose', 'วัตถุประสงค์ที่ใช้บ่อย', 'แสดงเป็นตัวเลือกในช่อง “วัตถุประสงค์/เหตุผล” ของแบบฟอร์มจอง')}
  </div>`;
  el.querySelectorAll('form[data-kind]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/presets', { kind: f.dataset.kind, text: f.text.value }); await reloadMeta(); toast('เพิ่มรายการแล้ว'); settingsPresets(el); }
    catch (err) { showError(err); }
  }));
  el.onclick = async (e) => {
    const b = e.target.closest('[data-prdel]'); if (!b) return;
    try { await api('DELETE', `/api/presets/${b.dataset.prdel}`); await reloadMeta(); toast('ลบรายการแล้ว'); settingsPresets(el); }
    catch (err) { showError(err); }
  };
}

// ---------- แท็บรูปแบบหน้าพิมพ์ (ตัวอย่างสด) ----------
const SETTING_TEXTS = [
  ['form_title', 'หัวข้อเอกสาร'], ['form_code', 'รหัสแบบฟอร์ม (มุมขวาบน)'], ['form_to', 'เรียน'], ['org_affiliation', 'สังกัด (ท้ายบรรทัดฝ่าย/กลุ่มงาน)'],
  ['responsible_title', 'ตำแหน่งใต้ลายเซ็นฝั่งซ้าย'], ['approver_heading', 'หัวข้อฝั่งขวา'], ['approver_title', 'ตำแหน่งใต้ลายเซ็นฝั่งขวา'],
  ['trip_heading', 'หัวข้อบันทึกการใช้รถ'], ['return_place', 'สถานที่ “กลับถึง ... วันที่”'], ['form_footer', 'ข้อความท้ายเอกสาร'], ['org_name', 'ชื่อหน่วยงาน (แถบเมนูแอป)'],
];
const LAYOUT_TEXTS = [
  ['seqFormat', 'เลขลำดับใต้รหัสแบบฟอร์ม — {n} = ลำดับ, {thn} = ลำดับเลขไทย, {short} = ทะเบียนย่อ, {plate} = ทะเบียนเต็ม (เว้นว่าง = ไม่แสดง)'],
  ['requestLine', 'หน้าช่องประเภทรถ'], ['destination', 'หน้าช่องสถานที่'], ['purpose', 'หน้าช่องวัตถุประสงค์'], ['closing', 'บรรทัดปิดท้ายผู้ขอ'],
  ['requesterTitle', 'ตำแหน่งใต้ลายเซ็นผู้ขอ'], ['officerOpt1', 'ฝั่งซ้าย ตัวเลือกที่ 1'], ['officerAssign', 'คำหน้าช่องผู้ขับ'], ['officerDriver', 'คำหลังช่องผู้ขับ'],
  ['officerOpt2', 'ฝั่งซ้าย ตัวเลือกที่ 2', true], ['officerClosing', 'บรรทัดปิดท้ายฝั่งซ้าย'], ['orderPermit', 'คำสั่ง: อนุญาต'], ['orderDeny', 'คำสั่ง: ไม่อนุญาต'],
  ['orderUnable', 'คำสั่ง: ไม่สามารถ…'], ['orderUnableReason', 'คำสั่ง: บรรทัดเหตุผล (เว้นว่างได้)'], ['orderOther', 'คำสั่ง: อื่นๆ'], ['driverTitle', 'ตำแหน่งใต้ลายเซ็นผู้ขับ'],
];

async function settingsPrint(el) {
  const L = S.layout;
  const recent = (await api('GET', '/api/bookings')).slice(0, 15);
  const numCtl = (k, label, min, max, step, unit) => `<label class="pl-num"><span>${label}</span>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${L[k]}" data-k="${k}">
    <input type="number" min="${min}" max="${max}" step="${step}" value="${L[k]}" data-k="${k}" class="input"><em>${unit}</em></label>`;
  const chk = (k, label) => `<label class="check"><input type="checkbox" data-k="${k}" ${L[k] ? 'checked' : ''}> ${label}</label>`;
  const signerSel = (k, flag) => `<select class="input" data-k="${k}"><option value="0">— เว้นว่าง —</option>${S.people.filter((p) => p.active && p[flag]).map((p) => `<option value="${p.id}" ${p.id === L[k] ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`;
  el.innerHTML = `
    <div class="pl-layout">
      <form class="card pl-controls" id="plForm" autocomplete="off">
        <div class="pl-bar">
          <button class="btn btn-primary" type="submit">บันทึกรูปแบบ</button>
          <button class="btn" type="button" id="plReset">คืนค่าเริ่มต้น</button>
          <span class="faint" id="plFit"></span>
        </div>
        <details open><summary>ขนาดตัวอักษรและระยะบรรทัด</summary><div class="pl-group">
          ${numCtl('fontSize', 'ขนาดตัวอักษร', 9, 20, 0.25, 'pt')}
          ${numCtl('lineHeight', 'ระยะห่างบรรทัด', 1.2, 2.4, 0.05, 'เท่า')}
          ${chk('autoFit', 'ย่อตัวอักษรอัตโนมัติให้พอดี 1 หน้า')}
          ${numCtl('minFontSize', 'ย่อได้ต่ำสุด', 8, 18, 0.25, 'pt')}
        </div></details>
        <details open><summary>ระยะขอบกระดาษ</summary><div class="pl-group">
          ${numCtl('marginTop', 'บน', 0, 40, 0.5, 'มม.')}${numCtl('marginBottom', 'ล่าง', 0, 40, 0.5, 'มม.')}
          ${numCtl('marginLeft', 'ซ้าย', 0, 40, 0.5, 'มม.')}${numCtl('marginRight', 'ขวา', 0, 40, 0.5, 'มม.')}
        </div></details>
        <details open><summary>การจัดวาง</summary><div class="pl-group">
          ${numCtl('indent', 'ย่อหน้า “ข้าพเจ้า”/“จึงเรียนมา”', 0, 50, 0.5, 'มม.')}
          ${numCtl('splitLeft', 'ความกว้างคอลัมน์ซ้าย (ส่วนเจ้าหน้าที่)', 35, 70, 0.5, '%')}
          ${numCtl('purposeLines', 'บรรทัด “เพื่อ” อย่างน้อย', 1, 8, 1, 'บรรทัด')}
          ${numCtl('signGap', 'ระยะเว้นก่อนช่องลงนาม', 0, 20, 0.5, 'มม.')}
        </div></details>
        <details open><summary>ส่วนที่แสดง</summary><div class="pl-group">
          ${chk('showOfficerSection', 'ส่วนเจ้าหน้าที่ผู้รับผิดชอบ / คำสั่ง')}
          ${chk('showTripSection', 'ส่วนบันทึกการใช้รถ')}
          ${chk('showCompanionNames', 'ต่อท้ายวัตถุประสงค์ด้วยรายชื่อผู้ร่วมเดินทาง')}
          ${chk('printSignerNames', 'พิมพ์ชื่อผู้ลงนามที่เลือกในวงเล็บ')}
          ${chk('showRef', 'เลขอ้างอิงการจองที่มุมล่างซ้าย')}
        </div></details>
        <details open><summary>ผู้ลงนามเริ่มต้น</summary><div class="pl-group">
          <label class="field"><span>เจ้าหน้าที่ผู้รับผิดชอบ</span>${signerSel('responsibleId', 'is_responsible')}</label>
          <label class="field"><span>ผู้มีอำนาจ</span>${signerSel('approverId', 'is_approver')}</label>
          <p class="faint" style="margin:0">เปลี่ยนเฉพาะครั้งได้ที่แถบเครื่องมือของหน้าพิมพ์ · เพิ่มรายชื่อได้ที่แท็บ “บุคลากร”</p>
        </div></details>
        <details><summary>หัวเอกสารและข้อความหลัก</summary><div class="pl-group">
          ${SETTING_TEXTS.map(([k, l]) => `<label class="field"><span>${l}</span><input class="input" data-s="${k}" value="${esc(S.settings[k])}"></label>`).join('')}
        </div></details>
        <details><summary>ข้อความในแบบฟอร์ม</summary><div class="pl-group">
          ${LAYOUT_TEXTS.map(([k, l, area]) => `<label class="field"><span>${l}</span>${area ? `<textarea class="input" data-t="${k}" rows="3">${esc(L.texts[k])}</textarea>` : `<input class="input" data-t="${k}" value="${esc(L.texts[k])}">`}</label>`).join('')}
        </div></details>
      </form>
      <section class="card pl-preview">
        <div class="row pl-preview-bar">
          <label class="field" style="flex:1;min-width:200px"><span>ตัวอย่างจาก</span><select class="input" id="plSource">
            <option value="sample">ข้อมูลสมมติ</option>${recent.map((b) => `<option value="${b.id}">${esc(b.code)} · ${esc(b.requester_name)}</option>`).join('')}
          </select></label>
          <label class="check"><input type="checkbox" id="plFill" checked> แสดงข้อมูลที่เติมจากระบบ</label>
        </div>
        <iframe id="plFrame" title="ตัวอย่างหน้าพิมพ์" src="print.html?sample=1&embed=1"></iframe>
      </section>
    </div>`;

  const form = $('#plForm'), frame = $('#plFrame');
  const draft = () => {
    const layout = { texts: {} };
    for (const [k, v] of Object.entries(S.layoutDefault)) if (k !== 'texts') layout[k] = v;
    form.querySelectorAll('[data-k]').forEach((i) => {
      if (i.type === 'range') return;
      layout[i.dataset.k] = i.type === 'checkbox' ? i.checked : Number(i.value);
    });
    form.querySelectorAll('[data-t]').forEach((i) => { layout.texts[i.dataset.t] = i.value; });
    const settings = {};
    form.querySelectorAll('[data-s]').forEach((i) => { settings[i.dataset.s] = i.value; });
    return { layout, settings };
  };
  const send = () => {
    const { layout, settings } = draft();
    frame.contentWindow?.postMessage({ type: 'print-preview', layout: { ...S.layoutDefault, ...layout, texts: { ...S.layoutDefault.texts, ...layout.texts } }, settings, fill: $('#plFill').checked }, location.origin);
  };
  const sendSoon = debounce(send, 120);
  form.addEventListener('input', (e) => {
    const k = e.target.dataset.k;
    if (k && (e.target.type === 'range' || e.target.type === 'number')) {
      form.querySelectorAll(`[data-k="${k}"]`).forEach((o) => { if (o !== e.target) o.value = e.target.value; });
    }
    sendSoon();
  });
  form.addEventListener('change', sendSoon);
  $('#plFill').addEventListener('change', send);
  $('#plSource').addEventListener('change', (e) => {
    frame.src = e.target.value === 'sample' ? 'print.html?sample=1&embed=1' : `print.html?id=${e.target.value}&embed=1`;
  });
  const onMsg = (e) => {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === 'print-ready') send();
    if (e.data.type === 'print-fit' && $('#plFit')) {
      $('#plFit').innerHTML = e.data.fits ? `ใช้ตัวอักษร ${e.data.fontSize}pt · พอดี 1 หน้า` : `<span style="color:var(--danger)">เนื้อหาเกิน 1 หน้า (${e.data.fontSize}pt) — ลดขนาดตัวอักษร ระยะบรรทัด หรือระยะขอบ</span>`;
    }
  };
  window.addEventListener('message', onMsg);
  window.addEventListener('hashchange', () => window.removeEventListener('message', onMsg), { once: true });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { layout, settings } = draft();
    try {
      await api('PUT', '/api/settings', { ...settings, print_layout: layout });
      await reloadMeta(); renderShell();
      toast('บันทึกรูปแบบหน้าพิมพ์แล้ว');
    } catch (err) { showError(err); }
  });
  $('#plReset').addEventListener('click', async () => {
    if (!(await confirmDialog('คืนค่าเริ่มต้น', 'คืนขนาด ระยะ ส่วนที่แสดง และข้อความในแบบฟอร์มเป็นค่าเริ่มต้น (หัวเอกสารและข้อความหลักไม่เปลี่ยน) แล้วบันทึกทันที ยืนยันหรือไม่', 'คืนค่าเริ่มต้น'))) return;
    try { await api('PUT', '/api/settings', { print_layout: {} }); await reloadMeta(); toast('คืนค่าเริ่มต้นแล้ว'); settingsPrint(el); }
    catch (err) { showError(err); }
  });
}

// ---------- เริ่มต้น ----------
(async () => {
  try { await loadSession(); route(); }
  catch (e) { app.innerHTML = `<div class="conflict-box">${esc(e.message)}</div>`; }
})();
