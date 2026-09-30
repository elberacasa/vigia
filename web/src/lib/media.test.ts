import { expect, test } from "bun:test";
import {
	type CuratedCard,
	type CuratedView,
	filterItems,
	type MediaDirView,
	type Play,
	playMode,
	radioItems,
	readableWords,
	reasonText,
	startPlaying,
	stateCounts,
	type TvDirCard,
	tvItems,
} from "./media.ts";

const tv = (over: Partial<TvDirCard>): TvDirCard => ({
	key: "X.ve/SD/a",
	channel: "X.ve",
	name: "X",
	categories: ["general"],
	states: [],
	statesWhy: null,
	statesFrom: null,
	ownership: "other",
	quality: "480p",
	notAlways: false,
	geoBlocked: false,
	website: null,
	listing: "https://iptv-org.github.io/channels/ve/X",
	state: "live",
	detail: null,
	checkedAt: 1,
	playable: "in-page",
	play: { type: "hls", url: "https://x.example/a.m3u8" },
	latencyMs: 100,
	...over,
});

const dir = (tvCards: TvDirCard[], radio: MediaDirView["radio"]["cards"] = []): MediaDirView => ({
	tv: {
		cards: tvCards,
		excluded: [],
		listed: tvCards.length,
		live: 0,
		measured: 0,
		listAt: null,
		checkedAt: null,
		byReason: {},
		byState: {},
	},
	radio: {
		cards: radio,
		excluded: [],
		summary: null,
		live: 0,
		measured: 0,
		listAt: null,
		checkedAt: null,
		byState: {},
	},
	budgets: { tvMs: 1, radioMs: 1 },
	ruleEs: "",
	ruleEn: "",
	vantageEs: "",
	vantageEn: "",
});

const curatedCard = (over: Partial<CuratedCard>): CuratedCard => ({
	id: "vtv",
	kind: "tv",
	name: "VTV",
	where: null,
	labelEs: "Medio estatal · Venezuela",
	labelEn: "State media · Venezuela",
	ownership: "state",
	lang: "es",
	homepage: "https://vtv.gob.ve",
	verified: "",
	state: "live",
	detail: null,
	checkedAt: 1,
	sourceUrl: "https://www.youtube.com/channel/UC_8sCVycu3FXidPNoZwOHqA/live",
	title: null,
	startedAt: null,
	playability: null,
	playabilityReason: null,
	play: { type: "youtube", channelId: "UC_8sCVycu3FXidPNoZwOHqA", videoId: null },
	latencyMs: null,
	...over,
});

const curated = (cards: CuratedCard[]): CuratedView => ({
	cards,
	tv: { live: 0, measured: 0, total: 0, checkedAt: null },
	radio: { live: 0, measured: 0, total: 0, checkedAt: null },
	ruleEs: "",
	ruleEn: "",
	vantageEs: "",
	vantageEn: "",
	budgets: { tvMs: 1, radioMs: 1 },
});

test("a channel listed with several streams is one tile: live first, then playable here, then quality", () => {
	const items = tvItems(
		undefined,
		dir([
			tv({ key: "T.ve/a", channel: "T.ve", name: "Telesur", state: "off", quality: "1080p" }),
			tv({ key: "T.ve/b", channel: "T.ve", name: "Telesur", playable: "native-only", quality: "1080p" }),
			tv({ key: "T.ve/c", channel: "T.ve", name: "Telesur", quality: "720p" }),
			tv({ key: "T.ve/d", channel: "T.ve", name: "Telesur", quality: "480p" }),
		]),
	);
	expect(items).toHaveLength(1);
	expect(items[0]?.id).toBe("tv:iptv:T.ve/c");
	expect(items[0]?.alternates).toBe(3);
});

