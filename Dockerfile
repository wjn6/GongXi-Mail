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

# Copy frontend build to public
COPY --from=builder /app/web/dist ./public

# Set working directory to server
WORKDIR /app/server

# Apply committed migrations, then start server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]

EXPOSE 3000
