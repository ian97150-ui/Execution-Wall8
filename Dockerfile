# Build stage for frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Build stage for backend
FROM node:20-alpine AS backend-build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install
COPY backend/ .
RUN npx prisma generate
RUN npm run build

# Production stage
FROM node:20-alpine AS production
WORKDIR /app

# Copy backend dist and node_modules
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=backend-build /app/backend/node_modules ./node_modules
COPY --from=backend-build /app/backend/package*.json ./
COPY --from=backend-build /app/backend/prisma ./prisma

# Regenerate Prisma client for this platform
RUN npx prisma generate

# Copy frontend dist to frontend-dist folder
COPY --from=frontend-build /app/dist ./frontend-dist

# Debug: List files to verify structure
RUN echo "=== App structure ===" && ls -la && echo "=== Frontend files ===" && ls -la frontend-dist && echo "=== Dist files ===" && ls -la dist

# Expose port
EXPOSE 3000

# Start the server
CMD ["node", "dist/index.js"]
