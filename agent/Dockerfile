ARG BASE_IMAGE=node:20-slim
FROM ${BASE_IMAGE}

ARG USE_CN_MIRROR=false
RUN if [ "$USE_CN_MIRROR" = "true" ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
    fi

RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client python3 make g++ && rm -rf /var/lib/apt/lists/* \
    && git config --global safe.directory '*'

WORKDIR /app

COPY package.json package-lock.json ./
RUN if [ "$USE_CN_MIRROR" = "true" ]; then \
      npm ci --registry=https://registry.npmmirror.com; \
    else \
      npm ci; \
    fi

COPY tsconfig.json ./
COPY src/ ./src/
COPY prompt/ ./prompt/

RUN npm run build && npm prune --production

COPY entrypoint.sh /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "--import", "tsx/esm", "dist/src/index.js", "/app/config.yaml"]
