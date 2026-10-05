# --- calendar-flex CalDAV service: local development image (E02-R03) ---------
#
# `make dev` builds this; production images are built in CI, pinned by digest
# and owned by E08.
#
# PHP 8.4, per D-02. The body is the skeleton in public/ until E03-R01, which
# also adds `composer install` for SabreDAV and replaces the built-in server
# with a real SAPI (the runtime layout in `docs/02-technology-choices.md`
# suggests FrankenPHP in classic mode — never worker mode, SabreDAV is written
# for one request per process lifetime).
#
#   dockerfile: server/caldav/Dockerfile
#   context:    ../..   (the repository root, see infra/dev/compose.yaml)

FROM php:8.4-cli-alpine

WORKDIR /app
# The service directory as it stands: composer.json, README.md and public/.
COPY server/caldav/ ./

# Nothing in the skeleton writes to disk, and the built-in server needs no
# privileges, so it never runs as root inside the container either.
USER nobody

EXPOSE 8080
# `php -S` serves every request through the router script, so CalDAV methods
# reach PHP as well once E03-R01 implements them.
CMD ["php", "-S", "0.0.0.0:8080", "-t", "public", "public/index.php"]
