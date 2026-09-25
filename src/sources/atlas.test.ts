import { expect, test } from "bun:test";
import { ADAPTERS } from "../adapters/registry.ts";
import type { OutletSpec } from "../adapters/rss/factory.ts";
import { rssAdapter } from "../adapters/rss/factory.ts";
import { PANELS } from "../server/panel-registry.ts";
import { ADDED } from "./added.gen.ts";
import { buildAtlas } from "./atlas.ts";
import { atlasMeta } from "./atlas-meta.ts";

const KNOWN = new Set([
	"money",
	"markets",
	"energy",
	"internet",
	"censorship",
	"earth",
	"space",
	"airspace",
	"attention",
	"news",
	"social",
	"society",
]);
const KINDS = new Set(["api", "web", "feed", "video", "satellite", "sensor", "network"]);

test("every registered feed has an atlas entry with a known category, kind and region", () => {
	const atlas = buildAtlas(ADAPTERS);
	expect(atlas.size).toBe(ADAPTERS.length);
	for (const a of ADAPTERS) {
		const e = atlas.get(a.id);
		expect(e).toBeDefined();
		if (!e) continue;
		expect(e.category.length).toBeGreaterThan(0);
		for (const c of e.category) expect(KNOWN.has(c)).toBe(true);
		expect(KINDS.has(e.kind)).toBe(true);
		expect(e.region).toMatch(/^(VE|VE-[A-Z]|diaspora|intl)$/);
		expect(e.country).toMatch(/^([A-Z]{2}|INT)$/);
		expect(e.publisher.length).toBeGreaterThan(0);
	}
});

test("dates come from the generated table, in UTC minutes", () => {
	const atlas = buildAtlas(ADAPTERS);
	expect(atlas.get("usgs-quakes")?.added).toBe(ADDED["usgs-quakes"] ?? "missing");
	for (const at of Object.values(ADDED)) expect(at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\dZ$/);
});

const outlet = (o: Partial<OutletSpec> & Pick<OutletSpec, "id" | "name" | "homepage">): OutletSpec => ({
	url: `${o.homepage}feed`,
	kind: "rss",
	region: "national",
	stance: "independent",
	...o,
});

test("publishers: one per site, a YouTube channel joins the site outlet of the same name", () => {
	const outlets = [
		outlet({ id: "dw-a", name: "DW", homepage: "https://rss.dw.com/", region: "international" }),
		outlet({ id: "dw-b", name: "DW portada", homepage: "https://rss.dw.com/", region: "international" }),
		outlet({ id: "pitazo", name: "El Pitazo", homepage: "https://elpitazo.net/" }),
		outlet({
			id: "yt-pitazo",
			name: "El Pitazo (YouTube)",
			kind: "youtube",
			homepage: "https://www.youtube.com/channel/X",
		}),
		outlet({
			id: "yt-other",
			name: "Otro (YouTube)",
			kind: "youtube",
			homepage: "https://www.youtube.com/channel/Y",
		}),
		// Same words, different outlets: different sites never merge.
		outlet({ id: "tiempo-anz", name: "El Tiempo", homepage: "https://eltiempo.com.ve/", region: "VE-B" }),
		outlet({
			id: "tiempo-co",
			name: "El Tiempo",
			homepage: "https://www.eltiempo.com/",
			region: "international",
		}),
	];
	const atlas = buildAtlas(outlets.map(rssAdapter), outlets);
	const pub = (id: string) => atlas.get(id)?.publisher;
	expect(pub("dw-a")).toBe(pub("dw-b"));
	expect(pub("yt-pitazo")).toBe(pub("pitazo"));
	expect(pub("yt-other")).toBe("yt:otro");
	expect(pub("tiempo-anz")).not.toBe(pub("tiempo-co"));
	const publishers = new Set([...atlas.values()].map((e) => e.publisher));
	expect(publishers.size).toBe(5);
});

test("outlets: region, kind, country and language are read, never guessed", () => {
	const outlets = [
		outlet({ id: "reg", name: "Reg", homepage: "https://reg.com/", region: "VE-V" }),
		outlet({ id: "yt", name: "Yt", kind: "youtube", homepage: "https://www.youtube.com/channel/Z" }),
		outlet({ id: "co", name: "Co", homepage: "https://diario.com.co/", region: "international" }),
		outlet({ id: "fr", name: "Fr", homepage: "https://journal.fr/", region: "international" }),
		outlet({ id: "com", name: "Com", homepage: "https://news.com/", region: "international" }),
		outlet({
			id: "decl",
			name: "Decl",
			homepage: "https://x.org/",
			region: "international",
			lang: "pt",
			country: "BR",
		}),
	];
	const atlas = buildAtlas(outlets.map(rssAdapter), outlets);
	expect(atlas.get("reg")).toMatchObject({ region: "VE-V", country: "VE", lang: "es", kind: "feed" });
	expect(atlas.get("yt")).toMatchObject({ region: "VE", kind: "video" });
	expect(atlas.get("co")).toMatchObject({ region: "intl", country: "CO", lang: "es" });
	expect(atlas.get("fr")).toMatchObject({ country: "FR", lang: null });
	expect(atlas.get("com")).toMatchObject({ country: "INT", lang: null });
	expect(atlas.get("decl")).toMatchObject({ country: "BR", lang: "pt" });
});

test("an undescribed adapter falls back to its layer, and an undated one to its first run here, flagged", () => {
	const fake = {
		...ADAPTERS[0],
		id: "brand-new",
		layer: "oil",
		provider: "Nueva Org",
	} as (typeof ADAPTERS)[number];
	const meta = atlasMeta([fake], [{ id: "oil", sources: ["brand-new"] }], () => Date.UTC(2026, 9, 1, 12, 30));
	expect(meta("brand-new")).toMatchObject({
		category: ["energy"],
		publisher: "nueva org",
		added: "2026-10-01T12:30Z",
		addedBy: "run",
		panels: ["oil"],
	});
	const never = atlasMeta([fake], [], () => null);
	expect(never("brand-new")).toMatchObject({ added: null, panels: [] });
	expect("addedBy" in never("brand-new")).toBe(false);
});

test("panels list what each real feed feeds", () => {
	const meta = atlasMeta(ADAPTERS, PANELS, () => null);
	expect(meta("usgs-quakes")).toMatchObject({ panels: expect.arrayContaining(["quakes"]) });
	expect(meta("2001online")).toMatchObject({ panels: expect.arrayContaining(["news"]) });
});
