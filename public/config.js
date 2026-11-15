// การตั้งค่าหน้าเว็บ
// - เว้นว่าง = ใช้เซิร์ฟเวอร์ Node ในเครื่อง (npm start)
// - ใส่ค่า Supabase = หน้าเว็บคุยกับ Supabase โดยตรง (ใช้กับ GitHub Pages; GitHub Actions สร้างไฟล์นี้ให้จาก Repository variables)
// anon key เป็นค่าสาธารณะ ใส่ในหน้าเว็บได้ — ความปลอดภัยอยู่ที่ Row Level Security ใน supabase/schema.sql
window.APP_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
};
