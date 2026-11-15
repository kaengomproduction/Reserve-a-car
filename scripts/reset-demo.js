'use strict';
// ลบข้อมูลตัวอย่างแล้วสร้างใหม่ (ข้อมูลจริงที่ไม่ได้ติดป้ายตัวอย่างจะไม่ถูกลบ)
// ใช้: npm run reset-demo   หรือ   node scripts/reset-demo.js --clear  (ลบอย่างเดียว ไม่สร้างใหม่)
const path = require('node:path');
const { openDb, clearDemo, seedDemo } = require('../lib/db');

const db = openDb(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'booking.db'));
clearDemo(db);
if (!process.argv.includes('--clear')) seedDemo(db);
console.log(process.argv.includes('--clear') ? 'ลบข้อมูลตัวอย่างเรียบร้อย' : 'รีเซ็ตข้อมูลตัวอย่างเรียบร้อย');
db.close();
