# node:20-slim (Debian) — Prisma requires glibc + OpenSSL, both present here
FROM node:20-slim

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install frontend dependencies and build
COPY package*.json ./
RUN npm install
COPY src/ ./src/
COPY public/ ./public/
COPY index.html ./
COPY vite.config.js ./
COPY tailwind.config.js ./
COPY postcss.config.js ./
COPY components.json ./
COPY jsconfig.json ./
RUN npm run build
RUN echo "=== Frontend build ===" && ls -la dist/

# Setup backend (WORKDIR set first so COPY backend/ . lands in /app/backend)
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install
COPY backend/ .
RUN npx prisma generate
RUN npx tsc

# Copy frontend into backend's static serve directory
RUN mkdir -p frontend-dist && cp -r /app/dist/* frontend-dist/
RUN echo "=== Backend frontend-dist ===" && ls -la frontend-dist/

EXPOSE 3000

CMD ["node", "dist/index.js"]
