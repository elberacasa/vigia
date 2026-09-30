import { expect, test } from "bun:test";
import { join } from "node:path";
import { iptvVe, iptvVeProbe } from "../adapters/iptv-ve/index.ts";
import { radioBrowser, radioBrowserProbe } from "../adapters/radio-browser/index.ts";
import { loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { computeMediaDir, mediaDirPanel, RADIO_DIR_BUDGET_MS, TV_DIR_BUDGET_MS } from "./mediadir.ts";

const IPTV = join(import.meta.dir, "..", "adapters", "iptv-ve", "fixtures");
const list = iptvVe.normalise(loadFixture(join(IPTV, "2026-09-28")));
const probes = iptvVeProbe.normalise(loadFixture(join(IPTV, "probe-2026-09-28")));
const probedAt = Math.max(...probes.map((o) => o.observedAt));

function storeWith(...batches: Observation[][]): Store {
	const store = new Store(":memory:");
	for (const b of batches) store.insert(b);
	return store;
}

test("TV: 68 channels on with the probe's state, 62 excluded with the reason, live first", () => {
	const view = computeMediaDir(storeWith(list, probes), probedAt + 60_000);
	expect(view.tv.listed).toBe(130);
	expect(view.tv.cards).toHaveLength(68);
	expect(view.tv.excluded).toHaveLength(62);
	expect(view.tv.byReason).toEqual({ "foreign-pay": 46, "relay-host": 9, "pay-ve": 5, spoofed: 2 });
	expect(view.tv.live).toBe(38);
	expect(view.tv.measured).toBe(68);
	expect(view.tv.cards.slice(0, 38).every((c) => c.state === "live")).toBe(true);
	const canalI = view.tv.cards.find((c) => c.channel === "CanalI.ve");
	expect(canalI).toMatchObject({ state: "live", playable: "in-page", play: { type: "hls" } });
	expect(canalI?.latencyMs).toBeGreaterThan(0);
	// Live, but its segment host sends no CORS header: only a browser with native HLS can play it in the page.
	expect(view.tv.cards.find((c) => c.channel === "VenevisionInternacional.ve")?.playable).toBe("native-only");
	expect(view.tv.cards.find((c) => c.channel === "TeleAragua.ve")?.playable).toBe("http-only");
	expect(view.tv.cards.find((c) => c.channel === "AnzoateguiTV.ve")).toMatchObject({
		state: "off",
		detail: "http-404",
	});
	expect(view.tv.cards.find((c) => c.channel === "TRT.ve")?.statesWhy).toBe(
		"es.wikipedia: sede en San Cristóbal, Táchira",
	);
	const globo = view.tv.excluded.find((e) => e.channel === "Globovision.ve");
	expect(globo).toMatchObject({ reason: "relay-host", detail: "181.78.8.199:8000" });
	expect(globo?.reasonEs).toContain("cabecera de cable");
	expect(view.tv.byState["VE-K"]).toBeGreaterThanOrEqual(5);
});

test("TV: a probe older than 45 min is stale, with its last state; no probe is unmeasured", () => {
	const later = computeMediaDir(storeWith(list, probes), probedAt + TV_DIR_BUDGET_MS + 1);
	expect(later.tv.live).toBe(0);
	expect(later.tv.cards.find((c) => c.channel === "CanalI.ve")).toMatchObject({
		state: "stale",
		detail: "live",
		latencyMs: null,
	});
	const none = computeMediaDir(storeWith(list), probedAt);
	expect(none.tv.cards.every((c) => c.state === "unmeasured")).toBe(true);
	// Without a probe, CORS is unknown: an HTTPS stream is only promised to native HLS.
	expect(none.tv.cards.find((c) => c.channel === "CanalI.ve")?.playable).toBe("native-only");
});

test("TV: only the newest list version counts (a stream iptv-org dropped leaves the directory)", () => {
	const old = list
		.slice(0, 5)
		.map((o) => ({ ...o, observedAt: o.observedAt - 86_400_000, series: `${o.series}-gone` }));
	const view = computeMediaDir(storeWith(old, list, probes), probedAt);
	expect(view.tv.listed).toBe(130);
});

// Invented stations in Radio Browser's format.
const st = (n: number, name: string, url: string, extra: Record<string, unknown> = {}) => ({
	stationuuid: `${String(n).padStart(8, "0")}-3333-4333-8333-333333333333`,
	name,
	url,
	url_resolved: url,
	homepage: "https://radio.example/",
	countrycode: "VE",
	iso_3166_2: null,
	state: "",
	codec: "MP3",
	bitrate: 64,
	hls: 0,
	votes: 1,
	lastchangetime_iso8601: "2026-09-20T10:00:00Z",
	geo_lat: null,
	geo_long: null,
	...extra,
});
const RB_AT = Date.parse("2026-09-28T20:00:00Z");
const rbList = radioBrowser.normalise([
	{
		url: "https://de1.api.radio-browser.info/json/stations/bycountrycodeexact/VE",
		status: 200,
		contentType: "application/json",
		fetchedAt: RB_AT,
		body: JSON.stringify([
			st(1, "Uno 101.1 FM", "https://uno.example/stream", { state: "Zulia" }),
			st(2, "Dos 99.9 FM", "http://dos.example/stream"),
			st(3, "RNV Informativa (copia)", "https://guri.tepuyserver.net/8048/stream"),
			st(4, "Relevo 90.1 FM", "https://worldradio.online/proxy/?q=x"),
			st(5, "Radio en la web", "https://web.example/s"),
		]),
	},
]);
const reading = (n: number, state: string, reason: string | null) =>
	radioBrowserProbe.normalise([
		{
			url: "x",
			status: 200,
			contentType: "application/vnd.vigia.radio-dir-probe+json",
			fetchedAt: RB_AT,
			body: JSON.stringify({
				kind: "audio",
				uuid: `${String(n).padStart(8, "0")}-3333-4333-8333-333333333333`,
				probe: {
					url: "https://uno.example/stream",
					at: RB_AT,
					httpStatus: state === "live" ? 200 : 503,
					contentType: state === "live" ? "audio/mpeg" : null,
					bytes: state === "live" ? 8192 : 0,
					audioFrames: state === "live",
					origin: "https://uno.example",
					ms: 250,
					error: reason,
				},
			}),
		},
	]);

test("radio: broadcasters with the probe's state; the curated duplicate flagged; relays and counts kept apart", () => {
	const view = computeMediaDir(
		storeWith(rbList, reading(1, "live", null), reading(2, "off", "http-503")),
		RB_AT + 60_000,
	);
	expect(view.radio.cards.map((c) => [c.name, c.state, c.playable, c.curated])).toEqual([
		["Uno 101.1 FM", "live", "in-page", false],
		["Dos 99.9 FM", "off", "http-only", false],
		["RNV Informativa (copia)", "unmeasured", "in-page", true],
	]);
	expect(view.radio.cards[0]).toMatchObject({ states: ["VE-V"], latencyMs: 250, frequency: "101.1 FM" });
	expect(view.radio.excluded).toEqual([
		expect.objectContaining({ name: "Relevo 90.1 FM", reason: "relay", detail: "worldradio.online" }),
	]);
	expect(view.radio.summary).toEqual({
		listed: 5,
		broadcasters: 4,
		webOnly: 1,
		withHandle: 0,
		duplicates: 0,
	});
	expect(view.radio.live).toBe(1);
	expect(
		computeMediaDir(storeWith(rbList, reading(1, "live", null)), RB_AT + RADIO_DIR_BUDGET_MS + 1).radio.live,
	).toBe(0);
});

test("the panel is served on demand, from the six feeds", () => {
	expect(mediaDirPanel.onDemand).toBe(true);
	expect(mediaDirPanel.sources).toEqual([
		"iptv-ve",
		"iptv-ve-probe",
		"tv-stills",
		"tv-logos",
		"radio-browser",
		"radio-browser-probe",
	]);
	const empty = computeMediaDir(new Store(":memory:"), RB_AT);
	expect(empty.tv).toMatchObject({ listed: 0, cards: [], listAt: null, checkedAt: null });
	expect(empty.radio.summary).toBeNull();
});

test("TV cards: a fresh frame, else the logo, else nothing; the stills summary counts them", () => {
	const canalI = list.find((o) => o.value.channel === "CanalI.ve")?.value;
	const anz = list.find((o) => o.value.channel === "AnzoateguiTV.ve")?.value;
	if (!canalI || !anz) throw new Error("fixture");
	const at = probedAt;
	const still: Observation = {
		source: "tv-stills",
		series: `still:${canalI.key}`,
		sourceUrl: "https://iptv-org.github.io/channels/ve/CanalI",
		fetchedAt: at,
		observedAt: at,
		licence: "tv-still-reference",
		value: {
			kind: "still",
			entry: canalI.key,
			channel: "CanalI.ve",
			blob: "s1-a-0123456789abcdef",
			width: 480,
			height: 270,
			jpegBytes: 20_000,
			reason: null,
			lumaMean: 90,
			lumaSd: 40,
			flat: false,
			hash: "0123456789abcdef",
			bytes: 60_000,
			ms: 700,
			cpuMs: 35,
		},
		confidence: 1,
		basis: "measurement",
	};
	const round: Observation = {
		...still,
		series: "round",
		value: {
			kind: "round",
			decoder: "n9.0.1",
			attempted: 68,
			stills: 1,
			bytes: 4_000_000,
			cpuMs: 1_500,
			ms: 40_000,
			reasons: {},
		},
	};
	const logo: Observation = {
		...still,
		source: "tv-logos",
		series: "logo:AnzoateguiTV.ve",
		licence: "iptv-org-unlicense",
		basis: "report",
		value: {
			channel: "AnzoateguiTV.ve",
			blob: "l1-0123456789abcdef",
			width: 256,
			height: 144,
			url: "https://img.example/t.png",
			reason: null,
		},
	};
	const view = computeMediaDir(storeWith(list, probes, [still, round, logo]), at + 60_000);
	expect(view.tv.cards.find((c) => c.channel === "CanalI.ve")?.image).toMatchObject({
		kind: "still",
		url: "/api/blobs/tv-stills/s1-a-0123456789abcdef",
	});
	expect(view.tv.cards.find((c) => c.channel === "AnzoateguiTV.ve")?.image).toMatchObject({
		kind: "logo",
		labelEs: "Sin cuadro reciente",
	});
	expect(view.tv.stills).toMatchObject({
		frames: 1,
		logos: 1,
		none: 66,
		decoder: "n9.0.1",
		round: { bytes: 4_000_000, stills: 1, attempted: 68 },
	});
	// 45 minutes later the frame is no longer the picture.
	const later = computeMediaDir(storeWith(list, probes, [still, round, logo]), at + 46 * 60_000);
	expect(later.tv.cards.find((c) => c.channel === "CanalI.ve")?.image.kind).toBe("none");
});
