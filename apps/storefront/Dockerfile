# The reference storefront (ADR 0020): its own image, separate from the server's (ADR 0009).
# Build from the repository root, which holds the lockfile and the SDK it is built against:
#   docker build -f apps/storefront/Dockerfile -t trestle-storefront .
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY apps/storefront/package.json apps/storefront/
RUN npm ci --workspace @trestle/storefront --workspace @trestle/sdk

COPY tsconfig.base.json ./
COPY packages/sdk packages/sdk
COPY apps/storefront apps/storefront
# The build bundles every runtime dependency into dist/ (see astro.config.mjs), so the image
# needs no node_modules.
RUN npm run build --workspace @trestle/storefront

FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4321
WORKDIR /app
COPY --from=build /app/apps/storefront/server.mjs ./
COPY --from=build /app/apps/storefront/dist ./dist
USER node
EXPOSE 4321
# Liveness only; /health/ready also checks the Store API and the key. 127.0.0.1, not
# localhost: Alpine resolves localhost to ::1 first, and the server listens on IPv4.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:4321/health/live || exit 1
CMD ["node", "server.mjs"]
