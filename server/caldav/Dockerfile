# Classic request lifecycle, never persistent PHP application state.
FROM docker.io/library/composer:2.10 AS composer
FROM docker.io/dunglas/frankenphp:1.13.0-php8.4.26-alpine AS base
RUN printf "expose_php=Off\n" > /usr/local/etc/php/conf.d/calflex.ini \
    && install-php-extensions pdo_pgsql \
    && addgroup -g 10001 calflex && adduser -D -u 10001 -G calflex calflex \
    && mkdir -p /app /tmp/calflex-data /tmp/calflex-config \
    && chown -R calflex:calflex /app /tmp/calflex-data /tmp/calflex-config
COPY --from=composer /usr/bin/composer /usr/local/bin/composer
WORKDIR /app
ENV XDG_DATA_HOME=/tmp/calflex-data XDG_CONFIG_HOME=/tmp/calflex-config
USER calflex
FROM base AS dependencies
COPY --chown=calflex:calflex server/caldav/composer.json server/caldav/composer.lock ./
RUN composer install --no-dev --no-interaction --no-scripts
COPY --chown=calflex:calflex server/caldav/src ./src
COPY --chown=calflex:calflex server/caldav/public ./public
COPY --chown=calflex:calflex server/caldav/internal ./internal
COPY --chown=calflex:calflex server/caldav/Caddyfile ./Caddyfile
RUN composer dump-autoload --no-dev --classmap-authoritative
FROM dependencies AS test
RUN composer install --no-interaction --no-scripts
COPY --chown=calflex:calflex server/caldav/tests ./tests
RUN composer dump-autoload
ENTRYPOINT ["php", "vendor/bin/phpunit", "--no-configuration", "--do-not-cache-result", "tests/Integration"]
FROM dependencies AS runtime
EXPOSE 8080 8081
ENTRYPOINT ["frankenphp", "run", "--config", "/app/Caddyfile", "--adapter", "caddyfile"]
