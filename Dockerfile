# node:20-slim (Debian/glibc) — Prisma binaries require glibc + OpenSSL
FROM node:20-slim

RUN apt-get update -y && apt-get install -y openssl python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages yfinance requests

WORKDIR /app

# Copy only what the backend needs — faster builds, no Vite/React deps
COPY backend ./backend
COPY python ./python

WORKDIR /app/backend

RUN npm install
RUN npx prisma generate
RUN npx tsc

EXPOSE 3000

CMD ["node", "dist/index.js"]
