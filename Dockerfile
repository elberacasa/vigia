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

# --- ffmpeg, for the TV stills only (optional in Vigía, src/media/decoder.ts) ------------------------------------
# Built from the signed release with nothing but what the decoder's fixed arguments use: read raw H.264 from a pipe,
# decode one frame, deinterlace and scale it, write a PPM to a pipe. No network protocols, no other codec, format or
# device, no external library: a 2.8 MB program, +1.1 MB to the compressed image (measured 2026-09-29; Debian's
# ffmpeg package would add 207 packages and 467 MB), with a far smaller surface for the hostile bitstreams it may be
# fed. LGPL 2.1 or later; its licence, source address and configure line are kept next to it in the image
# (docs/OPERATIONS.md).
FROM debian:stable-slim AS ffmpeg
ARG FFMPEG_VERSION=9.0.2
# SHA-256 of ffmpeg-9.0.2.tar.xz, whose signature by the FFmpeg release key (FCF9 86EA 15E6 E293 A564 4F10 B432
# 2F04 D676 58D8) was verified when this line was written (2026-09-29).
ARG FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
ARG FFMPEG_JOBS=2
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl xz-utils build-essential nasm \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSLo ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
	&& echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
	&& tar -xf ffmpeg.tar.xz --strip-components=1 \
	&& rm ffmpeg.tar.xz
RUN set -e; flags="--disable-everything --disable-autodetect --disable-network --disable-doc --disable-ffplay \
		--disable-ffprobe --disable-debug --enable-small --disable-shared --enable-static \
		--enable-protocol=pipe --enable-demuxer=h264 --enable-parser=h264 --enable-decoder=h264 \
		--enable-encoder=ppm --enable-muxer=image2pipe --enable-filter=yadif,scale,setsar,format,null \
		--enable-swscale"; \
	./configure $flags \
	&& make -j"${FFMPEG_JOBS}" ffmpeg \
	&& strip ffmpeg \
	&& ./ffmpeg -hide_banner -version > /dev/null \
	&& mkdir -p /out/doc \
	&& cp ffmpeg /out/ffmpeg \
	&& cp COPYING.LGPLv2.1 /out/doc/ \
	&& printf 'FFmpeg %s, LGPL 2.1 or later (COPYING.LGPLv2.1).\nSource: https://ffmpeg.org/releases/ffmpeg-%s.tar.xz\nSHA-256: %s\nConfigured: %s\n' \
		"${FFMPEG_VERSION}" "${FFMPEG_VERSION}" "${FFMPEG_SHA256}" "$(echo $flags)" > /out/doc/BUILD

# --- Runtime: the executable, a user, a data volume -------------------------------------------------------------
FROM debian:stable-slim
# Bun carries its own root certificates, so no ca-certificates package is needed (verified: every HTTPS feed works).
COPY --from=ffmpeg /out/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /out/doc /usr/local/share/doc/ffmpeg
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
