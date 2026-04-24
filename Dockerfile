# Single stage build
FROM node:20-alpine

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

# Copy backend files explicitly — avoids BuildKit /backend glob cache-key bug
COPY backend/package*.json ./backend/
COPY backend/tsconfig.json ./backend/
COPY backend/src/ ./backend/src/
COPY backend/prisma/ ./backend/prisma/

# Install backend deps and compile
WORKDIR /app/backend
RUN npm install
# Generate Prisma client (no db push — DATABASE_URL not available at build time)
RUN npx prisma generate
# Compile TypeScript only
RUN npx tsc

# Copy frontend into backend's static serve directory
RUN mkdir -p frontend-dist && cp -r /app/dist/* frontend-dist/
RUN echo "=== Backend frontend-dist ===" && ls -la frontend-dist/

EXPOSE 3000

CMD ["node", "dist/index.js"]
