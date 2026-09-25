import "server-only";
import changelogJson from "../data/changelog.json";
import sourcesJson from "../data/sources.json";

/**
 * The sources showcase and the changelog, as `bun scripts/site-data.ts` wrote them from the code (see
 * scripts/site/sources.ts and scripts/site/changelog.ts). The shapes are restated here because the site is its own
 * project; the generator's tests hold the other side.
 */
export type L = { es: string; en: string };
export type Access = "free" | "key" | "optin";

export interface SourceRow {
	id: string;
	group: string;
	name: L;
	provider: string;
	homepage: string;
	access: Access;
	kind: L;
	region: string;
	cc: string;
	country: L;
	lang: L;
	licence: { name: string; url: string };
	stance?: L;
}

export interface SourcesData {
	total: number;
	free: number;
	key: number;
	optin: number;
	outlets: number;
	licences: number;
	countries: number;
	groups: { id: string; slug: string; name: L; note: L; count: number }[];
	rows: SourceRow[];
	states: { iso: string; name: string; outlets: number; d: string; label: number[]; small: boolean }[];
	frame: { width: number; height: number };
}

export interface ChangeGroup {
	title: string;
	kind: string;
	items: string[];
}

export interface Version {
	version: string;
	date: string;
	intro: string;
	groups: ChangeGroup[];
	highlights: { es: string[]; en: string[] };
	topics: { es: string[]; en: string[] };
	downloads: { target: string; file: string; format: string; mb: number }[];
	notes: string | null;
}

export const sources = sourcesJson as SourcesData;
export const versions = changelogJson as Version[];

/** Anchor of a version: 0.1.5 → "v0-1-5" (the same rule as scripts/site/changelog.ts). */
export const anchor = (version: string) => `v${version.replace(/\./g, "-")}`;
