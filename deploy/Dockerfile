# Dockify release images, built from one commit:
#   control  api, worker, agent, updater and the migration runner (one Prisma client, one schema)
#   web      the Next.js dashboard, standalone output only
#
#   docker build -f deploy/Dockerfile --target control -t dockify-control .
#   docker build -f deploy/Dockerfile --target web     -t dockify-web .
#
# Every input is pinned, so two builds of one commit install the same bytes:
#   base image   by digest
#   apk          exact package versions (a bump upstream fails the build instead of drifting)
#   pnpm         version plus sha512 of the npm tarball, checked by corepack
#   prisma CLI   npm ci against the committed deploy/prisma-cli/package-lock.json
#   context      .dockerignore is an allowlist; no node_modules, build output or .env from the build machine
# Bump any pin only in a reviewed commit:
#   docker buildx imagetools inspect node:22.21.1-alpine3.22 --format '{{json .Manifest.Digest}}'
#   npm view pnpm@<version> dist.integrity   (base64; the ARG below is the same digest in hex)
#   apk versions: the APKINDEX of the Alpine branch in NODE_IMAGE
#
# Release builds run from a fresh clone (git clean -fdx), with provenance and an SBOM attached:
#   docker buildx build -f deploy/Dockerfile --target control --provenance=true --sbom=true .

ARG NODE_IMAGE=node:22.21.1-alpine3.22@sha256:b2358485e3e33bc3a33114d2b1bdb18cdbe4df01bd2b257198eb51beb1f026c5
ARG PNPM_VERSION=11.10.0
ARG PNPM_SHA512=0b7f8b98060031904c017e3a41eb187a16d40eeb829b95c4f8cb03681761fc4ab53dd219115b9b447f4dce1a05a214764461e7d3703392a9f32f9511ce8c86c8

# ---------------------------------------------------------------- base
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ARG PNPM_SHA512
# libc6-compat and openssl: Prisma's query engine on musl.
RUN apk add --no-cache libc6-compat=1.1.0-r4 openssl=3.5.9-r0 \
 && corepack enable && corepack prepare "pnpm@${PNPM_VERSION}+sha512.${PNPM_SHA512}" --activate
# pnpm is now in the corepack cache; corepack must never fetch another one.
ENV COREPACK_ENABLE_NETWORK=0
WORKDIR /src

# ---------------------------------------------------------------- builders
# Railpack and the mise it looks versions up with, for repositories with no Dockerfile. Fetched here
# and checked against these sums, so nothing is fetched unverified when a tenant builds. The worker
# hands them to the plan step in the BuildKit sandbox; it never runs them itself. Both are MIT
# licensed: their licenses stay beside them. Bump with apps/worker/src/deploy/railpack.ts.
#   railpack  https://github.com/railwayapp/railpack/releases (checksums.txt)
#   mise      the version in core/mise/version.txt at that tag; https://github.com/jdx/mise/releases (SHASUMS256.txt)
FROM ${NODE_IMAGE} AS builders
ARG TARGETARCH
ARG RAILPACK_VERSION=0.43.0
ARG RAILPACK_SHA256_AMD64=248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb
ARG RAILPACK_SHA256_ARM64=732ece14eb4f4676a43ebba19431f954edf7b130acb76159ef0f2ff86ac42ac9
ARG MISE_VERSION=2026.10.14
ARG MISE_SHA256_AMD64=0f95d528ad0b8c54f7022be2ff22a36be149123ff9b27bdaa216d349a9f59c17
ARG MISE_SHA256_ARM64=8f7fa64c3d08ba515aac501f18f6f43c00c381793185380fd1a92c411c00cdde
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) rp_arch=x86_64; rp_sum="$RAILPACK_SHA256_AMD64"; mise_arch=x64; mise_sum="$MISE_SHA256_AMD64" ;; \
      arm64) rp_arch=arm64; rp_sum="$RAILPACK_SHA256_ARM64"; mise_arch=arm64; mise_sum="$MISE_SHA256_ARM64" ;; \
      *) echo "unsupported architecture ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/dockify/builders /tmp/rp /tmp/mise; \
    fetch() { i=0; until wget -T 30 -qO "$1" "$2"; do i=$((i + 1)); [ "$i" -lt 5 ] || return 1; sleep $((i * 3)); done; }; \
    fetch /tmp/rp.tgz "https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/railpack-v${RAILPACK_VERSION}-${rp_arch}-unknown-linux-musl.tar.gz"; \
    echo "$rp_sum  /tmp/rp.tgz" | sha256sum -c -; \
    fetch /tmp/mise.tgz "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${mise_arch}-musl.tar.gz"; \
    echo "$mise_sum  /tmp/mise.tgz" | sha256sum -c -; \
    tar -xzf /tmp/rp.tgz -C /tmp/rp railpack LICENSE; \
    tar -xzf /tmp/mise.tgz -C /tmp/mise mise/bin/mise mise/LICENSE; \
    install -m 0755 /tmp/rp/railpack /opt/dockify/builders/railpack; \
    install -m 0755 /tmp/mise/mise/bin/mise /opt/dockify/builders/mise; \
    install -m 0644 /tmp/rp/LICENSE /opt/dockify/builders/LICENSE.railpack; \
    install -m 0644 /tmp/mise/mise/LICENSE /opt/dockify/builders/LICENSE.mise; \
    rm -rf /tmp/rp /tmp/mise /tmp/rp.tgz /tmp/mise.tgz

