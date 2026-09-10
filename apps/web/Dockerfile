FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --workspace=@notes/web
COPY apps/web apps/web
RUN npm run build --workspace=@notes/web

FROM nginxinc/nginx-unprivileged:1.30-alpine
USER 101
# Substituted into the config by the nginx entrypoint at startup.
ENV API_ORIGIN=http://api:3000
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/default.conf.template /etc/nginx/templates/default.conf.template
COPY apps/web/security-headers.conf /etc/nginx/security-headers.conf
EXPOSE 8080