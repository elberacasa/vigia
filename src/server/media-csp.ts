import { isIP } from "node:net";
import { iptvVeProbe, type TvReading } from "../adapters/iptv-ve/index.ts";
import { type RadioDirReading, radioBrowserProbe } from "../adapters/radio-browser/index.ts";
import { streamOrigins } from "../adapters/radio-streams/stations.ts";
import type { Store } from "../core/store.ts";
import { isPublicAddress } from "../userfeeds/net.ts";

/**
 * The Content-Security-Policy, with the live TV and radio hosts the page may play from.
 *
 * The directories (iptv-org, Radio Browser) list ~170 streams on ~110 hosts that change as broadcasters move. Two ways
 * to let the page play them were weighed (decided 2026-09-28):
 * - **Proxy** every stream through Vigía: one origin, a short CSP, but Vigía would relay broadcasters' audio and
 *   video (their copyright; a public mirror would carry every viewer's stream) and pay the bandwidth. Rejected.
 * - **Allow each host the probes saw**, per stream (chosen): the HTML page's CSP lists the origins that the
 *   last day's probes fetched from (playlist, variant and segment hosts after redirects), `media-src` for every one
 *   (an <audio>/<video> element, Safari's native HLS) and `connect-src` only for HLS hosts that allowed any origin
 *   (hls.js reads playlists and segments with fetch). `blob:` in `media-src` is the MediaSource hls.js plays from.
 *   A host the probes never saw stays blocked: the page cannot be made to load media from an arbitrary host.
 * Only HTML documents carry the long policy (it governs the page); API responses keep the short one.
 */

const BASE = {
	"default-src": ["'self'"],
	"img-src": ["'self'", "data:", "blob:"],
	"style-src": ["'self'", "'unsafe-inline'"],
	"script-src": ["'self'"],
	"connect-src": ["'self'"],
	"font-src": ["'self'"],
	"frame-src": ["https://www.youtube-nocookie.com"],
	"media-src": ["'self'", ...streamOrigins()],
	"frame-ancestors": ["'none'"],
	"base-uri": ["'none'"],
	"form-action": ["'self'"],
} as const;

/** The policy for every response that is not a page: frames from youtube-nocookie, media from the curated radios. */
export const STATIC_CSP = render({});

/**
 * An origin is only ever `http(s)://host[:port]`: nothing a stored value could use to inject a directive. Plain-HTTP
 * origins matter only when Vigía itself is served over http://localhost (an HTTPS page blocks them as mixed content).
 */
const ORIGIN = /^https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i;

export type MediaOrigins = { media: string[]; connect: string[] };

type Extra = "media-src" | "connect-src" | "frame-src";

function render(extra: Partial<Record<Extra, readonly string[]>>): string {
	return Object.entries(BASE)
		.map(([name, values]) => {
			const more = extra[name as Extra] ?? [];
			return `${name} ${[...new Set([...values, ...more])].join(" ")}`;
		})
		.join("; ");
}

const DAY = 24 * 3_600_000;

/**
 * Bounds that keep one listing from taking the page down (whole-release review, B2: three Radio Browser entries whose
 * master playlist named 3,723 variant hosts made a 343 KB policy, and Bun drops a response whose headers are that
 * large, so every visitor got an empty page). A reading contributes at most 4 origins, the page at most 300 (the
 * directories have ~110 hosts), and a policy longer than 16 KB is replaced by the static one: the page loads, the
 * directory streams just cannot play in it until the list is sane.
 */
export const MAX_ORIGINS_PER_READING = 4;
export const MAX_ORIGINS = 300;
export const MAX_CSP_BYTES = 16 * 1024;

/** A literal private or loopback address, or a local-only name: never a host the page plays from. */
function publicOrigin(origin: string): boolean {
	let host: string;
	try {
		host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
	} catch {
		return false;
	}
	if (isIP(host)) return isPublicAddress(host);
	return !/(^|\.)(local|internal|lan|localhost|localdomain|onion|home\.arpa)$/i.test(host);
}

/** Pure over the store: the origins the last day's live TV and radio probes fetched from. */
export function mediaOrigins(store: Store, now: number): MediaOrigins {
	const media = new Set<string>();
	const connect = new Set<string>();
	const add = (origins: readonly string[], cors: boolean) => {
		for (const o of origins.slice(0, MAX_ORIGINS_PER_READING)) {
			if (media.size >= MAX_ORIGINS) return;
			if (!ORIGIN.test(o) || !publicOrigin(o)) continue;
			media.add(o.toLowerCase());
			if (cors) connect.add(o.toLowerCase());
		}
	};
	for (const o of store.latestPerSeries<TvReading>(iptvVeProbe.id, now - DAY, 5_000))
		if (o.value.state === "live") add(o.value.origins, o.value.cors);
	for (const o of store.latestPerSeries<RadioDirReading>(radioBrowserProbe.id, now - DAY, 5_000))
		if (o.value.state === "live") add(o.value.origins, o.value.kind === "hls" && o.value.cors === true);
	return { media: [...media].sort(), connect: [...connect].sort() };
}

/**
 * Players the page may frame besides YouTube's: Windy's public webcam player, for cameras their operator publishes
 * only on Windy (src/cameras/list.ts). Only the page carries it (API responses keep the static policy), and the frame
 * loads only after the viewer presses play.
 */
export const PAGE_FRAMES = ["https://webcams.windy.com/webcams/public/embed/player/"] as const;

/** The page's policy: the static one plus the probed media hosts, and blob: for hls.js when any HLS host is allowed. */
export function pageCsp(origins: MediaOrigins): string {
	const blob = origins.connect.length > 0 ? ["blob:"] : [];
	const csp = render({
		"media-src": [...blob, ...origins.media],
		"connect-src": origins.connect,
		"frame-src": PAGE_FRAMES,
	});
	return Buffer.byteLength(csp) > MAX_CSP_BYTES ? render({ "frame-src": PAGE_FRAMES }) : csp;
}

/** Recomputes the page policy at most once a minute (probes run every 30–60 min). */
export function pageCspSource(store: Store, now: () => number, maxAgeMs = 60_000): () => string {
	let cached: { at: number; csp: string } | null = null;
	return () => {
		const t = now();
		if (!cached || t - cached.at >= maxAgeMs) {
			let csp = STATIC_CSP;
			try {
				csp = pageCsp(mediaOrigins(store, t));
			} catch {
				// A store error must not take the page down: the static policy still serves it.
			}
			cached = { at: t, csp };
		}
		return cached.csp;
	};
}
