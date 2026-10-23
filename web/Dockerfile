# syntax=docker/dockerfile:1
FROM python:3.13-slim AS release-metadata
WORKDIR /repo
COPY LICENSE ./LICENSE
COPY App/Resources/AppInfo.json App/Resources/ProjectLicense.txt ./App/Resources/
COPY Config/App.xcconfig ./Config/App.xcconfig
COPY web/package.json ./web/package.json
COPY web/android/app/build.gradle ./web/android/app/build.gradle
COPY harmony/AppScope/app.json5 ./harmony/AppScope/app.json5
COPY scripts/generate-release-manifest.py ./scripts/generate-release-manifest.py
RUN python3 scripts/generate-release-manifest.py

FROM node:24-bookworm-slim AS build
WORKDIR /repo/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
COPY LICENSE /repo/LICENSE
COPY App/Resources/AppInfo.json App/Resources/ThirdPartyNotices.txt /repo/App/Resources/
COPY --from=release-metadata /repo/web/public/releases.json ./public/releases.json
# The Python stage already checked versions and license equality. Keep Python
# out of Node/runtime, while explicitly retaining the normal PDF asset step.
RUN npm run prepare:assets && npm run --ignore-scripts build

FROM node:24-bookworm-slim AS production-dependencies
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    NODE_OPTIONS=--max-old-space-size=192
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node web/package.json web/package-lock.json ./
COPY --chown=node:node LICENSE ./LICENSE
COPY --chown=node:node web/server ./server
COPY --chown=node:node web/src/shared ./src/shared
COPY --from=build --chown=node:node /repo/web/dist ./dist
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)throw Error('HTTP');return r.json()}).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "server/index.ts"]
