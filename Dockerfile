# ==========================================
# Stage 1: Builder
# ==========================================
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package manifests
COPY package*.json ./

# Install all dependencies (including devDependencies) for compilation
RUN npm ci

# Copy source code and build configs
COPY tsconfig*.json nest-cli.json ./
COPY src/ ./src/

# Compile TypeScript to JavaScript (dist/)
RUN npm run build

# ==========================================
# Stage 2: Production Runtime
# ==========================================
FROM node:22-alpine AS production

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy package manifests and install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled artifacts from builder stage with node user ownership
COPY --from=builder --chown=node:node /app/dist ./dist

# Run under non-root user 'node'
USER node

# Expose HTTP port
EXPOSE 3000

# Healthcheck probe to /health/live
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health/live || exit 1

# Start production server using exec form for proper POSIX signal handling
CMD ["node", "dist/main.js"]
