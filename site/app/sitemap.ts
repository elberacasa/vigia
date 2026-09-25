import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/meta";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
	const url = (p: string) => new URL(p, SITE_URL).toString();
	return [
		{ url: url("/"), alternates: { languages: { es: url("/"), en: url("/en") } } },
		{ url: url("/en"), alternates: { languages: { es: url("/"), en: url("/en") } } },
	];
}
