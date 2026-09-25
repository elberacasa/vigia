# Vigía as a container: one self-contained executable (the web client embedded) on a minimal Debian base, run as a
# non-root user with a read-only root filesystem. By default it is a public read-only mirror (VIGIA_MODE=public):
# writes are disabled and keys come from the environment. See docs/OPERATIONS.md.
#
#   docker build -t vigia .
#   docker compose up -d        (compose.yaml: volume, health check, hardening)

# --- Build: compile the executable for the target architecture -------------------------------------------------
FROM oven/bun:1.4.2 AS build
ARG TARGETARCH
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN case "${TARGETARCH:-amd64}" in \
		amd64) target=linux-x64 ;; \
		arm64) target=linux-arm64 ;; \
		*) echo "Arquitectura no soportada: ${TARGETARCH}" >&2; exit 1 ;; \
	esac \
	&& QUIET=1 bun scripts/build-bin.ts "$target" \
	&& mv "dist/vigia-$(bun -e 'console.log(require("./package.json").version)')-$target" /vigia \
	&& /vigia --help > /dev/null

# --- Runtime: the executable, a user, a data volume -------------------------------------------------------------
FROM debian:stable-slim
# Bun carries its own root certificates, so no ca-certificates package is needed (verified: every HTTPS feed works).
RUN useradd --system --uid 10001 --user-group --home-dir /data --no-create-home --shell /usr/sbin/nologin vigia \
	&& mkdir -p /data \
	&& chown vigia:vigia /data \
	&& chmod 700 /data
COPY --from=build /vigia /usr/local/bin/vigia
USER 10001:10001
ENV VIGIA_HOME=/data \
	VIGIA_HOST=0.0.0.0 \
	VIGIA_PORT=7722 \
	VIGIA_MODE=public \
	VIGIA_NO_OPEN=1
VOLUME ["/data"]
EXPOSE 7722
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 CMD ["vigia", "healthcheck"]
ENTRYPOINT ["vigia"]
