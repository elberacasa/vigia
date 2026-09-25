import type { MetadataRoute } from "next";
import { PATHS, type Page } from "@/lib/i18n";
import { SITE_URL } from "@/lib/meta";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
	const url = (p: string) => new URL(p, SITE_URL).toString();
	const pages: Page[] = ["home", "sources", "changelog"];
	return pages.flatMap((page) => {
		const languages = { es: url(PATHS[page].es), en: url(PATHS[page].en) };
		return [
			{ url: languages.es, alternates: { languages } },
			{ url: languages.en, alternates: { languages } },
		];
	});
}
