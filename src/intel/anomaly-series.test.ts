import { expect, test } from "bun:test";
import { Store } from "../core/store.ts";
import type { Json, Observation } from "../core/types.ts";
import { LinkIndex, linkBacklogOf } from "../ontology/links-store.ts";
import type { ConnectivityView, PlaceStatus } from "../panels/connectivity.ts";
import { ANOMALY_RULES, caracasDay, caracasDayStart, DAY, HOUR, MIN } from "./anomaly.ts";
import {
	HEADLINE_BACKLOG_MAX,
	type Judged,
	judgeAll,
	judgeConnectivity,
	spanOf,
	stateEntity,
} from "./anomaly-series.ts";

const NOW = Date.UTC(2026, 8, 28, 22); // 18:00 in Caracas
const TODAY = caracasDayStart(caracasDay(NOW));

const obs = (
	source: string,
	series: string,
	at: number,
	value: Json,
	extra: Partial<Observation> = {},
): Observation => ({
	source,
	series,
	sourceUrl: `https://example.org/${source}`,
	fetchedAt: at + MIN,
	observedAt: at,
	licence: "x",
	value,
	confidence: 1,
	basis: "measurement",
	...extra,
});

const find = (all: readonly Judged[], metric: string, entity: string) =>
	all.find((j) => j.metric.id === metric && j.entity === entity);
const judge = (store: Store, now = NOW) => judgeAll(store, now, { connectivity: null, linkBacklog: 0 });
const dateOf = (t: number) => new Date(t).toISOString().slice(0, 10);

test("official rates: the BCV's history and its daily page are one series by value date; a jump is unusual, an old one stale", () => {
	const store = new Store(":memory:");
	const rows: Observation[] = [];
	let v = 700;
	for (let d = 90; d >= 1; d--) {
		v *= 1.002;
		const at = TODAY - d * DAY;
		rows.push(obs("bcv-history", "usd-ves", at, { valueDate: dateOf(at), vesPerUsd: v }));
	}
	// Today's value, from the daily page, 6 % above yesterday.
	rows.push(obs("bcv-official", "usd-ves", TODAY, { valueDate: dateOf(TODAY), vesPerUnit: v * 1.06 }));
	store.insert(rows);
	const j = find(judge(store), "bcv.usd", "inst.bcv");
	expect(j?.feed).toBe("bcv-official");
	expect(j?.result).toMatchObject({
		unusual: true,
		direction: "up",
		points: ANOMALY_RULES.change.daily.window,
	});
	// A week later nothing new arrived: the series is not judged.
	expect(find(judge(store, NOW + 7 * DAY), "bcv.usd", "inst.bcv")?.result).toBe("stale");
});

test("fires: today's count against the covered days only; days the feed did not run are left out", () => {
	const store = new Store(":memory:");
	const rows: Observation[] = [];
	const zulia = { lat: 10.1, lon: -72.1, state: "VE-V" };
	let k = 0;
	const fire = (at: number) =>
		obs(
			"firms-fires",
			`fire:N20:${k++}`,
			at,
			{ kind: "detection", frpMW: 5, placeEs: "x" },
			{ location: zulia },
		);
	for (let d = 20; d >= 1; d--) {
		const day = TODAY - d * DAY;
		store.recordRun({
			source: "firms-fires",
			startedAt: day + 6 * HOUR,
			finishedAt: day + 6 * HOUR + MIN,
			ok: true,
			error: null,
			bytes: 1,
			received: 1,
			inserted: 1,
		});
		rows.push(fire(day + 5 * HOUR), fire(day + 17 * HOUR));
	}
	store.recordRun({
		source: "firms-fires",
		startedAt: NOW - HOUR,
		finishedAt: NOW - HOUR + MIN,
		ok: true,
		error: null,
		bytes: 1,
		received: 1,
		inserted: 1,
	});
	for (let i = 0; i < 30; i++) rows.push(fire(TODAY + 5 * HOUR + i * MIN));
	store.insert(rows);
	const zul = find(judge(store), "fires", stateEntity("VE-V") ?? "");
	expect(zul?.result).toMatchObject({ unusual: true, value: 30, baseline: 2, points: 20 });
	// Another state with no fires at all: judged, and ordinary.
	expect(find(judge(store), "fires", "ve.bolivar")?.result).toMatchObject({ unusual: false, value: 0 });
});

