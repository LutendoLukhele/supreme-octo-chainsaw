# --- Build Stage ---
# Debian slim is deliberate here: onnxruntime-node ships native Linux binaries
# for the glibc ecosystem. Alpine's musl base makes the ML runtime lane brittle.
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Install build dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy package files for all workspaces
COPY package*.json ./
COPY turbo.json ./
COPY packages/cortex/package.json ./packages/cortex/package.json
COPY packages/intent-engine/package.json ./packages/intent-engine/package.json
COPY packages/interfaces/package.json ./packages/interfaces/package.json
COPY packages/observability/package.json ./packages/observability/package.json
COPY packages/workflow-contracts/package.json ./packages/workflow-contracts/package.json
COPY apps/backend/package.json ./apps/backend/package.json

# Cache downloaded packages across retries/builds; registry resets should not
# force a full dependency redownload.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev \
      --fetch-retries=5 \
      --fetch-retry-mintimeout=20000 \
      --fetch-retry-maxtimeout=120000

# Copy source code
COPY packages/ ./packages/
COPY apps/ ./apps/
COPY src/ ./src/
COPY config/ ./config/
COPY tsconfig.json ./

# Build all packages with Turbo, then build legacy src
RUN npm run build && npm run build:legacy

# Remove development dependencies
RUN npm prune --production && npm cache clean --force

# --- Production Stage ---
# Keep the runtime image on the same glibc family as the native ONNX package.
FROM node:20-bookworm-slim
WORKDIR /app

# Install runtime dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends dumb-init curl tini ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user before copying app files so COPY --chown can avoid an
# expensive recursive chown over node_modules.
RUN groupadd --gid 1001 nodejs && \
    useradd --uid 1001 --gid nodejs --create-home --shell /usr/sbin/nologin nodejs

# Copy necessary files from the build stage
COPY --chown=nodejs:nodejs --from=builder /app/package*.json ./
COPY --chown=nodejs:nodejs --from=builder /app/dist ./dist
COPY --chown=nodejs:nodejs --from=builder /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs --from=builder /app/config ./config
COPY --chown=nodejs:nodejs --from=builder /app/packages ./packages

# Create application directories
RUN mkdir -p /app/logs /app/sessions /app/data /app/.data /app/models /app/uploads && \
    chown -R nodejs:nodejs /app/logs /app/sessions /app/data /app/.data /app/models /app/uploads

# Set environment defaults with bootstrap configuration
ENV NODE_ENV=production
ENV PORT=8080
ENV LOG_LEVEL=info
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318/v1/traces
ENV RATE_LIMIT_ENABLED=true
ENV RATE_LIMIT_MAX_REQUESTS=300
ENV CPU_THRESHOLD_WARNING=70
ENV CPU_THRESHOLD_CRITICAL=85
ENV MEMORY_THRESHOLD_WARNING=80
ENV MEMORY_THRESHOLD_CRITICAL=92
ENV ML_INTENT_MODEL_DIR=/app/models/intent_classifier
ENV ML_NER_MODEL_DIR=/app/models/ner_extractor
ENV PLANNER_LLM_WARMUP_ENABLED=false

USER nodejs

# Health check endpoint with bootstrap status
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8080/health/detailed || exit 1

EXPOSE 8080 9090

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]

# --- done ---
