import { expect, test } from "bun:test";
import { Store } from "../core/store.ts";
import type { Json, Observation } from "../core/types.ts";
import { LinkIndex } from "./links-store.ts";

const T0 = Date.UTC(2026, 8, 27, 12);
const HOUR = 3_600_000;

const headline = (id: string, title: string, at: number): Observation => ({
	source: "el-pitazo",
	series: `item:${id}`,
	sourceUrl: `https://example.org/${id}`,
	fetchedAt: at + 60_000,
	observedAt: at,
	licence: "headline-link",
	value: {
		outlet: "el-pitazo",
		title,
		link: `https://example.org/${id}`,
		summary: "",
		image: null,
		dateMissing: false,
		video: false,
	},
	confidence: 1,
	basis: "report",
});

const quake = (id: string, mag: number, at: number, lat = 10.5061, lon = -66.9146): Observation => ({
	source: "usgs-quakes",
	series: `quake:${id}`,
	sourceUrl: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`,
	fetchedAt: at + 60_000,
	observedAt: at,
	licence: "usgs-public-domain",
	value: { mag, placeEs: "en Caracas", depthKm: 10 } as Json,
	location: { lat, lon, state: "VE-A" },
	confidence: 1,
	basis: "measurement",
});

const ioda = (at: number): Observation => ({
	source: "ioda-states",
	series: "state:VE-A:bgp",
	sourceUrl: "https://ioda.inetintel.cc.gatech.edu/region/4482",
	fetchedAt: at,
	observedAt: at,
	licence: "ioda",
	value: { v: 1 },
	location: { lat: 10.5, lon: -66.9, state: "VE-A" },
	confidence: 1,
	basis: "measurement",
});

test("sync links new rows once, from a watermark; series rows (IODA bins) are not linked", () => {
	const store = new Store(":memory:");
	store.insert([headline("a", "Apagón en Maracaibo", T0), quake("q1", 3.1, T0 - HOUR), ioda(T0)]);
	const links = new LinkIndex(store);
	expect(links.backlog()).toBe(3);
	const written = links.sync();
	// Headline: outlet + Zulia + Maracaibo; quake: parish, municipality, state, country (below magnitude 4: no
	// facilities).
	expect(written).toBe(7);
	expect(links.size()).toBe(7);
	expect(links.backlog()).toBe(0);
	expect(links.sync()).toBe(0);
	store.insert([headline("b", "Protesta en Maracaibo", T0 + HOUR)]);
	expect(links.backlog()).toBe(1);
	expect(links.sync()).toBe(3);
	expect(links.linked("ve.zulia.maracaibo", 0, T0 + 2 * HOUR, 10).rows.map((r) => r.series)).toEqual([
		"item:b",
		"item:a",
	]);
	expect(links.linked("ve.distrito-capital", 0, T0 + 2 * HOUR, 10).rows.map((r) => r.source)).toEqual([
		"usgs-quakes",
	]);
	store.close();
});

test("a revised quake is one event: its newest revision; the window, limit and truncation hold", () => {
	const store = new Store(":memory:");
	store.insert([quake("q1", 4.1, T0), quake("q1", 4.3, T0), quake("q2", 3, T0 - 2 * HOUR)]);
	const links = new LinkIndex(store);
	links.sync();
	const all = links.linked("ve.distrito-capital", T0 - 3 * HOUR, T0, 10);
	expect(all.rows.map((r) => [r.series, (r.value as { mag: number }).mag])).toEqual([
		["quake:q1", 4.3],
		["quake:q2", 3],
	]);
	expect(all.truncated).toBe(false);
	const one = links.linked("ve.distrito-capital", T0 - 3 * HOUR, T0, 1);
	expect(one.rows).toHaveLength(1);
	expect(one.truncated).toBe(true);
	expect(links.linked("ve.distrito-capital", T0 - HOUR, T0, 10).rows.map((r) => r.series)).toEqual([
		"quake:q1",
	]);
	// Only some sources.
	expect(links.linked("ve.distrito-capital", 0, T0, 10, new Set(["firms-fires"])).rows).toEqual([]);
	// Counts are of series: a quake revised twice counts once.
	expect(links.count("ve.distrito-capital", 0, T0, new Set(["usgs-quakes"]))).toBe(2);
	// From magnitude 4 the quake also links the facilities within 30 km (Caracas' hospitals among them).
	const hospitals = store.db
		.query<{ n: number }, []>("SELECT COUNT(DISTINCT entity) AS n FROM entity_links WHERE rule = 'near'")
		.get();
	expect(hospitals?.n ?? 0).toBeGreaterThan(10);
	store.close();
});

test("a new rules or registry version relinks the archive; prune drops links of pruned rows", () => {
	const store = new Store(":memory:");
	store.insert([
		headline("a", "Apagón en Maracaibo", T0 - 40 * 24 * HOUR),
		headline("b", "Luz en Maracaibo", T0),
	]);
	const v1 = new LinkIndex(store, undefined, "test-1");
	v1.sync();
	expect(v1.size()).toBe(6);
	// Same version: nothing is redone.
	const again = new LinkIndex(store, undefined, "test-1");
	expect(again.backlog()).toBe(0);
	// A new version starts over.
	const v2 = new LinkIndex(store, undefined, "test-2");
	expect(v2.size()).toBe(0);
	expect(v2.backlog()).toBe(2);
	v2.sync();
	expect(v2.size()).toBe(6);
	// Pruning keeps the newest row of every series: an older revision of "b" goes, and so do its links.
	store.insert([headline("b", "Luz en Maracaibo (antes)", T0 - 30 * 24 * HOUR)]);
	v2.sync();
	expect(v2.size()).toBe(9);
	store.pruneObservations(T0 - 20 * 24 * HOUR);
	v2.prune();
	expect(v2.size()).toBe(6);
	// "a" was the only row of its series: pruning keeps it, and its links stay.
	expect(v2.linked("ve.zulia", 0, T0 + 2 * HOUR, 10).rows.map((r) => r.series)).toEqual(["item:b", "item:a"]);
	store.close();
});

test("sync in slices yields and keeps what it did", () => {
	const store = new Store(":memory:");
	store.insert(Array.from({ length: 50 }, (_, i) => headline(`h${i}`, `Apagón en Maracaibo ${i}`, T0 + i)));
	const links = new LinkIndex(store);
	const steps = links.syncSteps(10, 0);
	const first = steps.next();
	expect(first.done).toBe(false);
	expect(links.backlog()).toBe(40);
	for (const _ of steps);
	expect(links.backlog()).toBe(0);
	expect(links.size()).toBe(150);
	store.close();
});

test("two syncs interleaving (a request's catch-up and the background) never redo work or move the watermark back", () => {
	const store = new Store(":memory:");
	store.insert(Array.from({ length: 40 }, (_, i) => headline(`h${i}`, `Apagón en Maracaibo ${i}`, T0 + i)));
	const links = new LinkIndex(store);
	const background = links.syncSteps(10, 0);
	background.next();
	expect(links.backlog()).toBe(30);
	// A request catches up the rest while the background is paused between chunks.
	expect(links.sync()).toBe(90);
	expect(links.backlog()).toBe(0);
	// The background resumes, finds nothing left, and leaves the watermark where it is.
	let more = 0;
	for (const n of background) more += n;
	expect(more).toBe(0);
	expect(links.backlog()).toBe(0);
	expect(links.size()).toBe(120);
	store.close();
});

const fire = (i: number, at: number, lat = 7.9, lon = -63.2): Observation => ({
	source: "firms-fires",
	series: `fire:${i}`,
	sourceUrl: "https://firms.modaps.eosdis.nasa.gov/map/",
	fetchedAt: at + 60_000,
	observedAt: at,
	licence: "nasa-firms",
	value: { kind: "detection", frpMW: 3, placeEs: "x" } as Json,
	location: { lat, lon, state: "VE-F" },
	confidence: 1,
	basis: "measurement",
});

test("filters and revisions run before the limit: many fires never hide a quake or the headlines", () => {
	const store = new Store(":memory:");
	const bolivar = { lat: 7.9, lon: -63.2 };
	store.insert([
		quake("q", 3.5, T0 - 10 * HOUR, bolivar.lat, bolivar.lon),
		headline("h", "Apagón en Ciudad Bolívar", T0 - 5 * HOUR),
		...Array.from({ length: 3_000 }, (_, i) => fire(i, T0 - i * 1_000)),
	]);
	const links = new LinkIndex(store);
	links.sync();
	const quakes = links.linked("ve", 0, T0, 10, new Set(["usgs-quakes"]));
	expect(quakes.rows.map((r) => r.series)).toEqual(["quake:q"]);
	expect(quakes.truncated).toBe(false);
	expect(links.linked("ve.bolivar", 0, T0, 10, new Set(["el-pitazo"])).rows).toHaveLength(1);
	// Counts are exact, not capped at a page.
	expect(links.count("ve.bolivar", 0, T0, new Set(["firms-fires"]))).toBe(3_000);
	store.close();
});

test("a quake revised into another state leaves the first state's timeline", () => {
	const store = new Store(":memory:");
	store.insert([quake("q2", 3.0, T0, 7.9, -63.2)]);
	const links = new LinkIndex(store);
	links.sync();
	expect(links.count("ve.bolivar", 0, T0, new Set(["usgs-quakes"]))).toBe(1);
	store.insert([{ ...quake("q2", 3.2, T0, 10.6, -71.6), fetchedAt: T0 + HOUR }]);
	links.sync();
	expect(links.count("ve.bolivar", 0, T0, new Set(["usgs-quakes"]))).toBe(0);
	expect(links.linked("ve.zulia", 0, T0, 10).rows.map((r) => (r.value as { mag: number }).mag)).toEqual([
		3.2,
	]);
	store.close();
});

test("RIPEstat snapshots are each their own event", () => {
	const store = new Store(":memory:");
	const snap = (at: number): Observation => ({
		source: "ripestat-prefixes",
		series: "asn:8048",
		sourceUrl: "https://stat.ripe.net/AS8048",
		fetchedAt: at,
		observedAt: at,
		licence: "ripestat",
		value: {
			asn: "8048",
			isp: "cantv",
			announced: { v4: 0, v6: 0 },
			withdrawn: { v4: 50, v6: 0 },
			movedIn: [],
			movedOut: [],
			prevAt: at - HOUR,
			v4Addresses: 2_000_000,
			v4AddressesGained: 0,
			v4AddressesLost: 400_000 + at / 1e9,
			v4Prefixes: 400,
			v6Prefixes: 2,
			timingDated: 0,
			timingSampled: 0,
			withdrawalAt: null,
		} as Json,
		confidence: 1,
		basis: "measurement",
	});
	store.insert([snap(T0 - 2 * HOUR), snap(T0)]);
	const links = new LinkIndex(store);
	links.sync();
	expect(links.linked("asn.8048", 0, T0, 10).rows).toHaveLength(2);
	expect(links.count("asn.8048", 0, T0)).toBe(2);
	store.close();
});

test("window sources: each observed time is its own event, told by its newest revision", () => {
	const store = new Store(":memory:");
	const glm = (at: number, flashes: number, fetchedAt = at + 20 * 60_000): Observation => ({
		source: "goes-glm",
		series: "window",
		sourceUrl: "https://registry.opendata.aws/noaa-goes/",
		fetchedAt,
		observedAt: at,
		licence: "noaa-open-data-glm",
		value: { byState: { "VE-G": flashes }, cells: [], venezuela: flashes, complete: true } as Json,
		confidence: 1,
		basis: "measurement",
	});
	store.insert([glm(T0 - HOUR, 10), glm(T0, 20)]);
	const links = new LinkIndex(store);
	links.sync();
	expect(links.count("ve.carabobo", 0, T0)).toBe(2);
	// A re-read of the first window (more files arrived) replaces it; it does not add a third event.
	store.insert([glm(T0 - HOUR, 15, T0 + HOUR)]);
	links.sync();
	const rows = links.linked("ve.carabobo", 0, T0, 10).rows;
	expect(rows.map((r) => (r.value as { venezuela: number }).venezuela)).toEqual([20, 15]);
	expect(links.count("ve.carabobo", 0, T0)).toBe(2);
	store.close();
});

test("directory sources keep only each series' newest row in the table", () => {
	const store = new Store(":memory:");
	const market = (at: number, price: number): Observation => ({
		source: "polymarket",
		series: "market:0xabc",
		sourceUrl: "https://polymarket.com/event/x",
		fetchedAt: at,
		observedAt: at,
		licence: "polymarket-terms",
		value: { question: "¿x?", lastPrice: price } as Json,
		confidence: 1,
		basis: "quote",
	});
	store.insert([market(T0 - 2 * HOUR, 0.1), market(T0 - HOUR, 0.2)]);
	const links = new LinkIndex(store);
	links.sync();
	expect(links.size()).toBe(1);
	store.insert([market(T0, 0.3)]);
	links.sync();
	expect(links.size()).toBe(1);
	expect(links.linked("ve", 0, T0, 10).rows.map((r) => (r.value as { lastPrice: number }).lastPrice)).toEqual(
		[0.3],
	);
	// Relinking from scratch (a new rules version) gives the same single row.
	const again = new LinkIndex(store, undefined, "another-version");
	again.sync();
	expect(again.size()).toBe(1);
	store.close();
});
