# =============================================================================
# Scrapyard — single-image build (API + login page + gated web bundle).
#
# Build context is the REPO ROOT, because there is exactly one package.json and
# the shared types live outside apps/api:
#
#   docker build -f apps/api/Dockerfile -t scrapyard .
#
# The container serves three things on one port:
#   /login           server-rendered sign-in page  (public)
#   /api/*           the JSON API                  (guarded per route)
#   everything else  the React bundle              (302 -> /login without a session)
#
# The lo-fi JSON database is a mounted volume at /data, so racer files and
# scoreboards survive container replacement. Never bake it into the image.
# =============================================================================

# --- Stage 1: install everything and build both apps -------------------------
FROM node:22-alpine AS builder

WORKDIR /repo

# Manifest first, so `npm ci` is cached until a dependency actually moves.
COPY package.json package-lock.json ./

# --ignore-scripts: nothing here needs postinstall, and skipping it keeps the
# build hermetic. One manifest means one install — no --workspace flags.
RUN npm ci --ignore-scripts

# tsconfig.base.json carries the @scrapyard/shared path mapping, and
# packages/shared is outside apps/, so both are required for either app to compile.
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN npm run build:api && npm run build:web


# --- Stage 2: production-only dependencies -----------------------------------
# A separate stage so build tooling (TypeScript, Vite, Tailwind, ts-node, React)
# never reaches the final image. With a single manifest this prune is driven
# entirely by the dependencies / devDependencies split: every front-end library
# is a devDependency, because Vite bundles it at build time and Node never
# requires it. Measured effect: 402 packages / 221 MB -> 212 / 72 MB.
FROM node:22-alpine AS deps

WORKDIR /repo

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force


# --- Stage 3: runtime --------------------------------------------------------
FROM node:22-alpine AS runtime

# tini reaps zombies and forwards SIGTERM, so `docker stop` doesn't sit through
# the 10s kill timeout. wget is for the healthcheck.
RUN apk add --no-cache tini wget

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_DIR=/data \
    WEB_DIST_DIR=/app/public/web \
    WEB_LOGIN_ASSETS_DIR=/app/public/login

WORKDIR /app

COPY --from=deps    /repo/node_modules       ./node_modules
COPY --from=builder /repo/apps/api/dist      ./dist
COPY --from=builder /repo/package.json       ./package.json

# The gated React bundle, and the login page's own media.
COPY --from=builder /repo/apps/web/dist      ./public/web
COPY --from=builder /repo/apps/api/public/login ./public/login

# Run unprivileged. The node image already ships a `node` user (uid 1000).
# /data is chowned so the volume is writable on first mount.
RUN mkdir -p /data && chown -R node:node /data /app

VOLUME ["/data"]

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