test("a tile carries its card's picture; a channel's other stream lends its frame when the shown one has none", () => {
	const frame = {
		kind: "still" as const,
		url: "/api/blobs/tv-stills/f",
		width: 480,
		height: 270,
		takenAt: 1,
		source: "tv-frame" as const,
		labelEs: "Cuadro de las 01:42",
		labelEn: "Frame at 01:42",
		creditEs: "Imagen: señal de la televisora; cuadro tomado por Vigía",
	};
	const none = {
		kind: "none" as const,
		labelEs: "Sin cuadro reciente",
		labelEn: "No recent frame",
		whyEs: null,
		whyEn: null,
	};
	const items = tvItems(
		curated([curatedCard({ id: "a", name: "Alfa", state: "live", image: frame })]),
		dir([
			tv({ key: "T.ve/a", channel: "T.ve", name: "Telesur", quality: "1080p", image: none }),
			tv({ key: "T.ve/b", channel: "T.ve", name: "Telesur", state: "off", quality: "480p", image: frame }),
		]),
	);
	expect(items.find((i) => i.name === "Alfa")?.image?.kind).toBe("still");
	expect(items.find((i) => i.name === "Telesur")?.image).toEqual(none);
	const lent = tvItems(
		undefined,
		dir([
			tv({ key: "U.ve/a", channel: "U.ve", name: "U" }),
			tv({ key: "U.ve/b", channel: "U.ve", name: "U", state: "off", image: frame }),
		]),
	);
	expect(lent[0]?.image?.kind).toBe("still");
});

test("curated YouTube channels join the wall with their own labels; live first, then by name", () => {
	const items = tvItems(
		curated([
			curatedCard({ id: "b", name: "Beta", state: "off" }),
			curatedCard({ id: "a", name: "Alfa", state: "live" }),
		]),
		dir([tv({ name: "Zeta", ownership: "state-funded" })]),
	);
	expect(items.map((i) => i.name)).toEqual(["Alfa", "Zeta", "Beta"]);
	expect(items.find((i) => i.name === "Zeta")?.ownerEs).toBe("Financiado por el Estado venezolano");
	expect(items.find((i) => i.name === "Alfa")?.play.kind).toBe("youtube");
});

test("a directory radio that is the same stream as a curated one is shown once, as the curated one", () => {
	const radio = radioItems(
		curated([
			curatedCard({
				id: "rnv",
				kind: "radio",
				name: "RNV",
				play: { type: "audio", url: "https://guri.example/stream" },
			}),
		]),
		dir(
			[],
			[
				{
					uuid: "u1",
					name: "RNV 91.1 FM",
					frequency: "91.1 FM",
					states: ["VE-A"],
					statesFrom: "name",
					ownership: "state",
					codec: "MP3",
					bitrateKbps: 128,
					homepage: null,
					listing: "https://www.radio-browser.info/history/u1",
					curated: true,
					curatedWhy: null,
					state: "live",
					detail: null,
					checkedAt: 1,
					playable: "in-page",
					play: { type: "audio", url: "https://guri.example/stream" },
					latencyMs: 1,
				},
				{
					uuid: "u2",
					name: "Fiesta 106.5 FM",
					frequency: "106.5 FM",
					states: ["VE-L"],
					statesFrom: "name",
					ownership: "other",
					codec: "AAC",
					bitrateKbps: 64,
					homepage: null,
					listing: "https://www.radio-browser.info/history/u2",
					curated: false,
					curatedWhy: null,
					state: "off",
					detail: "http-503",
					checkedAt: 1,
					playable: "http-only",
					play: { type: "audio", url: "http://fiesta.example/stream" },
					latencyMs: null,
				},
			],
		),
	);
	expect(radio.map((r) => r.id)).toEqual(["radio:cur:rnv", "radio:rb:u2"]);
	expect(radio[1]?.statesNote).toBe("name");
	expect(radio[1]?.quality).toBe("AAC 64 kb/s");
});

test("filters: regional means placed in a state, national means no state, state media by ownership", () => {
	const items = tvItems(
		curated([curatedCard({ id: "v", name: "VTV" })]),
		dir([
			tv({ key: "a", channel: "A", name: "A", states: ["VE-K"] }),
			tv({ key: "b", channel: "B", name: "B", states: ["VE-K", "VE-S"] }),
			tv({ key: "c", channel: "C", name: "C" }),
		]),
	);
	expect(filterItems(items, "regional", null).map((i) => i.name)).toEqual(["A", "B"]);
	expect(filterItems(items, "national", null).map((i) => i.name)).toEqual(["C", "VTV"]);
	expect(filterItems(items, "state", null).map((i) => i.name)).toEqual(["VTV"]);
	expect(filterItems(items, "all", "VE-S").map((i) => i.name)).toEqual(["B"]);
	expect(stateCounts(items)).toEqual([
		{ iso: "VE-K", n: 2 },
		{ iso: "VE-S", n: 1 },
	]);
});

