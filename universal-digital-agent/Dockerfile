# استخدام صورة Node.js خفيفة
FROM node:20-slim

# تثبيت Python 3 و pip
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# تعيين مجلد العمل
WORKDIR /app

# نسخ ملفات الحزم وتثبيت مكتبات Node.js
COPY package*.json ./
RUN npm install

# نسخ باقي ملفات المشروع
COPY . .

# تثبيت مكتبات Python المطلوبة
RUN pip3 install --upgrade agentsbazaar uagents-core --break-system-packages

# أمر التشغيل (تأكد من المسار الصحيح لملف التشغيل)
CMD ["node", "src/combinedServer.js"]
