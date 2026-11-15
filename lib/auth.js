'use strict';
/**
 * การยืนยันตัวตน
 * - ผู้ดูแลระบบมีบัญชีเดียว (ชื่อผู้ใช้ + รหัสผ่าน) ล็อกอินแล้วได้ session cookie (HttpOnly)
 * - ผู้ที่ไม่ได้ล็อกอินใช้งานในฐานะ "ผู้ใช้งานทั่วไป": จองได้ และเห็นเฉพาะการจองที่ตนถือรหัสลับ (owner token)
 *   ซึ่งหน้าเว็บเก็บไว้ในเครื่องแล้วส่งมากับ header X-Booking-Tokens
 */
const crypto = require('node:crypto');

const COOKIE = 'vb_sid';
const SESSION_TTL = 12 * 3600e3; // หมดอายุเมื่อไม่ได้ใช้งาน 12 ชั่วโมง
const sessions = new Map();      // sid → { exp } (รีสตาร์ตเซิร์ฟเวอร์ = ต้องล็อกอินใหม่)

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [salt, hex] = String(stored || '').split(':');
  if (!salt || !hex) return false;
  const want = Buffer.from(hex, 'hex');
  const got = crypto.scryptSync(String(password), salt, 64);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentSession(req) {
  const sid = parseCookies(req)[COOKIE];
  const s = sid && sessions.get(sid);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(sid); return null; }
  s.exp = Date.now() + SESSION_TTL;
  return sid;
}
function createSession() {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { exp: Date.now() + SESSION_TTL });
  return sid;
}
function destroySession(req) { const sid = parseCookies(req)[COOKIE]; if (sid) sessions.delete(sid); }
function destroyAllSessions() { sessions.clear(); }
const sessionCookie = (sid, secure = false) => `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}${secure ? '; Secure' : ''}`;
const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

/** รหัสลับการจองที่เครื่องนี้ถืออยู่ */
function bookingTokens(req) {
  return String(req.headers['x-booking-tokens'] || '').split(',').map((t) => t.trim())
    .filter((t) => /^[a-f0-9]{32}$/.test(t)).slice(-500);
}

/** ผู้ใช้ของคำขอนี้: ผู้ดูแล (มี session) หรือผู้ใช้งานทั่วไป พร้อมรหัสลับการจองที่ถืออยู่ */
function getCurrentUser(req, svc) {
  const base = currentSession(req) ? svc.adminUser() : svc.guestUser();
  return { ...base, tokens: bookingTokens(req) };
}

/**
 * อยู่หลัง reverse proxy / บริการโฮสต์ (Render, Railway, nginx) ให้ตั้ง TRUST_PROXY=1
 * จะใช้ IP จริงจาก X-Forwarded-For (สำหรับจำกัดการเดารหัสผ่าน) และตั้ง cookie แบบ Secure เมื่อเข้าผ่าน HTTPS
 */
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}
function isHttps(req) {
  return !!req.socket.encrypted || (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
}

// จำกัดการเดารหัสผ่าน: ผิดได้ 8 ครั้งต่อ 10 นาที ต่อเครื่อง
const failures = new Map();
function loginBlocked(ip) {
  const list = (failures.get(ip) || []).filter((t) => t > Date.now() - 10 * 60e3);
  failures.set(ip, list);
  return list.length >= 8;
}
function recordFailure(ip) { failures.set(ip, [...(failures.get(ip) || []), Date.now()]); }
function clearFailures(ip) { failures.delete(ip); }

module.exports = {
  getCurrentUser, hashPassword, verifyPassword, createSession, destroySession, destroyAllSessions,
  sessionCookie, clearCookie, loginBlocked, recordFailure, clearFailures, clientIp, isHttps,
};
