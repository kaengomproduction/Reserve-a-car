'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./lib/db');
const { createService, AppError } = require('./lib/service');
const auth = require('./lib/auth');
const { getCurrentUser } = auth;
const { DEFAULT_LAYOUT } = require('./lib/printLayout');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

function createApp({ dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'booking.db') } = {}) {
  const db = openDb(dbPath);
  const svc = createService(db);

  // ตารางเส้นทาง API: [method, pattern, handler(ctx), ต้องล็อกอินหรือไม่]
  const routes = [
    ['GET', '/api/session', (c) => ({
      user: { id: c.user.id, name: c.user.name, role: c.user.role }, isAdmin: c.user.role === 'admin',
      account: c.user.role === 'admin' ? svc.accountInfo() : null, demo: svc.demoInfo(),
    })],
    ['PUT', '/api/account', (c) => svc.changeAccount(c.user, c.body)],
    ['GET', '/api/meta', () => ({ types: svc.listTypes(), settings: svc.getSettings(), print_layout: svc.printLayout(), print_layout_default: DEFAULT_LAYOUT, people: svc.listPeople(), presets: svc.listPresets() })],
    ['POST', '/api/people', (c) => svc.savePerson(c.user, 0, c.body)],
    ['PUT', '/api/people/:id', (c) => svc.savePerson(c.user, c.id, c.body)],
    ['DELETE', '/api/people/:id', (c) => svc.deletePerson(c.user, c.id)],
    ['POST', '/api/people/import', (c) => svc.importPeople(c.user, c.body)],
    ['POST', '/api/presets', (c) => svc.savePreset(c.user, c.body)],
    ['DELETE', '/api/presets/:id', (c) => svc.deletePreset(c.user, c.id)],
    ['PUT', '/api/settings', (c) => svc.updateSettings(c.user, c.body)],
    ['POST', '/api/vehicle-types', (c) => svc.saveType(c.user, 0, c.body)],
    ['PUT', '/api/vehicle-types/:id', (c) => svc.saveType(c.user, c.id, c.body)],

    ['GET', '/api/dashboard', (c) => svc.dashboard(c.user, c.query)],
    ['GET', '/api/vehicles', (c) => svc.listVehicles(c.query)],
    ['POST', '/api/vehicles', (c) => svc.createVehicle(c.user, c.body)],
    ['GET', '/api/vehicles/:id', (c) => svc.getVehicle(c.id)],
    ['PUT', '/api/vehicles/:id', (c) => svc.updateVehicle(c.user, c.id, c.body)],
    ['POST', '/api/vehicles/:id/active', (c) => svc.setVehicleActive(c.user, c.id, !!c.body.active)],
    ['POST', '/api/vehicles/:id/maintenance', (c) => svc.addMaintenance(c.user, c.id, c.body)],
    ['PUT', '/api/maintenance/:id', (c) => svc.updateMaintenance(c.user, c.id, c.body)],
    ['DELETE', '/api/maintenance/:id', (c) => svc.deleteMaintenance(c.user, c.id)],

    ['POST', '/api/availability', (c) => svc.checkAvailability(c.body)],
    ['GET', '/api/schedule', (c) => svc.schedule(c.user, c.query)],
    ['GET', '/api/bookings', (c) => svc.listBookings(c.user, c.query)],
    ['POST', '/api/bookings', (c) => svc.createBooking(c.user, c.body)],
    ['GET', '/api/bookings/:id', (c) => svc.getBooking(c.user, c.id)],
    ['POST', '/api/bookings/:id/assign', (c) => svc.assignVehicle(c.user, c.id, c.body)],
    ['POST', '/api/bookings/:id/approve', (c) => svc.approveBooking(c.user, c.id, c.body)],
    ['POST', '/api/bookings/:id/reject', (c) => svc.rejectBooking(c.user, c.id, c.body)],
    ['POST', '/api/bookings/:id/cancel', (c) => svc.cancelBooking(c.user, c.id, c.body)],
    ['POST', '/api/bookings/:id/complete', (c) => svc.completeBooking(c.user, c.id, c.body)],
    ['PUT', '/api/bookings/:id/trip', (c) => svc.saveTrip(c.user, c.id, c.body)],

    ['POST', '/api/demo/clear', (c) => svc.clearDemoData(c.user)],
    ['POST', '/api/demo/reset', (c) => svc.resetDemoData(c.user)],
  ].map(([method, pattern, handler, auth = true]) => ({
    method, handler, auth,
    re: new RegExp('^' + pattern.replace(/:id/, '(\\d+)') + '$'),
  }));

  function send(res, status, data, headers = {}) {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  }

  function readBody(req, limit = 1e6) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > limit) { reject(new AppError(413, 'ข้อมูลที่ส่งมีขนาดใหญ่เกินไป')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new AppError(400, 'รูปแบบข้อมูลไม่ถูกต้อง (ต้องเป็น JSON)')); }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('ไม่พบหน้าที่ต้องการ'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, url.pathname);
    }
    try {
      // เข้าสู่ระบบ/ออกจากระบบของผู้ดูแล (ต้องตั้ง cookie จึงจัดการแยกจากตารางเส้นทาง)
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const ip = auth.clientIp(req);
        if (auth.loginBlocked(ip)) throw new AppError(429, 'ใส่รหัสผ่านผิดหลายครั้งเกินไป กรุณารอ 10 นาทีแล้วลองใหม่');
        const b = await readBody(req);
        if (!svc.checkLogin(b.username, b.password)) {
          auth.recordFailure(ip);
          throw new AppError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
        }
        auth.clearFailures(ip);
        return send(res, 200, { ok: true, account: svc.accountInfo() }, { 'Set-Cookie': auth.sessionCookie(auth.createSession(), auth.isHttps(req)) });
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        auth.destroySession(req);
        return send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
      }
      const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!route) throw new AppError(404, 'ไม่พบ API ที่ร้องขอ');
      const m = url.pathname.match(route.re);
      const user = getCurrentUser(req, svc);
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req, url.pathname === '/api/people/import' ? 8e6 : 1e6) : {};
      const ctx = { user, body, query: Object.fromEntries(url.searchParams), id: m[1] ? Number(m[1]) : null };
      const result = route.handler(ctx);
      send(res, req.method === 'POST' && url.pathname === '/api/bookings' ? 201 : 200, result);
    } catch (e) {
      if (e instanceof AppError) return send(res, e.status, { error: e.message, ...e.extra });
      if (/UNIQUE constraint/.test(e.message)) return send(res, 409, { error: 'ข้อมูลซ้ำกับที่มีอยู่ในระบบ' });
      console.error(e);
      send(res, 500, { error: 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง' });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  return { server, db, svc };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  const { server } = createApp();
  server.listen(port, host, () => {
    console.log(`ระบบจองรถพร้อมใช้งานที่ http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log('เขตเวลา: Asia/Bangkok · ฐานข้อมูล:', process.env.DB_PATH || 'data/booking.db');
  });
}

module.exports = { createApp };
