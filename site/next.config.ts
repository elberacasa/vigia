import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";
/** On Vercel the site is only ever served over HTTPS. */
const vercel = Boolean(process.env.VERCEL);

/**
 * The page makes no request to anyone but itself, and the browser enforces it. Scripts and styles need
 * 'unsafe-inline': the App Router streams its payload in inline scripts and the theme is applied by an inline script
 * before the first paint, and a static page cannot give them nonces. `next dev` also needs 'unsafe-eval'.
 */
const csp = [
	"default-src 'self'",
	`script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"media-src 'self'",
	"font-src 'self'",
	`connect-src 'self'${dev ? " ws:" : ""}`,
	"worker-src 'self' blob:",
	"manifest-src 'self'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'none'",
	"frame-ancestors 'none'",
	...(vercel ? ["upgrade-insecure-requests"] : []),
].join("; ");

const security = [
	{ key: "Content-Security-Policy", value: csp },
	{ key: "X-Content-Type-Options", value: "nosniff" },
	{ key: "X-Frame-Options", value: "DENY" },
	{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
	{
		key: "Permissions-Policy",
		value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
	},
	{ key: "Cross-Origin-Opener-Policy", value: "same-origin" },
	...(vercel ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
];

/**
 * Every page is static (SSG). On Vercel: import the repository, set the root directory to `site`; the framework
 * preset (Next.js), install command (bun install) and build command (next build) are detected. See README.md.
 */
const config: NextConfig = {
	reactStrictMode: true,
	// The site is its own project inside the repository (its own lockfile); don't walk up to the app's.
	turbopack: { root: import.meta.dirname },
	poweredByHeader: false,
	// app/global-not-found.tsx: one branded, bilingual 404 for the two root layouts (es and en).
	experimental: { globalNotFound: true },
	// The captures are at most 1440 px wide (720 CSS px at 2x) and the stills 2880: four widths cover every screen
	// and keep each srcset (in the HTML and again in the page's payload) short.
	images: { formats: ["image/avif", "image/webp"], deviceSizes: [640, 750, 960, 1440], imageSizes: [384] },
	async headers() {
		return [
			{ source: "/:path*", headers: security },
			{
				// Captured media carry a content hash in their names (src/data/media-files.json), so they never change.
				source: "/media/:path*",
				headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
			},
		];
	},
};

export default config;
