# node:20-slim (Debian/glibc) — Prisma binaries require glibc + OpenSSL
FROM node:20-slim

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Single COPY avoids Railway BuildKit per-directory cache-key bug
COPY . .

# Build frontend (root package.json build = vite build)
RUN npm install
RUN npm run build
RUN echo "=== Frontend build ===" && ls -la dist/

# Build backend — plain npm install so Prisma can download its engine binaries
# (no prepare/postinstall in package.json, so prisma db push never runs here)
WORKDIR /app/backend
RUN npm install
RUN npx prisma generate
RUN npx tsc

# Copy frontend dist into backend's static serve directory
RUN mkdir -p frontend-dist && cp -r /app/dist/* frontend-dist/
RUN echo "=== Backend frontend-dist ===" && ls -la frontend-dist/

EXPOSE 3000

CMD ["node", "dist/index.js"]
