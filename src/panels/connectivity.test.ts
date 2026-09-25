import { expect, test } from "bun:test";
import { join } from "node:path";
import { iodaAsn } from "../adapters/ioda-asn/index.ts";
import { type IodaEvent, iodaEvents } from "../adapters/ioda-events/index.ts";
import { iodaStates } from "../adapters/ioda-states/index.ts";
import { BIN_MS, type IodaBin, type IodaSignal } from "../adapters/ioda-states/ioda.ts";
import { hasFixture, loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import {
	ALL_CLEAR_MIN_STATES,
	allClear,
	type Bins,
	combine,
	connectivityView,
	cutoffs,
	headline,
	median,
	RULES,
	ratioNoise,
	readSignal,
	type SignalReading,
	sameSlotBaseline,
	sparkline,
	sumBins,
	summaryText,
} from "./connectivity.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A bin boundary: 2026-09-24 20:00 UTC (16:00 in Venezuela). */
const NOW = Date.UTC(2026, 8, 24, 20, 25);
const LAST_BIN = Date.UTC(2026, 8, 24, 20, 0);

/** 8 days of 10-minute bins ending at `last`, value f(t); f returning null leaves a gap. */
function makeBins(f: (t: number) => number | null, last = LAST_BIN, days = 8): Map<number, number> {
	const out = new Map<number, number>();
	for (let t = last - days * DAY; t <= last; t += BIN_MS) {
		const v = f(t);
		if (v !== null) out.set(t, v);
	}
	return out;
}
const input = (bins: Bins) => ({ bins, fetchedAt: new Map([...bins.keys()].map((t) => [t, t + 20 * MIN])) });

/** Daily cycle like Guárico's active probing: 80 at the morning peak, 45 in the evening trough. */
const diurnal = (t: number) => 62.5 + 17.5 * Math.cos((2 * Math.PI * ((t % DAY) - 14 * HOUR)) / DAY);
/** Small deterministic wobble (±2 %) so the noise estimate is not zero. */
const wobble = (t: number) => 1 + 0.02 * Math.sin(t / 7_777_777);

// ——— arithmetic ———

test("median of odd, even and empty lists", () => {
	expect(median([3, 1, 2])).toBe(2);
	expect(median([4, 1, 3, 2])).toBe(2.5);
	expect(median([])).toBeNull();
});

test("same-slot baseline ignores missing days and counts the ones it used", () => {
	const bins = new Map<number, number>();
	for (const [k, v] of [
		[1, 10],
		[2, 12],
		[4, 11],
		[7, 100],
	] as const)
		bins.set(LAST_BIN - k * DAY, v);
	bins.set(LAST_BIN - 8 * DAY, 999); // outside the 7-day window
	bins.set(LAST_BIN - DAY + BIN_MS, 999); // a different slot
	expect(sameSlotBaseline(bins, LAST_BIN)).toEqual({ value: 11.5, days: 4 });
	expect(sameSlotBaseline(new Map(), LAST_BIN)).toBeNull();
});

test("noise is zero for a flat signal and grows with scatter", () => {
	expect(
		ratioNoise(
			makeBins(() => 100),
			LAST_BIN,
		),
	).toBe(0);
	const noisy = ratioNoise(
		makeBins((t) => 100 * wobble(t)),
		LAST_BIN,
	);
	expect(noisy).toBeGreaterThan(0.005);
	expect(noisy).toBeLessThan(0.05);
	// Too little history: null.
	expect(
		ratioNoise(
			makeBins(() => 100, LAST_BIN, 1),
			LAST_BIN,
		),
	).toBeNull();
});

test("cutoffs clamp 3σ / 5σ between each signal's floor and cap", () => {
	expect(cutoffs(RULES["ping-slash24"], 0)).toEqual({ drop: 0.85, severe: 0.6 });
	expect(cutoffs(RULES["ping-slash24"], 0.1)).toEqual({ drop: 0.7, severe: 0.5 });
	expect(cutoffs(RULES["ping-slash24"], 1)).toEqual({ drop: 0.65, severe: 0.4 });
	expect(cutoffs(RULES.bgp, 0)).toEqual({ drop: 0.95, severe: 0.8 });
	for (const rule of Object.values(RULES)) {
		for (const noise of [0, 0.05, 0.1, 0.3, 1]) {
			const c = cutoffs(rule, noise);
			expect(c.severe).toBeLessThanOrEqual(c.drop);
		}
	}
});

// ——— one signal ———

test("the evening trough of a daily cycle is normal against the same slot, low against the week", () => {
	const bins = makeBins((t) => diurnal(t) * wobble(t));
	const trough = Date.UTC(2026, 8, 24, 2, 0);
	const r = readSignal(
		"ping-slash24",
		input(makeBins((t) => diurnal(t) * wobble(t), trough)),
		trough + 25 * MIN,
	);
	expect(r.level).toBe("normal");
	expect(r.pctOfBaseline).toBeGreaterThan(95);
	expect(r.vsWeekPct).toBeLessThan(80);
	// Against the plain weekly median it sits under 80 %: a flat baseline would have called every evening a drop.
	// At the afternoon slot the same series is normal too.
	expect(readSignal("ping-slash24", input(bins), NOW).level).toBe("normal");
});

test("a signal falls to drop, then severe, as the current bin sinks", () => {
	const at = (factor: number): SignalReading => {
		const bins = makeBins((t) => (t === LAST_BIN ? factor : 1) * 200 * wobble(t));
		return readSignal("ping-slash24", input(bins), NOW);
	};
	expect(at(1).level).toBe("normal");
	expect(at(0.9).level).toBe("normal");
	const drop = at(0.75);
	expect(drop.level).toBe("drop");
	expect(drop.changePct).toBeCloseTo(-25, -1);
	expect(drop.observedAt).toBe(LAST_BIN);
	expect(drop.fetchedAt).toBe(LAST_BIN + 20 * MIN);
	expect(drop.baselineDays).toBe(7);
	expect(drop.dropBelow).toBe(0.85);
	expect(at(0.3).level).toBe("severe");
});

test("no-data reasons: missing, stale, short history, too weak", () => {
	expect(readSignal("bgp", null, NOW)).toMatchObject({
		level: "no-data",
		noData: "IODA no publica esta señal aquí",
	});
	const stale = readSignal("bgp", input(makeBins(() => 100, LAST_BIN - 2 * HOUR)), NOW);
	expect(stale.level).toBe("no-data");
	expect(stale.noData).toContain("sin datos recientes");
	expect(stale.current).toBe(100);
	const young = readSignal("bgp", input(makeBins(() => 100, LAST_BIN, 3)), NOW);
	expect(young).toMatchObject({ level: "no-data", baselineDays: 3 });
	expect(young.noData).toContain("menos de 4 días");
	const weak = readSignal("merit-nt", input(makeBins(() => 3)), NOW);
	expect(weak).toMatchObject({ level: "no-data", noData: "señal demasiado débil para juzgar", baseline: 3 });
	expect(weak.vsWeekPct).toBeNull();
});

test("a gap in the newest bins means the previous bin is current, not zero", () => {
	const bins = makeBins((t) => (t > LAST_BIN - 30 * MIN ? null : 100));
	const r = readSignal("ping-slash24", input(bins), NOW);
	expect(r.observedAt).toBe(LAST_BIN - 30 * MIN);
	expect(r.level).toBe("normal");
});

// ——— combining signals ———

const reading = (signal: IodaSignal, level: SignalReading["level"]): SignalReading => ({
	signal,
	level,
	noData: null,
	current: null,
	observedAt: null,
	fetchedAt: null,
	baseline: null,
	baselineDays: 0,
	pctOfBaseline: null,
	changePct: null,
	vsWeekPct: null,
	noise: null,
	dropBelow: null,
	severeBelow: null,
});

test("severe needs two signals to agree unless only one is usable", () => {
	const c = (a: SignalReading["level"], b: SignalReading["level"], m: SignalReading["level"]) =>
		combine([reading("bgp", a), reading("ping-slash24", b), reading("merit-nt", m)]);
	expect(c("normal", "normal", "normal").level).toBe("normal");
	expect(c("normal", "severe", "normal")).toEqual({ level: "drop", agreeing: ["ping-slash24"], usable: 3 });
	expect(c("normal", "severe", "drop")).toEqual({
		level: "severe",
		agreeing: ["ping-slash24", "merit-nt"],
		usable: 3,
	});
	expect(c("drop", "drop", "normal").level).toBe("drop");
	expect(c("no-data", "severe", "no-data")).toEqual({
		level: "severe",
		agreeing: ["ping-slash24"],
		usable: 1,
	});
	expect(c("no-data", "no-data", "no-data").level).toBe("no-data");
});

test("headlines say which signals agree and never say blackout", () => {
	expect(headline("severe", ["ping-slash24", "merit-nt"], 3)).toBe(
		"Caída fuerte de señal: sondeo activo y telescopio coinciden",
	);
	expect(headline("drop", ["ping-slash24"], 3)).toBe(
		"Caída de señal en sondeo activo (las otras señales no la confirman)",
	);
	expect(headline("severe", ["bgp"], 1)).toBe("Caída fuerte de señal en bgp (única señal disponible)");
	for (const level of ["normal", "drop", "severe", "no-data"] as const)
		expect(headline(level, ["bgp"], 2).toLowerCase()).not.toContain("apagón");
});

test("summary text", () => {
	expect(summaryText({ normal: 21, drop: 2, severe: 1, noData: 1 })).toBe(
		"3 estados con caída de señal (1 fuerte)",
	);
	expect(summaryText({ normal: 23, drop: 1, severe: 0, noData: 1 })).toBe("1 estado con caída de señal");
	expect(summaryText({ normal: 24, drop: 0, severe: 0, noData: 1 })).toBe(
		"Sin caídas de señal en los 24 estados con datos",
	);
	expect(summaryText({ normal: 0, drop: 0, severe: 0, noData: 25 })).toBe(
		"Sin datos suficientes de IODA en este momento",
	);
});

test("sumBins adds aligned bins only", () => {
	const a = new Map([
		[0, 1],
		[BIN_MS, 2],
	]);
	const b = new Map([[BIN_MS, 10]]);
	expect([...sumBins([a, b])]).toEqual([[BIN_MS, 12]]);
	expect(sumBins([]).size).toBe(0);
});

test("sparkline: 48 hourly points of % of the same-slot baseline", () => {
	const bins = makeBins((t) => (t >= LAST_BIN - HOUR + BIN_MS ? 50 : 100));
	const s = sparkline("ping-slash24", bins, NOW);
	expect(s.values.length).toBe(48);
	expect(s.stepMs).toBe(HOUR);
	expect(s.startAt).toBe(Date.UTC(2026, 8, 22, 21, 0));
	expect(s.values[0]).toBe(100);
	// Last hour holds only the 20:00 bin, at half its baseline.
	expect(s.values.at(-1)).toBe(50);
	// 19:00 hour: 19:00 is 100, 19:10–19:50 are 50 → mean 58.3.
	expect(s.values.at(-2)).toBe(58.3);
});

// ——— the panel over a store ———

function binObs(source: string, series: string, bins: Bins): Observation<IodaBin>[] {
	const signal = series.split(":").at(-1) as IodaSignal;
	return [...bins].map(([t, value]) => ({
		source,
		series,
		sourceUrl: "https://ioda.inetintel.cc.gatech.edu/",
		fetchedAt: t + 20 * MIN,
		observedAt: t,
		licence: "ioda-all-rights-reserved",
		value: { signal, value },
		confidence: 1,
		basis: "measurement",
	}));
}

function eventObs(
	e: Partial<IodaEvent> & { startS: number; durationS: number },
	fetchedAt = NOW,
): Observation<IodaEvent> {
	const value: IodaEvent = {
		entityType: "region",
		entityCode: "4488",
		entityName: "Zulia",
		key: "VE-V",
		datasource: "ping-slash24",
		score: 1234.5,
		method: "median",
		...e,
	};
	return {
		source: "ioda-events",
		series: `event:${value.entityType}/${value.entityCode}:${value.datasource}:${value.startS}`,
		sourceUrl: "https://ioda.inetintel.cc.gatech.edu/region/4488",
		fetchedAt,
		observedAt: value.startS * 1_000,
		licence: "ioda-all-rights-reserved",
		value,
		confidence: 0.8,
		basis: "quote",
	};
}

test("panel: a two-signal collapse is severe, a one-signal drop is a drop, no data stays no data", () => {
	const store = new Store(":memory:");
	const steady = (level: number) => makeBins((t) => level * wobble(t));
	const collapse = (level: number) =>
		makeBins((t) => (t >= LAST_BIN - 20 * MIN ? 0.2 : 1) * level * wobble(t));
	for (const r of ["VE-V", "VE-K", "VE-A"]) {
		const pingDown = r === "VE-V" || r === "VE-K";
		store.insert(binObs("ioda-states", `state:${r}:bgp`, steady(400)));
		store.insert(binObs("ioda-states", `state:${r}:ping-slash24`, pingDown ? collapse(300) : steady(300)));
		store.insert(binObs("ioda-states", `state:${r}:merit-nt`, r === "VE-V" ? collapse(20) : steady(20)));
	}
	for (const s of ["bgp", "ping-slash24", "merit-nt"]) {
		store.insert(binObs("ioda-states", `country:VE:${s}`, steady(20_000)));
		store.insert(binObs("ioda-asn", `asn:8048:${s}`, steady(3_000)));
		store.insert(binObs("ioda-asn", `asn:27717:${s}`, steady(100)));
	}
	store.insert(binObs("ioda-asn", "asn:264731:bgp", steady(50)));
	// Digitel: AS264731 has only bgp, as in IODA.
	store.insert([
		eventObs({ startS: (NOW - 3 * HOUR) / 1_000, durationS: 1_800 }, NOW - 2 * HOUR),
		eventObs({ startS: (NOW - 3 * HOUR) / 1_000, durationS: 3 * 3_600 }),
		eventObs({ startS: (NOW - 9 * DAY) / 1_000, durationS: 3_600 }),
		eventObs({
			entityType: "asn",
			entityCode: "8048",
			entityName: "CANTV (AS8048)",
			key: "cantv",
			datasource: "bgp",
			startS: (NOW - 20 * DAY) / 1_000,
			durationS: 19 * 86_400,
		}),
	]);

	const v = connectivityView(store, NOW);
	const zulia = v.states.find((s) => s.id === "VE-V");
	expect(zulia?.level).toBe("severe");
	expect(zulia?.agreeing).toEqual(["ping-slash24", "merit-nt"]);
	expect(zulia?.headline).toBe("Caída fuerte de señal: sondeo activo y telescopio coinciden");
	expect(zulia?.signals.find((s) => s.signal === "ping-slash24")?.changePct).toBeCloseTo(-80, 0);
	expect(zulia?.lastBinAt).toBe(LAST_BIN);
	expect(zulia?.events7d).toBe(1);
	expect(zulia?.spark?.values.length).toBe(48);
	expect(zulia?.lat).toBeCloseTo(10.49, 1);
	expect(zulia?.feed).toBe("ioda-states");
	expect(zulia?.sourceUrl).toBe("https://ioda.inetintel.cc.gatech.edu/region/4488");

	const lara = v.states.find((s) => s.id === "VE-K");
	expect(lara?.level).toBe("drop");
	expect(lara?.agreeing).toEqual(["ping-slash24"]);
	expect(v.states.find((s) => s.id === "VE-A")?.level).toBe("normal");
	expect(v.states.find((s) => s.id === "VE-W")?.level).toBe("no-data");

	// Worst first, then by name.
	expect(v.states.slice(0, 2).map((s) => s.id)).toEqual(["VE-V", "VE-K"]);
	expect(v.summary.states).toEqual({ normal: 1, drop: 1, severe: 1, noData: 22 });
	expect(v.summary.text).toBe("2 estados con caída de señal (1 fuerte)");
	expect(v.summary.affected).toEqual(["Zulia", "Lara"]);
	expect(v.country.level).toBe("normal");
	expect(v.asOf).toBe(LAST_BIN);

	const digitel = v.isps.find((i) => i.id === "digitel");
	expect(digitel?.signals.find((s) => s.signal === "bgp")?.current).toBeCloseTo(150, -1);
	expect(digitel?.signals.find((s) => s.signal === "ping-slash24")?.current).toBeCloseTo(100, -1);
	expect(digitel?.note).toBe(
		"Suma de AS264731 + AS27717; Sondeo activo: solo AS27717; Telescopio: solo AS27717",
	);
	expect(v.isps.find((i) => i.id === "cantv")?.level).toBe("normal");
	expect(v.isps.find((i) => i.id === "movilnet")?.level).toBe("no-data");

	// Events: the latest revision (3 h long), the CANTV one still overlapping the week; the 9-day-old one is gone.
	expect(v.events.map((e) => [e.key, e.durationMin])).toEqual([
		["VE-V", 180],
		["cantv", 27_360],
	]);
	expect(v.events[0]?.openAtFetch).toBe(true);
	expect(v.events[0]?.score).toBe(1235);
	expect(v.eventsFetchedAt).toBe(NOW);
	expect(v.method.rules.map((r) => r.dropFloorPct)).toEqual([5, 15, 25]);
	expect(v.attribution).toBe("Datos: IODA, Georgia Tech");
	expect(JSON.stringify(v).toLowerCase()).not.toContain("apagón en");
});

const iodaCapture = (id: string) => join(import.meta.dir, "..", "adapters", id, "fixtures", "2026-09-24");
// IODA's recordings are not redistributable, so they are absent from the public repository (see hasFixture).
const iodaRecorded = [iodaStates, iodaAsn, iodaEvents].every((a) => hasFixture(iodaCapture(a.id)));

test.skipIf(!iodaRecorded)("panel over the recorded 8-day IODA capture (2026-09-24 23:25 UTC)", () => {
	const store = new Store(":memory:");
	let now = 0;
	for (const a of [iodaStates, iodaAsn, iodaEvents]) {
		const raws = loadFixture(iodaCapture(a.id));
		for (const r of raws) now = Math.max(now, r.fetchedAt);
		store.insert(a.normalise(raws) as Observation[]);
	}
	const started = performance.now();
	const v = connectivityView(store, now);
	const ms = performance.now() - started;
	expect(ms).toBeLessThan(2_000);
	expect(v.asOf).toBe(Date.UTC(2026, 8, 24, 23, 20));
	// That evening only Lara's active probing was below its band (79.8 % of the same slot, 3σ band 85 %).
	expect(v.summary.text).toBe("1 estado con caída de señal");
	const lara = v.states[0];
	expect(lara?.name).toBe("Lara");
	expect(lara?.signals.find((s) => s.signal === "ping-slash24")?.pctOfBaseline).toBe(79.8);
	expect(v.states.find((s) => s.id === "VE-W")?.level).toBe("no-data");
	expect(v.country.level).toBe("normal");
	expect(v.isps.length).toBe(9);
	expect(v.events.length).toBeGreaterThan(50);
	expect(v.events.every((e, i, all) => i === 0 || (all[i - 1]?.startAt ?? 0) >= e.startAt)).toBe(true);
	// Small enough for a phone on a slow link.
	expect(JSON.stringify(v).length).toBeLessThan(120_000);
});

test("RIPE Atlas counts sit beside the IODA reading, per state, with disconnects over 3 h and 24 h", () => {
	const store = new Store(":memory:");
	const atlas = (
		series: string,
		observedAt: number,
		value: Record<string, number>,
		fetchedAt = observedAt,
	) => ({
		source: "ripe-atlas-probes",
		series,
		sourceUrl: "https://atlas.ripe.net/probes/?country_code=VE",
		fetchedAt,
		observedAt,
		licence: "ripe-atlas-terms",
		value,
		confidence: 1,
		basis: "measurement" as const,
	});
	const read = NOW - 5 * MIN;
	const counts = (c: number, d: number, dropped: number) => ({
		connected: c,
		disconnected: d,
		droppedLastHour: dropped,
		unlocated: 0,
	});
	const ev = (n: number) => ({ disconnects: n, connects: 0, probesDisconnecting: n });
	store.insert([
		// An older list where Zulia still had all probes connected: superseded.
		atlas("country:VE:probes", read - 10 * MIN, counts(12, 0, 0)),
		atlas("state:VE-V:probes", read - 10 * MIN, counts(9, 0, 0)),
		atlas("country:VE:probes", read, counts(9, 3, 3)),
		atlas("state:VE-V:probes", read, counts(6, 3, 3)),
		atlas("state:VE-A:probes", read, counts(3, 0, 0)),
		atlas("state:VE-V:connection-events", Date.UTC(2026, 8, 24, 20), ev(1), read - 10 * MIN),
		// Revised: the 20:00 hour grew to 3 disconnects.
		atlas("state:VE-V:connection-events", Date.UTC(2026, 8, 24, 20), ev(3), read),
		atlas("state:VE-V:connection-events", Date.UTC(2026, 8, 24, 18), ev(2), read),
		atlas("state:VE-V:connection-events", Date.UTC(2026, 8, 24, 10), ev(5), read),
		atlas("state:VE-V:connection-events", Date.UTC(2026, 8, 23, 10), ev(7), read),
	]);
	const v = connectivityView(store, NOW);
	expect(v.atlas.observedAt).toBe(read);
	expect(v.states.find((s) => s.id === "VE-V")?.probes).toEqual({
		connected: 6,
		disconnected: 3,
		active: 9,
		droppedLastHour: 3,
		disconnects3h: 5,
		disconnects24h: 10,
		observedAt: read,
		feed: "ripe-atlas-probes",
		sourceUrl: "https://atlas.ripe.net/probes/?country_code=VE",
	});
	expect(v.states.find((s) => s.id === "VE-A")?.probes?.disconnects24h).toBe(0);
	expect(v.states.find((s) => s.id === "VE-B")?.probes).toBeNull();
	expect(v.country.probes?.active).toBe(12);
	expect(v.isps.every((i) => i.probes === null)).toBe(true);
	// A probe list older than 30 minutes is not presented as current.
	const later = connectivityView(store, read + 31 * MIN);
	expect(later.atlas.observedAt).toBeNull();
	expect(later.states.every((s) => s.probes === null)).toBe(true);
});

test("RIPEstat routing reaches the view model only as % changes against the 7-day median", () => {
	const store = new Store(":memory:");
	const rows = [];
	for (let t = LAST_BIN - 8 * DAY; t <= LAST_BIN - HOUR; t += HOUR) {
		const last = t === LAST_BIN - HOUR;
		rows.push({
			source: "ripestat-routing",
			series: "country:VE:routing",
			sourceUrl: "https://stat.ripe.net/app/launchpad/VE",
			fetchedAt: NOW,
			observedAt: t,
			licence: "ripestat-no-redistribution",
			value: { v4Prefixes: last ? 2_400 : 2_500, v6Prefixes: last ? null : 680, asns: 180 },
			confidence: 1,
			basis: "measurement" as const,
		});
	}
	store.insert(rows);
	const r = connectivityView(store, NOW).routing;
	expect(r).toMatchObject({
		observedAt: LAST_BIN - HOUR,
		v4ChangePct: -4,
		v6ChangePct: null,
		asnsChangePct: 0,
		drop: false,
		licence: "ripestat-no-redistribution",
	});
	// The raw counts never appear in the view model.
	expect(JSON.stringify(r)).not.toMatch(/2400|2500|"180"|:180\b/);
	expect(connectivityView(store, NOW + 6 * HOUR).routing).toBeNull();
});

test("no all-clear without coverage: silence from missing data is not a working network", () => {
	expect(allClear({ normal: 24, drop: 0, severe: 0 })).toBe(true);
	expect(allClear({ normal: ALL_CLEAR_MIN_STATES - 1, drop: 0, severe: 0 })).toBe(false);
	expect(allClear({ normal: 24, drop: 1, severe: 0 })).toBe(false);
	expect(summaryText({ normal: 3, drop: 0, severe: 0, noData: 21 })).toBe(
		"Sin caídas en los 3 estados con datos; faltan datos de 21",
	);
});
