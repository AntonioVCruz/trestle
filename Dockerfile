# One image for every process role (ADR 0009): web | worker | scheduler | migrate.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/api-store/package.json packages/api-store/
COPY packages/api-admin/package.json packages/api-admin/
COPY packages/sdk/package.json packages/sdk/
COPY apps/server/package.json apps/server/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/server apps/server
RUN npx tsc -b apps/server \
 && npm prune --omit=dev \
 && mkdir /out && cp -a package.json node_modules /out/ \
 && for p in packages/core packages/api-store packages/api-admin apps/server; do \
      mkdir -p /out/$p && cp -a $p/package.json $p/dist /out/$p/; \
    done

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 9000
ENTRYPOINT ["node", "apps/server/dist/main.js"]
CMD ["web"]
