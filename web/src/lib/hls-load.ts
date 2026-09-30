import type Hls from "hls.js";

/**
 * hls.js (Apache-2.0, self-hosted: bundled into its own chunk, never fetched from a CDN) loads only when someone
 * presses play on a stream the browser cannot play by itself; the first load never carries it. Its light build
 * (~113 KiB gzip) is enough for live TV: no subtitles, no DRM, no alternate audio.
 */
let pending: Promise<typeof Hls> | null = null;

export function loadHls(): Promise<typeof Hls> {
	pending ??= import("hls.js/light").then(
		(m) => m.default,
		(err: unknown) => {
			pending = null;
			throw err;
		},
	);
	return pending;
}
