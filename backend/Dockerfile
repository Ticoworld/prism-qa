# ── Stage 1: Build (compile TypeScript) ──────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.50.1-noble AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc --project tsconfig.json

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
# Playwright base image already has Chromium + all OS-level deps installed.
# No need to run playwright install again.
FROM mcr.microsoft.com/playwright:v1.50.1-noble

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy compiled JS from builder
COPY --from=builder /app/dist ./dist

# Cloud Run injects PORT at runtime (defaults to 8080)
ENV PORT=8080
ENV PLAYWRIGHT_HEADLESS=true
# Use the pre-installed browsers from the base image
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 8080

CMD ["node", "dist/server.js"]