test("lightning: the same hour of previous days, complete windows only", () => {
	const store = new Store(":memory:");
	const hour = Math.floor(NOW / HOUR) * HOUR - HOUR; // the last complete hour
	const window = (at: number, n: number) =>
		obs("goes-glm", "window", at, {
			complete: true,
			venezuela: n,
			byState: n ? { "VE-F": n } : {},
			cells: [],
			windowStart: new Date(at).toISOString(),
		});
	const rows: Observation[] = [];
	for (let d = 1; d <= 14; d++)
		for (let q = 0; q < 4; q++) rows.push(window(hour - d * DAY + q * 15 * MIN, 10));
	for (let q = 0; q < 4; q++) rows.push(window(hour + q * 15 * MIN, 400));
	store.insert(rows);
	const bolivar = find(judge(store), "lightning", "ve.bolivar");
	expect(bolivar?.result).toMatchObject({ unusual: true, value: 1_600, baseline: 40, points: 14 });
	expect(bolivar?.observedAt).toBe(hour);
	// Two hours later without new windows: no reading.
	expect(find(judge(store, NOW + 2 * HOUR), "lightning", "ve.bolivar")?.result).toBe("stale");
});

test("Tor direct users: a jump Vigía sees but Tor's own detector does not flag is not an anomaly", () => {
	const store = new Store(":memory:");
	const rows: Observation[] = [];
	for (let d = 30; d >= 3; d--)
		rows.push(
			obs("tor-metrics", "country:VE:tor-relay", TODAY - d * DAY, {
				users: 10_000 + (d % 5) * 100,
				lower: null,
				upper: null,
			}),
		);
	rows.push(
		obs("tor-metrics", "country:VE:tor-relay", TODAY - 2 * DAY, {
			users: 25_000,
			lower: 8_000,
			upper: 30_000,
		}),
	);
	store.insert(rows);
	expect(find(judge(store), "tor.relay", "ve")?.result).toMatchObject({ unusual: false, direction: "up" });
	store.insert([
		obs(
			"tor-metrics",
			"country:VE:tor-relay",
			TODAY - 2 * DAY,
			{ users: 25_000, lower: 8_000, upper: 20_000 },
			{ fetchedAt: NOW },
		),
	]);
	expect(find(judge(store), "tor.relay", "ve")?.result).toMatchObject({ unusual: true });
});

test("headline counts come from the link index, and wait while it catches up", () => {
	const store = new Store(":memory:");
	const rows: Observation[] = [];
	let k = 0;
	const headline = (at: number, title: string) =>
		obs(
			"el-pitazo",
			`item:${k++}`,
			at,
			{
				outlet: "el-pitazo",
				title,
				link: `https://example.org/${k}`,
				summary: "",
				image: null,
				dateMissing: false,
				video: false,
			},
			{ licence: "headline-link", basis: "report" },
		);
	for (let d = 15; d >= 1; d--) {
		const day = TODAY - d * DAY;
		rows.push(
			headline(day + 10 * HOUR, "Apagón en Maracaibo"),
			headline(day + 11 * HOUR, "Lluvias en Maracaibo"),
		);
		for (let i = 0; i < 200; i++) rows.push(headline(day + 12 * HOUR + i * MIN, `Deportes ${i}`));
	}
	for (let i = 0; i < 25; i++)
		rows.push(headline(NOW - 5 * HOUR + i * 10 * MIN, `Protesta ${i} en Maracaibo`));
	store.insert(rows);
	const links = new LinkIndex(store);
	expect(linkBacklogOf(store)).toBeGreaterThan(0);
	// A large backlog (relinking after a restart or a new rules version) holds the headline series back entirely.
	expect(
		judgeAll(store, NOW, { connectivity: null, linkBacklog: HEADLINE_BACKLOG_MAX + 1 }).some(
			(j) => j.metric.id === "headlines",
		),
	).toBe(false);
	links.sync();
	expect(linkBacklogOf(store)).toBe(0);
	const zulia = find(judge(store), "headlines", "ve.zulia");
	expect(zulia?.result).toMatchObject({ unusual: true, value: 25, baseline: 2, points: 15 });
	// Municipalities are not judged here (their state is).
	expect(judge(store).some((j) => j.metric.id === "headlines" && j.entity === "ve.zulia.maracaibo")).toBe(
		false,
	);
});

