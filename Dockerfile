# ============================================================
# Quota — Multi-stage Docker Build
# ============================================================
# Stage 1: Install dependencies and compile TypeScript
# Stage 2: Production image with only compiled JS + node_modules
# ============================================================

FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

# ── Production Stage ──────────────────────────────────────────

FROM node:20-alpine AS production

WORKDIR /app

# Security: run as non-root
RUN addgroup -g 1001 -S quota && adduser -S quota -u 1001 -G quota

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3100/api/v1/health || exit 1

USER quota

EXPOSE 3100

CMD ["node", "dist/index.js"]
