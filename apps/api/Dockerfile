FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY prisma prisma
RUN npm ci --workspace=@notes/api
COPY apps/api apps/api
RUN npm run prisma:generate && npm run build --workspace=@notes/api

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat tini
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY prisma prisma
RUN npm ci --omit=dev --workspace=@notes/api
COPY --from=build /app/apps/api/dist apps/api/dist

# The runtime only ever invokes node and the local prisma CLI, so npm is dead weight that drags
# its own vulnerable bundled dependency tree into the image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

RUN chown -R node:node /app
USER node
EXPOSE 3000
# tini reaps zombies and forwards SIGTERM so the graceful shutdown path actually runs.
ENTRYPOINT ["/sbin/tini", "--"]
# Migrations and the first-run seed are run by the chart's pre-upgrade Job, not by every replica.
CMD ["node", "apps/api/dist/server.js"]