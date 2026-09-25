/**
 * The requests the wall makes as soon as it starts. scripts/build-web.ts writes a `<link rel="preload">` for each
 * into index.html, so on a slow link they are already on their way while the app's script downloads (the app's own
 * fetches then take the preloaded responses). Pure data: imported by lib/data.ts and by the build.
 */

/** Heavy lists, fetched after the small panels so a slow phone shows the room sooner. */
export const HEAVY = [
	"news",
	"censorship",
	"netwatch",
	"satellite",
	"nightlights",
	"ai",
	"brief",
	"energy",
	"attention",
	"markets",
	"humanitarian",
	"gazette",
	"user-news",
] as const;

export const META_URL = "/api/meta";
export const LIGHT_PANELS_URL = `/api/panels?except=${HEAVY.join(",")}`;
export const HEAVY_PANELS_URL = `/api/panels?only=${HEAVY.join(",")}`;
export const HEALTH_URL = "/api/health";

/** Preloaded by index.html: what the first screen needs (the heavy lists follow once these are in). */
export const FIRST_REQUESTS = [LIGHT_PANELS_URL, META_URL, HEALTH_URL] as const;
