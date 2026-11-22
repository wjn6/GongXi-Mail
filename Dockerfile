# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies for server
COPY server/package*.json ./server/
RUN cd server && npm install

# Install dependencies for frontend
COPY web/package*.json ./web/
RUN cd web && npm install --legacy-peer-deps

# Copy source code
COPY server ./server
COPY web ./web

# Generate Prisma client
RUN cd server && npx prisma generate

# Build server
RUN cd server && npm run build

# Build frontend
RUN cd web && npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy server
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY --from=builder /app/server/package.json ./server/
COPY --from=builder /app/server/prisma ./server/prisma
COPY --from=builder /app/server/scripts ./server/scripts

# Copy frontend build to public
COPY --from=builder /app/web/dist ./public

# Set working directory to server
WORKDIR /app/server

# Apply migrations (auto-baselines legacy db-push databases), then start server
CMD ["sh", "-c", "node scripts/migrate-up.mjs && node dist/index.js"]

EXPOSE 3000
