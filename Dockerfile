# syntax=docker/dockerfile:1.7
# ---- builder: web export + server build + production node_modules ----
# Runs on the build host's native platform; the output is pure JavaScript
# (no native addons), so one build is valid for amd64 and arm64.
FROM --platform=$BUILDPLATFORM node:24 AS builder
WORKDIR /src
COPY packaging/build-release.mjs packaging/config.env.example packaging/
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.txt ./
COPY server/package.json server/package-lock.json server/tsconfig.json server/tsconfig.build.json server/
COPY server/src server/src
COPY app/package.json app/package-lock.json app/
RUN cd app && npm ci --no-audit --no-fund
COPY app/ app/
RUN node packaging/build-release.mjs --out /stage

# ---- runtime ----
FROM node:24-slim
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    WEB_DIR=/app/web \
    ALLOW_REGISTRATION=0
WORKDIR /app
COPY --from=builder --chown=node:node /stage/server/ /app/
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
