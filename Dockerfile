# node:20-slim (Debian) — avoids Alpine musl/OpenSSL binary incompatibility with Prisma
FROM node:20-slim

# Prisma's schema engine requires OpenSSL
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy entire context at once (node_modules excluded via .dockerignore)
COPY . .

# Build frontend
RUN npm install
RUN npm run build
RUN echo "=== Frontend build ===" && ls -la dist/

# Build backend — ignore-scripts prevents prisma db push firing without DATABASE_URL
WORKDIR /app/backend
RUN npm install --ignore-scripts
RUN npx prisma generate
RUN npx tsc

# Copy frontend into backend's static serve directory
RUN mkdir -p frontend-dist && cp -r /app/dist/* frontend-dist/
RUN echo "=== Backend frontend-dist ===" && ls -la frontend-dist/

EXPOSE 3000

CMD ["node", "dist/index.js"]