const place = (over: Partial<PlaceStatus>): PlaceStatus =>
	({
		id: "VE-V",
		name: "Zulia",
		kind: "state",
		codes: [],
		level: "severe",
		headline: "",
		agreeing: ["bgp", "ping-slash24"],
		usableSignals: 2,
		signals: [
			{
				signal: "ping-slash24",
				level: "severe",
				noData: null,
				current: 300,
				observedAt: NOW - 20 * MIN,
				fetchedAt: NOW - 10 * MIN,
				baseline: 1_000,
				baselineDays: 7,
				pctOfBaseline: 30,
				changePct: -70,
				vsWeekPct: 30,
				noise: 0.05,
				dropBelow: 0.85,
				severeBelow: 0.6,
			},
			{
				signal: "bgp",
				level: "drop",
				noData: null,
				current: 90,
				observedAt: NOW - 20 * MIN,
				fetchedAt: NOW - 10 * MIN,
				baseline: 100,
				baselineDays: 7,
				pctOfBaseline: 90,
				changePct: -10,
				vsWeekPct: 90,
				noise: 0,
				dropBelow: 0.95,
				severeBelow: 0.8,
			},
		],
		lastBinAt: NOW - 20 * MIN,
		spark: null,
		events7d: 0,
		probes: null,
		lat: null,
		lon: null,
		note: null,
		feed: "ioda-states",
		sourceUrl: "https://ioda.inetintel.cc.gatech.edu/region/4492",
		...over,
	}) as PlaceStatus;

test("connectivity: the panel's own level decides; the score is the drop in thirds of the panel's threshold", () => {
	const view = {
		country: place({ id: "VE", kind: "country", level: "normal", agreeing: [] }),
		states: [place({}), place({ id: "VE-L", level: "drop" })],
		isps: [place({ id: "cantv", kind: "isp", level: "no-data", signals: [] })],
	} as unknown as ConnectivityView;
	const j = judgeConnectivity(view, NOW);
	const zulia = j.find((x) => x.entity === "ve.zulia");
	// ping at 30 % with a drop threshold of 85 %: (0.30 − 1) / (0.15 / 3) = −14.
	expect(zulia?.result).toMatchObject({ unusual: true, direction: "down", score: -14, changePct: -70 });
	expect(zulia?.detail).toMatchObject({ level: "severe", "ping-slash24PctOfBaseline": 30 });
	// A plain "drop" is not unusual (the incidents' calibrated level is "caída fuerte").
	expect(j.find((x) => x.entity === "ve.merida")?.result).toMatchObject({ unusual: false });
	expect(j.find((x) => x.entity === "net.cantv")?.result).toBe("weak");
	expect(j.find((x) => x.entity === "ve")?.result).toMatchObject({ unusual: false });
});

test("reserves through the reader: a month's close is judged against the previous closes, a +15 % close is unusual", () => {
	const build = (closeJump: number) => {
		const store = new Store(":memory:");
		const rows: Observation[] = [];
		let v = 12_000;
		const end = Date.UTC(2025, 11, 31, 4); // 2025-12-31, a Wednesday: the month's last weekday
		for (let t = end - 420 * DAY; t <= end; t += DAY) {
			const d = new Date(t);
			if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
			const date = dateOf(t);
			const next = new Date(t + (d.getUTCDay() === 5 ? 3 : 1) * DAY);
			const close = next.getUTCMonth() !== d.getUTCMonth();
			v *= t === end ? 1 + closeJump : close ? 1.03 : 1 + 0.0003 * ((d.getUTCDate() % 5) - 2);
			rows.push(obs("bcv-reserves", "reserves", t, { date, totalMusd: Math.round(v) }));
		}
		store.insert(rows);
		return find(judge(store, end + 12 * HOUR), "bcv.reserves", "inst.bcv");
	};
	const ordinary = build(0.03);
	expect(ordinary?.detail).toMatchObject({ monthEnd: true });
	expect(ordinary?.result).toMatchObject({ unusual: false, points: 12 });
	expect(build(0.15)?.result).toMatchObject({ unusual: true, direction: "up" });
});

test("a quote back after a five-day outage is judged as five steps, not one", () => {
	const store = new Store(":memory:");
	const rows: Observation[] = [];
	let v = 900;
	for (let d = 80; d >= 0; d--) {
		v *= 1.004;
		// Yadio down from 5 days ago until today.
		if (d >= 1 && d <= 5) continue;
		rows.push(obs("yadio", "usd-ves", TODAY + 12 * HOUR - d * DAY, { vesPerUsd: v }));
	}
	store.insert(rows);
	const j = find(judge(store), "yadio.usd", "ve");
	expect(j?.detail).toMatchObject({ stepsSpanned: 6 });
	expect(j?.result).toMatchObject({ unusual: false });
	expect(
		spanOf([{ observedAt: 0 }, { observedAt: DAY }, { observedAt: 2 * DAY }, { observedAt: 5 * DAY }], 60),
	).toBe(3);
	// A weekend in a business-day series is its rhythm.
	const business = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11, 14].map((d) => ({ observedAt: d * DAY }));
	expect(spanOf(business, 60)).toBe(1);
});
