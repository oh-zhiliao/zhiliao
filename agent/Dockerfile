# Release image: compiled JS, production deps only, no build tools.
# Requires zhiliao-build image (built from Dockerfile.base).
#
# Build:
#   docker build -t zhiliao-release:latest .
ARG BUILD_IMAGE=zhiliao-build
ARG BASE_IMAGE=node:22-slim

# --- Stage 1: compile TS ---
FROM ${BUILD_IMAGE} AS compiler
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc && npm prune --production

# --- Stage 2: slim runtime (no build tools) ---
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client && rm -rf /var/lib/apt/lists/* \
    && git config --global safe.directory '*'
WORKDIR /app
COPY --from=compiler /app/node_modules ./node_modules
COPY --from=compiler /app/dist ./dist
COPY package.json ./
COPY prompt/ ./prompt/
COPY entrypoint.sh ./entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "--import", "tsx/esm", "dist/src/index.js", "/app/config.yaml"]
