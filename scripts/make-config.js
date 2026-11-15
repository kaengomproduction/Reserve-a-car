'use strict';
// สร้าง public/config.js จากตัวแปร SUPABASE_URL / SUPABASE_ANON_KEY (ใช้ใน GitHub Actions ตอน deploy ขึ้น GitHub Pages)
const fs = require('node:fs');
const path = require('node:path');

const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const key = String(process.env.SUPABASE_ANON_KEY || '').trim();
const missing = [!url && 'SUPABASE_URL', !key && 'SUPABASE_ANON_KEY'].filter(Boolean);
if (missing.length) {
  console.log(`::error::ไม่พบค่า ${missing.join(', ')} — ตั้งที่ GitHub repository > Settings > Secrets and variables > Actions > แท็บ Variables > New repository variable (ชื่อต้องตรงทุกตัวอักษร ตัวพิมพ์ใหญ่)`);
  process.exit(1);
}
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) {
  console.log(`::warning::SUPABASE_URL ควรมีรูปแบบ https://xxxx.supabase.co (ตอนนี้คือ ${url})`);
}
if (key.split('.').length !== 3 && !key.startsWith('sb_publishable_')) {
  console.log('::warning::SUPABASE_ANON_KEY ดูไม่เหมือน anon/publishable key — คัดลอกจาก Supabase > Project Settings > API Keys (อย่าใช้ service_role/secret key)');
}
if (key.startsWith('sb_secret_') || /service_role/.test(Buffer.from(key.split('.')[1] || '', 'base64').toString())) {
  console.log('::error::นี่คือ service_role/secret key ห้ามใส่ในหน้าเว็บ ให้ใช้ anon (publishable) key แทน');
  process.exit(1);
}
const out = path.join(__dirname, '..', 'public', 'config.js');
fs.writeFileSync(out, `window.APP_CONFIG = ${JSON.stringify({ supabaseUrl: url, supabaseAnonKey: key })};\n`);
console.log(`สร้าง config.js แล้ว: ${url}`);
