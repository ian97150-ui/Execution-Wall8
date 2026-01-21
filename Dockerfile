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

# Setup backend
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install
COPY backend/ .
RUN npx prisma generate
RUN npm run build

# Copy frontend to backend's frontend-dist
RUN mkdir -p frontend-dist && cp -r /app/dist/* frontend-dist/
RUN echo "=== Backend frontend-dist ===" && ls -la frontend-dist/

# Expose port
EXPOSE 3000

# Start the server
CMD ["node", "dist/index.js"]
