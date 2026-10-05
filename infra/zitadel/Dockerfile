FROM node:24-alpine
# COPY directly: upstream's image deliberately disallows FROM inheritance.
# Version AND multi-architecture manifest digest pinned (D-19).
COPY --from=ghcr.io/opentofu/opentofu:1.13.1@sha256:1df996fca13806a20d5a3d3ad54acdcf76bcb1aa4ac30b5ba169b9e4cecdbcc8 /usr/local/bin/tofu /usr/local/bin/tofu
WORKDIR /config
ENTRYPOINT ["node", "/config/run.mjs"]
