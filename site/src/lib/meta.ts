import type { Metadata, Viewport } from "next";
import { facts } from "./data";
import { type Lang, PATHS, type Page, tr } from "./i18n";

/**
 * The public address, for the canonical URL, hreflang, the link-preview image, robots.txt and the sitemap: SITE_URL
 * if set, else Vercel's production domain. A production build without either fails, so a mirror built elsewhere can
 * never ship localhost URLs; `bun run check` sets SITE_URL explicitly for its local build. `next dev` uses localhost.
 */
function siteUrl(): URL {
	const set =
		process.env.SITE_URL ??
		(process.env.VERCEL_PROJECT_PRODUCTION_URL
			? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
			: undefined);
	if (set) return new URL(set);
	if (process.env.NODE_ENV === "production")
		throw new Error(
			"SITE_URL is not set: set it to the site's public address (https://…) before `next build`, or build on Vercel.",
		);
	return new URL("http://localhost:3000");
}

export const SITE_URL = siteUrl();

/** Each page's title and description, in its language. */
function copy(lang: Lang, page: Page): { title: string; description: string } {
	const t = tr(lang);
	switch (page) {
		case "sources":
			return {
				title: t("Fuentes · Vigía", "Sources · Vigía"),
				description: t(
					`Las ${facts.sources} fuentes de Vigía, ${facts.keyless} de ellas sin ninguna clave: el BCV, IODA, OONI, USGS, NASA FIRMS y ${facts.newsPublishers} medios nacionales, regionales e internacionales. Cada una con su licencia y su enlace.`,
					`Vigía's ${facts.sources} sources, ${facts.keyless} of them with no key at all: the central bank, IODA, OONI, USGS, NASA FIRMS and ${facts.newsPublishers} national, regional and international publishers. Each with its licence and its link.`,
				),
			};
		case "changelog":
			return {
				title: t("Novedades · Vigía", "Changelog · Vigía"),
				description: t(
					"Cada versión de Vigía, de la más nueva a la primera: qué se añadió, qué cambió y qué se arregló, con sus notas y descargas.",
					"Every version of Vigía, newest first: what was added, what changed and what was fixed, with its notes and downloads.",
				),
			};
		default:
			return {
				title: t("Vigía · Venezuela, ahora", "Vigía · Venezuela, now"),
				description: t(
					`Una sala de situación de Venezuela que corre en tu computadora: dólar, internet por estado, sismos, incendios, clima, censura y noticias de ${facts.newsPublishers} medios. Cada cifra con su fuente y su hora. Gratis, sin cuenta, sin rastreo.`,
					`A situation room for Venezuela that runs on your own computer: the dollar, internet by state, earthquakes, fires, weather, censorship and news from ${facts.newsPublishers} publishers. Every figure with its source and its time. Free, no account, no tracking.`,
				),
			};
	}
}

export function metadata(lang: Lang, page: Page = "home"): Metadata {
	const t = tr(lang);
	const { title, description } = copy(lang, page);
	const path = PATHS[page][lang];
	return {
		metadataBase: SITE_URL,
		title,
		description,
		applicationName: "Vigía",
		alternates: {
			canonical: path,
			languages: { es: PATHS[page].es, en: PATHS[page].en, "x-default": PATHS[page].es },
			types: {
				"application/atom+xml": [
					{ url: PATHS.feed[lang], title: t("Novedades de Vigía", "Vigía changelog") },
				],
			},
		},
		openGraph: {
			type: "website",
			url: path,
			siteName: "Vigía",
			title,
			description,
			locale: lang === "es" ? "es_VE" : "en_US",
			alternateLocale: lang === "es" ? ["en_US"] : ["es_VE"],
			images: [
				{
					url: "/og.png",
					width: 1200,
					height: 630,
					alt: t(
						"Vigía: el mapa de Venezuela con sus paneles en vivo. Cada cifra con su fuente y su hora.",
						"Vigía: the map of Venezuela with its live panels. Every figure with its source and its time.",
					),
				},
			],
		},
		twitter: { card: "summary_large_image", title, description, images: ["/og.png"] },
		robots: { index: true, follow: true },
		formatDetection: { telephone: false, address: false, email: false },
	};
}

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	colorScheme: "dark light",
	themeColor: [
		{ media: "(prefers-color-scheme: dark)", color: "#07090e" },
		{ media: "(prefers-color-scheme: light)", color: "#f4f1ea" },
	],
};
