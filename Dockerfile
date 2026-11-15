# ระบบจองรถส่วนกลาง — ไม่มีแพ็กเกจภายนอก ใช้ Node.js 24 (มี node:sqlite ในตัว)
FROM node:24-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/booking.db

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts

# ฐานข้อมูลอยู่ที่ /data — ต่อ volume/disk ถาวรไว้ที่นี่ ไม่งั้นข้อมูลหายเมื่อสร้าง container ใหม่
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