test("what a play button can do: never a fake player, a link with the reason when the page cannot play it", () => {
	const hls = (playable: "in-page" | "native-only" | "http-only"): Play => ({
		kind: "hls",
		url: "https://x.example/a.m3u8",
		playable,
	});
	const chrome = { nativeHls: false, mse: true, pageHttp: false };
	const safari = { nativeHls: true, mse: true, pageHttp: false };
	expect(playMode(hls("in-page"), chrome)).toEqual({ mode: "hls.js" });
	expect(playMode(hls("in-page"), safari)).toEqual({ mode: "native-hls" });
	expect(playMode(hls("native-only"), chrome)).toEqual({ mode: "external", why: "no-cors" });
	expect(playMode(hls("native-only"), safari)).toEqual({ mode: "native-hls" });
	expect(playMode(hls("http-only"), safari)).toEqual({ mode: "external", why: "http" });
	expect(playMode(hls("http-only"), { ...chrome, pageHttp: true })).toEqual({ mode: "hls.js" });
	expect(playMode(hls("in-page"), { nativeHls: false, mse: false, pageHttp: false })).toEqual({
		mode: "external",
		why: "no-hls",
	});
	const audio: Play = { kind: "audio", url: "http://r.example/s", playable: "http-only" };
	expect(playMode(audio, chrome)).toEqual({ mode: "external", why: "http" });
	expect(playMode(audio, { ...chrome, pageHttp: true })).toEqual({ mode: "audio" });
	expect(playMode({ kind: "youtube", channelId: "UCx", videoId: null }, chrome)).toEqual({ mode: "youtube" });
});

test("at most N streams at once: a new one stops the oldest; pressing a playing one only moves it", () => {
	expect(startPlaying(["a", "b"], "c", 3)).toEqual({ playing: ["a", "b", "c"], stopped: [] });
	expect(startPlaying(["a", "b", "c"], "d", 3)).toEqual({ playing: ["b", "c", "d"], stopped: ["a"] });
	expect(startPlaying(["a", "b", "c"], "a", 3)).toEqual({ playing: ["b", "c", "a"], stopped: [] });
	expect(startPlaying(["a", "b", "c", "d"], "e", 2)).toEqual({
		playing: ["d", "e"],
		stopped: ["a", "b", "c"],
	});
});

test("probe reasons read as words; unknown codes say nothing rather than guess", () => {
	expect(reasonText("http-404", "es")).toBe("la dirección de la señal ya no existe (404)");
	expect(reasonText("segment-http-502", "en")).toBe("the server of the video failed (error 502)");
	expect(reasonText("stale-playlist", "es")).toBe("la lista no avanza");
	expect(reasonText("something-new", "es")).toBeNull();
	// Codes the short list does not word come from the shared table, never raw.
	expect(reasonText("ended", "es")).toBe("la transmisión terminó (su lista de video está cerrada)");
	expect(reasonText("private-host", "en")).toBe(
		"the stream points to a private or non-public address, which Vigía does not open",
	);
	expect(reasonText(null, "es")).toBeNull();
});

test("shared stems are shown as the headline's own words", () => {
	expect(
		readableWords(
			["alex", "cabello", "flor", "saab"],
			"Es parcialmente falso que Alex Saab revelara que lavó dinero para Maduro, Cilia Flores y los Cabello",
		),
	).toEqual(["Alex", "Cabello", "Flores", "Saab"]);
	expect(readableWords(["xyz"], "Nada que ver")).toEqual(["xyz"]);
	expect(readableWords(["energi"], "Energía eléctrica")).toEqual(["Energía"]);
});