# ---------------------------------------------------------------- control: dependencies
FROM base AS control-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/agent/package.json apps/agent/
COPY packages/contracts/package.json packages/contracts/
COPY packages/crypto/package.json packages/crypto/
COPY packages/db/package.json packages/db/
COPY packages/email/package.json packages/email/
COPY packages/engine/package.json packages/engine/
COPY packages/net-guard/package.json packages/net-guard/
COPY packages/notify/package.json packages/notify/
COPY packages/redact/package.json packages/redact/
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------- control: build
FROM control-deps AS control-build
COPY apps/api apps/api
COPY apps/worker apps/worker
COPY apps/agent apps/agent
COPY packages packages
# release-toolkit.test.ts typechecks against the release toolkit. It stays in this stage: the
# runtime below copies only apps and packages.
COPY scripts/release/make-manifest.mjs scripts/release/make-manifest.d.mts scripts/release/
RUN pnpm --filter @dockify/db generate \
 && pnpm --filter @dockify/api --filter @dockify/worker --filter @dockify/agent --filter @dockify/engine --filter @dockify/db --filter @dockify/contracts --filter @dockify/crypto --filter @dockify/email --filter @dockify/notify typecheck
# Runtime gets production dependencies only; the generated Prisma client lives outside node_modules.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && pnpm install --frozen-lockfile --prod --offline \
 && find apps packages \( -name '*.test.ts' -o -name '*.fixture.ts' \) -delete
# The migration CLI, at the version pnpm-lock.yaml pins for the client, with its whole tree locked.
COPY deploy/prisma-cli/package.json deploy/prisma-cli/package-lock.json /opt/prisma/
RUN npm ci --prefix /opt/prisma --no-fund --no-audit

# ---------------------------------------------------------------- control: runtime
FROM base AS control
ARG DOCKIFY_VERSION=0.0.0-dev
# DOCKIFY_IMAGE_VERSION is what this image is, whatever compose sets DOCKIFY_VERSION to: the updater's downgrade check reads it.
ENV NODE_ENV=production DOCKIFY_VERSION=${DOCKIFY_VERSION} DOCKIFY_IMAGE_VERSION=${DOCKIFY_VERSION}
# git: the worker clones repositories. docker-cli and compose: the updater only.
# postgresql17-client: same major as the control-plane postgres, for dumps and restores.
RUN apk add --no-cache git=2.49.1-r0 docker-cli=28.3.3-r5 docker-cli-compose=2.36.2-r5 postgresql17-client=17.11-r0
# buildctl, the BuildKit client the agent drives every build with, from the exact daemon image the
# compose file pins, so client and daemon never drift. docker-compose.yml uses the same digest.
COPY --from=moby/buildkit:v0.25.1-rootless@sha256:0c0ce4929976ace509f7a53878303504b2de8857829aea4932af9f7325a30f51 /usr/bin/buildctl /usr/local/bin/buildctl
COPY --from=builders /opt/dockify/builders /opt/dockify/builders
WORKDIR /app
# Root-owned on purpose: the runtime user can read the code but never patch it in place.
COPY --from=control-build /src/package.json /src/pnpm-workspace.yaml ./
COPY --from=control-build /src/node_modules ./node_modules
COPY --from=control-build /src/apps/api ./apps/api
COPY --from=control-build /src/apps/worker ./apps/worker
COPY --from=control-build /src/apps/agent ./apps/agent
COPY --from=control-build /src/packages ./packages
COPY --from=control-build /opt/prisma /opt/prisma
COPY deploy/entrypoint.sh /usr/local/bin/dockify-entrypoint
# The release signing key, pinned in the image: the updater trusts it over the installer's copy, so
# a rotation travels inside a release the previous key signed (docs/RELEASING.md). A comment-only
# file (no key yet) leaves self-update to the key the installer wrote.
COPY deploy/release.pub /etc/dockify/release.pub
# The worker's volumes mount over these folders. Docker gives an empty named volume the owner of
# the folder it mounts over, so both belong to the runtime user from the first start: the work
# folder held root's 755 before, and every backup failed with EACCES. install.sh
# --upgrade hands an older, non-empty volume to the same user.
RUN chmod 0755 /usr/local/bin/dockify-entrypoint \
 && mkdir -p /var/lib/dockify/backups /var/lib/dockify/work /var/lib/dockify/agent \
 && chown node:node /var/lib/dockify/backups /var/lib/dockify/work /var/lib/dockify/agent
USER node
ENTRYPOINT ["/usr/local/bin/dockify-entrypoint"]
CMD ["api"]
# The role decides what healthy means; docker-compose.yml sets one per service.
HEALTHCHECK NONE

# ---------------------------------------------------------------- web: build
FROM base AS web-build
WORKDIR /web
COPY apps/web/package.json apps/web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
# Source only, one path per line (a multi-source COPY would flatten the folders).
# node_modules stays exactly what the frozen install above produced.
COPY apps/web/app ./app
COPY apps/web/components ./components
COPY apps/web/lib ./lib
COPY apps/web/public ./public
COPY apps/web/next.config.ts apps/web/tsconfig.json apps/web/proxy.ts ./
RUN NEXT_TELEMETRY_DISABLED=1 pnpm build

# ---------------------------------------------------------------- web: runtime
FROM ${NODE_IMAGE} AS web
ARG DOCKIFY_VERSION=0.0.0-dev
# The release this image was built as, which Settings shows: the same tag builds the control image.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 DOCKIFY_IMAGE_VERSION=${DOCKIFY_VERSION}
WORKDIR /app
COPY --from=web-build /web/.next/standalone ./
COPY --from=web-build /web/.next/static ./.next/static
COPY --from=web-build /web/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:3000/login',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
