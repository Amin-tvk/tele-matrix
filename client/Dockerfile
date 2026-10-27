# Peyvand web app. The bundle is built once with placeholders; the container fills in the domains and the
# push key from its environment when it starts, so the same image works for any deployment.
# The bundle is the same for every platform, so it is built natively and only the nginx stage is per platform
FROM --platform=$BUILDPLATFORM node:24-bookworm AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
ARG APP_TITLE=Peyvand
ENV APP_ENV=production \
    APP_TITLE=${APP_TITLE} \
    BASE_URL=https://__PEYVAND_APP_DOMAIN__ \
    MATRIX_HOMESERVER=https://__PEYVAND_MATRIX_DOMAIN__ \
    PUSH_APP_ID=__PEYVAND_PUSH_APP_ID__ \
    VAPID_PUBLIC_KEY=__PEYVAND_VAPID_PUBLIC_KEY__
RUN npx vite build && find dist -name "*.map" -delete

FROM nginx:1.27-alpine
COPY --from=build /app/dist /opt/peyvand/dist
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/40-peyvand-config.sh /docker-entrypoint.d/40-peyvand-config.sh
RUN chmod +x /docker-entrypoint.d/40-peyvand-config.sh
