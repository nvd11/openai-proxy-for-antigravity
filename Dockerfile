# Stage 1: Build TypeScript
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package manifests
COPY package*.json ./

# Install dependencies (including devDependencies for TypeScript compiler)
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy TypeScript config and source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript and copy static dashboard
RUN npm run build

# Stage 2: Production runner
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV CONFIG_DIR=/etc/antigravity-proxy
ENV ROTATION_STRATEGY=round-robin

# Copy built artifacts and install production dependencies only
COPY --from=builder /app/dist ./dist
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

EXPOSE 3000

# Cloud-native health check probe
HEALTHCHECK --interval=20s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

# Run as non-root user
USER node

CMD ["node", "dist/server.js"]
