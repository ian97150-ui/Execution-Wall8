# Single stage build — uses COPY . . to avoid BuildKit /backend path cache-key bug
FROM node:20-alpine

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

# prisma db push runs at startup when DATABASE_URL is available
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/index.js"]
