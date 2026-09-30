import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Store } from "../core/store.ts";
import { crowdEvidence } from "../intel/signals.ts";
import { registry } from "../ontology/registry.ts";
import { crowdView } from "../panels/crowd.ts";
import { bucketOf } from "./counts.ts";
import { solve } from "./pow-solve.ts";
import { CROWD_RULES, CROWD_SOURCE, type CrowdMode } from "./rules.ts";
import { type CrowdAggregate, CrowdService, type SubmitOutcome } from "./service.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A Monday, one minute into a quarter hour. */
const T0 = Date.UTC(2026, 8, 28, 12, 1);
const BARALT = "ve.zulia.baralt"; // ~73,000 people: the floor of 20 per hour applies
const MARACAIBO = "ve.zulia.maracaibo"; // ~1.86 million: one per 5,000 people, 371 per hour
const CABIMAS = "ve.zulia.cabimas";

const ip = (i: number) => `198.51.${Math.floor(i / 250)}.${(i % 250) + 1}`;

function setup(mode: CrowdMode = "public", enabled = true) {
	const clock = { now: T0 };
	const store = new Store(":memory:");
	const crowd = new CrowdService({ store, mode, enabled, now: () => clock.now, powBits: 2 });
	const report = (
		from: string,
		municipality: string,
		answers: Record<string, string>,
		token?: string,
	): SubmitOutcome => {
		const c = crowd.challenge(from);
		if (!c.ok) return c;
		const ch = c.challenge as { challenge: string; difficulty: number };
		const nonce = solve(ch.challenge, ch.difficulty)?.nonce;
		return crowd.submit(
			{ municipality, answers, challenge: ch.challenge, nonce, ...(token ? { token } : {}) },
			from,
		);
	};
	const view = () => crowdView(store, clock.now);
	const muni = (id: string, service = "luz") =>
		view().municipalities.find((m) => m.entity === id && m.service === service);
	return { store, crowd, report, clock, view, muni };
}

const statuses = (o: SubmitOutcome) => (o.ok ? o.results.map((r) => r.status) : [o.code]);

/** A per-device token as a page makes it: 16 random bytes, base64url. */
const token = () => randomBytes(16).toString("base64url");

describe("what is stored", () => {
	test("the open bucket stays in memory; a closed one is written at once, in key order (review M8)", () => {
		const { store, crowd, report, muni } = setup("local");
		const written = () =>
			store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM crowd_counts").get()?.n;
		for (const [i, f] of ["198.51.100.7", "203.0.113.9", "192.0.2.44"].entries())
			expect(report(f, BARALT, i === 1 ? { agua: "si", luz: "no" } : { luz: "no" }).ok).toBe(true);
		// Nothing on disk while the bucket is open, and no per-report arrivals table at all.
		expect(written()).toBe(0);
		const tables = store.db
			.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all();
		expect(tables.map((t) => t.name)).not.toContain("crowd_arrivals");
		const before = JSON.stringify(muni(BARALT));
		// The bucket closes: one flush writes every count; what is shown does not change.
		expect(crowd.counts.flush(T0 + 20 * MIN)).toBe(2);
		expect(written()).toBe(2);
		expect(JSON.stringify(muni(BARALT))).toBe(before);
		expect(crowd.counts.flush(T0 + 20 * MIN)).toBe(0);
	});

	test("counts only: municipality, service, answer and a 15-minute bucket; no address or fingerprint anywhere", () => {
		const { store, crowd, report } = setup();
		const from = ["198.51.100.7", "2001:db8:1234:5678::1", "203.0.113.9"];
		for (const f of from) expect(report(f, BARALT, { luz: "no", agua: "si" }).ok).toBe(true);
		crowd.snapshot(T0 + 20 * MIN);
		const columns = store.db
			.query<{ name: string }, []>("SELECT name FROM pragma_table_info('crowd_counts')")
			.all()
			.map((c) => c.name);
		expect(columns).toEqual(["entity", "service", "bucket", "answer", "counted", "held", "extra"]);
		const rows = store.db
			.query<{ bucket: number }, []>("SELECT bucket FROM crowd_counts")
			.all()
			.map((r) => r.bucket);
		for (const b of rows) expect(b % CROWD_RULES.bucketMs).toBe(0);
		// Every table, every row: nothing that identifies a connection.
		const tables = store.db
			.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all()
			.map((t) => t.name);
		const dump = tables.map((t) => JSON.stringify(store.db.query(`SELECT * FROM "${t}"`).all())).join("\n");
		const prints = from.map((f) => crowd.memory.fingerprint(f));
		for (const needle of [...from, "198.51.100", "2001:db8", ...prints]) expect(dump).not.toContain(needle);
		// Not the exact time either: only bucket starts and publication times on bucket boundaries.
		expect(dump).not.toContain(String(T0));
	});
});

describe("publishing", () => {
	test("public: nothing below 3 distinct reporters; the counts appear when the bucket closes, never the open one", () => {
		const { crowd, report, clock, muni, view } = setup("public");
		report(ip(1), BARALT, { luz: "no" });
		report(ip(2), BARALT, { luz: "no" });
		crowd.snapshot();
		expect(muni(BARALT)).toBeUndefined();
		report(ip(3), BARALT, { luz: "intermitente" });
		crowd.snapshot();
		// Still the open bucket.
		expect(muni(BARALT)).toBeUndefined();
		clock.now = bucketOf(T0) + CROWD_RULES.bucketMs + 2_000;
		crowd.snapshot();
		const m = muni(BARALT);
		expect(m?.reports).toBe(3);
		expect(m?.answers).toEqual({ si: 0, no: 2, intermitente: 1 });
		expect(m?.observedAt).toBe(bucketOf(T0) + CROWD_RULES.bucketMs);
		expect(m?.text.es).toBe("3 reportes en 2 h: 2 «no», 1 «intermitente», 0 «sí»");
		expect(view().basis).toBe("report");
	});

	test("the answer of a submission says when it is published", () => {
		const { report } = setup("public");
		const out = report(ip(1), BARALT, { luz: "no" });
		expect(out.ok && out.publishedFrom).toBe(bucketOf(T0) + CROWD_RULES.bucketMs);
		const local = setup("local").report(ip(1), BARALT, { luz: "no" });
		expect(local.ok && local.publishedFrom).toBe(T0);
	});

	test("local: dated by the bucket, never by the moment of the report", () => {
		const { crowd, report, store } = setup("local");
		report("192.168.1.20", BARALT, { luz: "no" });
		crowd.snapshot(T0 + 5_000);
		const row = store.latestPerSeries(CROWD_SOURCE, 0, 10).find((o) => o.series.startsWith("muni:"));
		expect(row?.observedAt).toBe(bucketOf(T0));
		expect(row?.fetchedAt).toBe(bucketOf(T0));
	});

	test("local on the network (--host 0.0.0.0): closed buckets only, like a mirror", () => {
		const clock = { now: T0 };
		const store = new Store(":memory:");
		const crowd = new CrowdService({
			store,
			mode: "local",
			enabled: true,
			now: () => clock.now,
			powBits: 2,
			lan: true,
		});
		const c = crowd.challenge("192.168.1.20");
		const ch = (c.ok ? c.challenge : {}) as { challenge: string; difficulty: number };
		const out = crowd.submit(
			{
				municipality: BARALT,
				answers: { luz: "no" },
				challenge: ch.challenge,
				nonce: solve(ch.challenge, ch.difficulty)?.nonce,
			},
			"192.168.1.20",
		);
		expect(out.ok && out.publishedFrom).toBe(bucketOf(T0) + CROWD_RULES.bucketMs);
		crowd.snapshot();
		expect(crowdView(store, clock.now).municipalities).toEqual([]);
		clock.now += CROWD_RULES.bucketMs;
		crowd.snapshot();
		expect(crowdView(store, clock.now).municipalities[0]?.reports).toBe(1);
	});

	test("a mirror never shows what a personal Vigía published on the same database", () => {
		const { crowd, report, clock, store } = setup("local");
		report("192.168.1.20", BARALT, { luz: "no" });
		crowd.snapshot();
		expect(crowdView(store, clock.now).municipalities).toHaveLength(1);
		// The same database, now served as a public mirror.
		new CrowdService({ store, mode: "public", enabled: true, now: () => clock.now, powBits: 2 });
		expect(crowdView(store, clock.now).municipalities).toEqual([]);
	});

	test("after a day, rows keep only hourly totals with no answer (what the baseline needs)", () => {
		const { crowd, clock, store } = setup("public");
		const old = bucketOf(clock.now) - 3 * DAY;
		crowd.counts.add(BARALT, "luz", old, "no", "counted", 1);
		crowd.counts.add(BARALT, "luz", old + CROWD_RULES.bucketMs, "si", "counted", 1);
		crowd.counts.add(BARALT, "luz", old, "si", "held", 1);
		const before = crowd.counts.usualPeak(BARALT, "luz", clock.now, 3);
		crowd.counts.prune(clock.now - CROWD_RULES.retentionDays * DAY, clock.now);
		const rows = store.db
			.query("SELECT answer, counted, held FROM crowd_counts WHERE entity = ?")
			.all(BARALT);
		expect(rows).toEqual([{ answer: "*", counted: 2, held: 1 }]);
		expect(crowd.counts.usualPeak(BARALT, "luz", clock.now, 3)).toBe(before);
	});

	test("local: one report is enough and it shows at once", () => {
		const { crowd, report, muni } = setup("local");
		report("192.168.1.20", BARALT, { internet: "no" });
		crowd.snapshot();
		expect(muni(BARALT, "internet")?.reports).toBe(1);
		expect(muni(BARALT, "internet")?.minReporters).toBe(1);
	});

	test("a state sums only its municipalities that are shown: a hidden report cannot be read off by subtraction", () => {
		const { crowd, report, clock, view } = setup("public");
		for (let i = 0; i < 3; i++) report(ip(i), BARALT, { luz: "si" });
		report(ip(9), CABIMAS, { luz: "no" }); // one report: hidden, and not in Zulia's sum either
		clock.now += CROWD_RULES.bucketMs;
		crowd.snapshot();
		const v = view();
		expect(v.municipalities.map((m) => m.entity)).toEqual([BARALT]);
		const zulia = v.states.find((s) => s.entity === "ve.zulia");
		expect(zulia?.answers).toEqual({ si: 3, no: 0, intermitente: 0 });
		expect(zulia?.municipalities).toBe(1);
		expect(zulia?.text.es).toContain("en 1 municipio");
		// Two more in Cabimas: now it is shown, and the state adds it.
		report(ip(10), CABIMAS, { luz: "no" });
		report(ip(11), CABIMAS, { luz: "no" });
		clock.now += CROWD_RULES.bucketMs;
		crowd.snapshot();
		expect(view().states.find((s) => s.entity === "ve.zulia")?.answers).toEqual({
			si: 3,
			no: 3,
			intermitente: 0,
		});
	});
	test("after the window passes without reports, a tombstone is published and nothing is shown", () => {
		const { crowd, report, clock, muni, store } = setup("public");
		for (let i = 0; i < 3; i++) report(ip(i), BARALT, { luz: "no" });
		clock.now += CROWD_RULES.bucketMs;
		crowd.snapshot();
		expect(muni(BARALT)?.reports).toBe(3);
		clock.now += CROWD_RULES.windowMs;
		crowd.snapshot();
		expect(muni(BARALT)).toBeUndefined();
		const fin = store.latest(CROWD_SOURCE, `muni:${BARALT}:luz:fin`);
		expect((fin?.value as { shown: boolean } | undefined)?.shown).toBe(false);
	});

	test("every bucket boundary republishes (so a figure's age says the publisher is alive); an unchanged bucket does not", () => {
		const { crowd, report, clock, store } = setup("public");
		for (let i = 0; i < 3; i++) report(ip(i), BARALT, { luz: "no" });
		clock.now += CROWD_RULES.bucketMs;
		const first = crowd.snapshot();
		expect(first).toBeGreaterThan(0);
		expect(crowd.snapshot()).toBe(0);
		clock.now += CROWD_RULES.bucketMs;
		expect(crowd.snapshot()).toBe(first);
		// After a restart the service reads what it published and does not publish it twice.
		const again = new CrowdService({
			store,
			mode: "public",
			enabled: true,
			now: () => clock.now,
			powBits: 2,
		});
		expect(again.snapshot()).toBe(0);
	});

	test("a figure the publisher stopped refreshing is marked stale", () => {
		const { crowd, report, clock, muni } = setup("public");
		for (let i = 0; i < 3; i++) report(ip(i), BARALT, { luz: "no" });
		clock.now += CROWD_RULES.bucketMs;
		crowd.snapshot();
		expect(muni(BARALT)?.stale).toBe(false);
		clock.now += CROWD_RULES.staleAfterMs + MIN;
		expect(muni(BARALT)?.stale).toBe(true);
	});
});

describe("one connection, one answer", () => {
	test("repeat reports update the earlier answer instead of adding", () => {
		const { crowd, report, clock, muni } = setup("local");
		expect(statuses(report(ip(1), BARALT, { luz: "no" }))).toEqual(["counted"]);
		clock.now += 20 * MIN;
		expect(statuses(report(ip(1), BARALT, { luz: "si" }))).toEqual(["updated"]);
		crowd.snapshot();
		expect(muni(BARALT)?.reports).toBe(1);
		expect(muni(BARALT)?.answers).toEqual({ si: 1, no: 0, intermitente: 0 });
	});

	test("IPv6: one /64 is one connection (rotating the host part does not add)", () => {
		const { crowd, report, muni } = setup("local");
		report("2001:db8:aa:bb::1", BARALT, { luz: "no" });
		report("2001:db8:aa:bb:ffff::2", BARALT, { luz: "no" });
		crowd.snapshot();
		expect(muni(BARALT)?.reports).toBe(1);
	});
});

describe("attacks", () => {
	test("burst from one connection: after 8 submissions it is refused (429)", () => {
		const { report } = setup();
		const out = Array.from({ length: 10 }, (_, i) =>
			report(ip(1), BARALT, { [["luz", "agua", "internet", "gasolina"][i % 4] as string]: "no" }),
		);
		expect(out.slice(0, 8).every((o) => o.ok)).toBe(true);
		expect(out.slice(8).map((o) => !o.ok && o.status)).toEqual([429, 429]);
		// The rate is 30 an hour: two minutes later exactly one more gets through.
		const later = setup();
		for (let i = 0; i < 8; i++) later.report(ip(1), BARALT, { luz: "no" });
		later.clock.now += 2 * MIN + 1_000;
		expect(later.report(ip(1), BARALT, { luz: "si" }).ok).toBe(true);
		expect(later.report(ip(1), BARALT, { luz: "si" }).ok).toBe(false);
	});

	test("invalid work never spends the limits (behind a shared address, one person cannot lock out the rest)", () => {
		const { crowd, report } = setup();
		for (let i = 0; i < 50; i++)
			crowd.submit({ municipality: BARALT, answers: { luz: "no" }, challenge: "c1.x", nonce: "0" }, ip(1));
		expect(report(ip(1), BARALT, { luz: "no" }).ok).toBe(true);
	});

	test("IPv6: every /64 of one /48 together is limited (a site cannot rotate 65,536 prefixes)", () => {
		const { report } = setup();
		const out = Array.from({ length: 45 }, (_, i) =>
			report(`2001:db8:77:${i.toString(16)}::1`, BARALT, { luz: "no" }),
		);
		expect(out.filter((o) => o.ok)).toHaveLength(CROWD_RULES.perClient.site48Burst);
		expect(out.at(-1)).toMatchObject({ ok: false, code: "rate" });
	});
	test("many municipalities from one connection: the seventh of the day is refused; the next day it may", () => {
		const { report, clock } = setup();
		const munis = [
			BARALT,
			CABIMAS,
			MARACAIBO,
			"ve.zulia.colon",
			"ve.zulia.catatumbo",
			"ve.zulia.almirante-padilla",
			"ve.zulia.mara",
		];
		const out = munis.map((m) => report(ip(1), m, { luz: "no" }));
		expect(out.slice(0, 6).every((o) => o.ok)).toBe(true);
		expect(out[6]).toMatchObject({ ok: false, status: 429, code: "municipalities" });
		// Updating one already reported is still allowed.
		expect(report(ip(1), BARALT, { luz: "si" }).ok).toBe(true);
		clock.now += DAY + MIN;
		expect(report(ip(1), "ve.zulia.mara", { luz: "no" }).ok).toBe(true);
	});
	test("a distributed burst beyond its answer's ceiling is held as possible manipulation, never counted", () => {
		const { crowd, report, clock, muni, view } = setup("public");
		expect(crowd.ceiling(crowdEntity(BARALT), "luz", clock.now)).toBe(30);
		const out = Array.from({ length: 40 }, (_, i) => report(ip(i), BARALT, { luz: "no" }));
		expect(out.flatMap(statuses).filter((s) => s === "counted")).toHaveLength(30);
		expect(out.flatMap(statuses).filter((s) => s === "held")).toHaveLength(10);
		clock.now += CROWD_RULES.bucketMs;
		crowd.snapshot();
		const m = muni(BARALT);
		expect(m?.reports).toBe(30);
		expect(m?.held).toBe(10);
		expect(m?.heldAnswers).toEqual({ si: 0, no: 10, intermitente: 0 });
		expect(m?.flagged).toBe(true);
		expect(m?.text.es).toContain("10 retenidos por posible manipulación, no se cuentan");
		// Held «no» answers: not incident evidence.
		expect(m && crowdEvidence(m)).toBeNull();
		expect(view().counts.flagged).toBe(1);
		expect(view().states.find((s) => s.entity === "ve.zulia")?.flagged).toBe(true);
	});

	test("hiding a blackout: a flood of «sí» never holds a genuine «no», and re-answering «sí» adds nothing", () => {
		const { crowd, report, clock, muni } = setup("public");
		// 40 addresses answer «sí» (10 beyond the «sí» ceiling are held).
		for (let i = 0; i < 40; i++) report(ip(i), BARALT, { luz: "si" });
		// The genuine «no» reports are all counted.
		const genuine = Array.from({ length: 6 }, (_, i) => report(ip(100 + i), BARALT, { luz: "no" }));
		expect(genuine.flatMap(statuses)).toEqual(Array(6).fill("counted"));
		// 70 minutes later the same 30 counted addresses re-answer «sí»: updates, not arrivals; new «no» still counted.
		clock.now += 70 * MIN;
		for (let i = 0; i < 30; i++) expect(statuses(report(ip(i), BARALT, { luz: "si" }))).toEqual(["updated"]);
		expect(statuses(report(ip(200), BARALT, { luz: "no" }))).toEqual(["counted"]);
		clock.now += CROWD_RULES.bucketMs;
		crowd.snapshot();
		const m = muni(BARALT);
		expect(m?.answers).toEqual({ si: 30, no: 7, intermitente: 0 });
		expect(m?.heldAnswers).toEqual({ si: 10, no: 0, intermitente: 0 });
		// Flagged (the «sí» flood is visible), but the «no» answers still make incident evidence.
		expect(m?.flagged).toBe(true);
		expect(m && crowdEvidence(m)?.family).toBe("usuarios");
	});

	test("changing an answer is an arrival of the new answer, under its ceiling", () => {
		const { report } = setup("public");
		for (let i = 0; i < 30; i++) report(ip(i), BARALT, { luz: "no" });
		report(ip(99), BARALT, { luz: "si" });
		// «no» is full: switching to «no» is held.
		expect(statuses(report(ip(99), BARALT, { luz: "no" }))).toEqual(["updated"]);
		expect(statuses(report(ip(98), BARALT, { luz: "no" }))).toEqual(["held"]);
	});
	test("the flood window is the last hour: an hour later the same municipality counts again", () => {
		const { report, clock } = setup("public");
		for (let i = 0; i < 30; i++) report(ip(i), BARALT, { luz: "no" });
		expect(statuses(report(ip(99), BARALT, { luz: "no" }))).toEqual(["held"]);
		clock.now += HOUR;
		expect(statuses(report(ip(100), BARALT, { luz: "no" }))).toEqual(["counted"]);
	});
	test("a first real blackout in a big city is not held: the ceiling follows the population", () => {
		const { crowd, report, clock, muni } = setup("public");
		expect(crowd.ceiling(crowdEntity(MARACAIBO), "luz", clock.now)).toBe(743);
		const out = Array.from({ length: 150 }, (_, i) => report(ip(i), MARACAIBO, { luz: "no" }));
		expect(out.flatMap(statuses).every((s) => s === "counted")).toBe(true);
		clock.now += CROWD_RULES.bucketMs;
		crowd.snapshot();
		const m = muni(MARACAIBO);
		expect(m?.reports).toBe(150);
		expect(m?.flagged).toBe(false);
		expect(m && crowdEvidence(m)?.family).toBe("usuarios");
	});
	test("the ceiling cannot be ratcheted up by a few days of attack (median of daily peaks over 14 days)", () => {
		const { crowd, clock } = setup("public");
		const today = Math.floor(clock.now / DAY) * DAY;
		const seedPeak = (daysAgo: number, n: number) => {
			for (let k = 0; k < n; k++)
				crowd.counts.add(BARALT, "luz", today - daysAgo * DAY + 10 * HOUR, "no", "counted", 1);
		};
		// Three days of a 200-report attack: the median of 14 daily peaks is still 0.
		for (const d of [1, 2, 3]) seedPeak(d, 200);
		expect(crowd.counts.usualPeak(BARALT, "luz", clock.now)).toBe(0);
		expect(crowd.ceiling(crowdEntity(BARALT), "luz", clock.now)).toBe(30);
		// A municipality that really has ~10 reports in its busiest hour on most days gets 4 × 10.
		const other = setup("public");
		for (let d = 1; d <= 9; d++)
			for (let k = 0; k < 10; k++)
				other.crowd.counts.add(BARALT, "luz", today - d * DAY + 20 * HOUR, "si", "counted", 1);
		expect(other.crowd.counts.usualPeak(BARALT, "luz", clock.now)).toBe(10);
		expect(other.crowd.ceiling(crowdEntity(BARALT), "luz", clock.now)).toBe(40);
		// Held reports never raise it.
		const third = setup("public");
		for (let d = 1; d <= 14; d++)
			for (let k = 0; k < 50; k++)
				third.crowd.counts.add(BARALT, "luz", today - d * DAY + 20 * HOUR, "no", "held", 1);
		expect(third.crowd.ceiling(crowdEntity(BARALT), "luz", clock.now)).toBe(30);
	});

	test("slow drip from one connection is still one report; from many, it is reports, never an incident alone", () => {
		const { crowd, report, clock, muni } = setup("public");
		// One connection re-reporting every 20 minutes for 6 hours.
		for (let k = 0; k < 18; k++) {
			const out = report(ip(1), BARALT, { luz: k % 2 ? "no" : "intermitente" });
			expect(out.ok).toBe(true);
			clock.now += 20 * MIN;
		}
		crowd.snapshot();
		// Alone it is below the public minimum: nothing is shown at all.
		expect(muni(BARALT)).toBeUndefined();
		expect(crowd.counts.window(0, clock.now + DAY).reduce((s, r) => s + r.counted, 0)).toBe(1);
	});

	test("a flood in one state: past 200 new reports a minute it is refused there, never elsewhere; checked before the work is spent", () => {
		const { crowd, report, clock } = setup("public");
		const base = crowd.difficulty();
		const zulia = [BARALT, CABIMAS, MARACAIBO, "ve.zulia.colon"];
		let refused: SubmitOutcome | null = null;
		let n = 0;
		for (let i = 0; i < 300 && !refused; i++) {
			const out = report(ip(i), zulia[i % 4] as string, { luz: "no" });
			if (out.ok) n++;
			else refused = out;
		}
		expect(n).toBe(CROWD_RULES.load.perStatePerMinute);
		expect(refused).toMatchObject({ ok: false, status: 503, code: "busy" });
		// Caracas is not affected.
		expect(report(ip(400), "ve.distrito-capital.libertador", { luz: "no" }).ok).toBe(true);
		// 200 in a bucket is far from the load that raises the work.
		clock.now = bucketOf(clock.now) + CROWD_RULES.bucketMs;
		expect(crowd.difficulty()).toBe(base);
	});

	test("the work gets harder for the next bucket after a busy one, and never changes within a bucket", () => {
		const { crowd, report, clock } = setup("public");
		const oneEach = registry()
			.all.filter((e) => e.type === "state")
			.map(
				(st) =>
					registry()
						.within(st.id)
						.find((m) => m.type === "municipality")?.id,
			)
			.filter((id): id is string => id !== undefined);
		clock.now = bucketOf(T0);
		const base = crowd.difficulty();
		const busy = CROWD_RULES.pow.loadPerMinute * (CROWD_RULES.bucketMs / MIN) + 1;
		for (let i = 0; i < busy; i++) {
			clock.now += 400;
			expect(report(ip(i), oneEach[i % oneEach.length] as string, { luz: "si" }).ok).toBe(true);
			if (i % 500 === 0) expect(crowd.difficulty()).toBe(base);
		}
		clock.now = bucketOf(clock.now) + CROWD_RULES.bucketMs;
		expect(crowd.difficulty()).toBe(base + CROWD_RULES.pow.underLoadExtra);
		clock.now += CROWD_RULES.bucketMs;
		expect(crowd.difficulty()).toBe(base);
	});
	test("no proof of work, a wrong one, or a reused one: refused", () => {
		const { crowd } = setup("public");
		expect(crowd.submit({ municipality: BARALT, answers: { luz: "no" } }, ip(1))).toMatchObject({
			ok: false,
			code: "pow",
		});
		const c = crowd.challenge(ip(1));
		const ch = (c.ok ? c.challenge : {}) as { challenge: string; difficulty: number };
		const nonce = solve(ch.challenge, ch.difficulty)?.nonce ?? "";
		const body = { municipality: BARALT, answers: { luz: "no" }, challenge: ch.challenge, nonce };
		expect(crowd.submit(body, ip(1)).ok).toBe(true);
		expect(crowd.submit(body, ip(2))).toMatchObject({ ok: false, code: "pow" });
	});

	test("challenges are rate-limited per connection too", () => {
		const { crowd } = setup("public");
		const out = Array.from({ length: 14 }, () => crowd.challenge(ip(1)).ok);
		expect(out.filter(Boolean)).toHaveLength(CROWD_RULES.perClient.challengeBurst);
	});
});

describe("validation and the switch", () => {
	test("only a registry municipality, 1–4 known services with known answers, and no other fields", () => {
		const { report } = setup("public");
		const bad: [string, Record<string, string>][] = [
			["ve.zulia", { luz: "no" }], // a state
			["ve.zulia.nowhere", { luz: "no" }],
			[BARALT, {}],
			[BARALT, { electricidad: "no" }],
			[BARALT, { luz: "tal vez" }],
		];
		for (const [m, a] of bad) expect(report(ip(1), m, a)).toMatchObject({ ok: false, code: "invalid" });
		// A P-code names the same municipality (the page's place index carries P-codes); a state's does not.
		const byCode = report(ip(2), "VE2313", { luz: "no" });
		expect(byCode.ok && byCode.municipality).toEqual({ id: MARACAIBO, name: "Maracaibo", state: "VE-V" });
		expect(report(ip(2), "VE23", { luz: "no" })).toMatchObject({ ok: false, code: "invalid" });
		const { crowd } = setup("public");
		expect(
			crowd.submit({ municipality: BARALT, answers: { luz: "no" }, lat: 10.6, lon: -71.6 }, ip(1)),
		).toMatchObject({ ok: false, code: "invalid" });
	});

	test("off: nothing is taken", () => {
		const { crowd, store } = setup("public", false);
		expect(crowd.challenge(ip(1))).toMatchObject({ ok: false, status: 404, code: "off" });
		expect(crowd.submit({ municipality: BARALT, answers: { luz: "no" } }, ip(1))).toMatchObject({
			ok: false,
			code: "off",
		});
		expect(store.db.query("SELECT COUNT(*) AS n FROM crowd_counts").get()).toEqual({ n: 0 });
		expect((crowd.info() as { enabled: boolean }).enabled).toBe(false);
	});
});

describe("abuse-control memory", () => {
	test("the salt changes daily; yesterday's answer still updates within its window; then the old epoch is dropped", () => {
		const { crowd, report, clock } = setup("public");
		clock.now = T0 + DAY - 5 * MIN;
		const before = crowd.memory.fingerprint(ip(1));
		expect(statuses(report(ip(1), BARALT, { luz: "no" }))).toEqual(["counted"]);
		clock.now = T0 + DAY + 5 * MIN;
		const after = crowd.memory.fingerprint(ip(1));
		expect(after).not.toBe(before);
		expect(statuses(report(ip(1), BARALT, { luz: "si" }))).toEqual(["updated"]);
		clock.now += CROWD_RULES.windowMs + MIN;
		crowd.memory.tick();
		expect(crowd.memory.size.previous).toBe(0);
		crowd.memory.sweep();
		// The day's municipality list outlives the answers (it is the per-day limit), nothing more.
		expect(crowd.memory.size.current).toBe(1);
	});

	test("the rules text states the numbers in the code, per mode", () => {
		const { crowd } = setup("public");
		const info = crowd.info() as { rules: { es: string[]; en: string[] }; stored: { es: string[] } };
		const es = info.rules.es.join(" ");
		expect(es).toContain(
			`al menos ${CROWD_RULES.minReporters.public} reportes de al menos ${CROWD_RULES.minConnections.public} conexiones distintas`,
		);
		expect(es).toContain(`hasta ${CROWD_RULES.perClient.devicesPerPair} por municipio y servicio`);
		expect(es).toContain(`${CROWD_RULES.perClient.burst} envíos seguidos`);
		expect(es).toContain(`${CROWD_RULES.flood.floorPerHour} reportes`);
		expect(es).toContain(`${CROWD_RULES.flood.historyMultiplier} veces`);
		expect(info.rules.es).toHaveLength(info.rules.en.length);
		expect(info.stored.es.join(" ")).toContain("Nunca: dirección IP");
		const local = setup("local").crowd.info() as { rules: { es: string[] } };
		expect(local.rules.es.join(" ")).toContain("basta un reporte");
	});
});

describe("published values", () => {
	test("an aggregate says its window, thresholds and mode", () => {
		const { crowd, report, clock, store } = setup("public");
		for (let i = 0; i < 5; i++) report(ip(i), BARALT, { luz: "no" });
		clock.now += CROWD_RULES.bucketMs;
		crowd.snapshot();
		const row = store.latestPerSeries(CROWD_SOURCE, 0, 100).find((o) => o.series.startsWith("muni:"));
		const a = row?.value as unknown as CrowdAggregate;
		expect(row?.licence).toBe("cc0-vigia-crowd");
		expect(row?.basis).toBe("report");
		expect(row?.series).toBe(`muni:${BARALT}:luz:2026-09-28T12`);
		expect(a).toMatchObject({
			level: "municipality",
			state: "VE-V",
			reports: 5,
			held: 0,
			flagged: false,
			minReporters: 3,
			incidentMin: 5,
			mode: "public",
			windowMs: CROWD_RULES.windowMs,
			outage: { count: 5, firstAt: bucketOf(T0), lastAt: bucketOf(T0) + CROWD_RULES.bucketMs },
		});
	});
});

function crowdEntity(id: string) {
	const e = registry().get(id);
	if (!e) throw new Error(id);
	return e;
}

describe("per-device tokens (phones behind one carrier NAT address)", () => {
	const CARRIER = "200.44.10.7"; // one carrier NAT address

	test("phones behind one address count separately, up to 4 per municipality and service; the rest are not counted", () => {
		const { crowd, report, clock, muni } = setup("public");
		const out = Array.from({ length: 6 }, () => report(CARRIER, BARALT, { luz: "no" }, token()));
		expect(out.flatMap(statuses)).toEqual(["counted", "counted", "counted", "counted", "capped", "capped"]);
		clock.now += CROWD_RULES.bucketMs;
		crowd.snapshot();
		// One address alone is never a public figure, however many phones behind it.
		expect(muni(BARALT)).toBeUndefined();
		// One phone on another address: 5 reports from 2 connections, shown (without tokens: 2 reporters, hidden).
		report("190.202.1.9", BARALT, { luz: "no" });
		clock.now += CROWD_RULES.bucketMs;
		crowd.snapshot();
		const m = muni(BARALT);
		expect(m).toMatchObject({ reports: 5, connections: 2 });
		expect(m?.text.es).toBe("5 reportes de 2 conexiones en 2 h: 5 «no», 0 «intermitente», 0 «sí»");
		// 5 outage reports but from 2 connections: not incident evidence (needs 3).
		expect(m && crowdEvidence(m)).toBeNull();
	});

	test("the same phone again updates its answer; a changed answer too; neither adds a reporter", () => {
		const { crowd, report, muni } = setup("local");
		const t = token();
		expect(statuses(report(CARRIER, BARALT, { luz: "no" }, t))).toEqual(["counted"]);
		expect(statuses(report(CARRIER, BARALT, { luz: "no" }, t))).toEqual(["updated"]);
		expect(statuses(report(CARRIER, BARALT, { luz: "si" }, t))).toEqual(["updated"]);
		crowd.snapshot();
		expect(muni(BARALT)).toMatchObject({
			reports: 1,
			connections: 1,
			answers: { si: 1, no: 0, intermitente: 0 },
		});
	});

	test("a phone without a token and phones with tokens share the address's cap of 4", () => {
		const { report } = setup("public");
		expect(statuses(report(CARRIER, BARALT, { luz: "no" }))).toEqual(["counted"]);
		const out = Array.from({ length: 4 }, () => report(CARRIER, BARALT, { luz: "no" }, token()));
		expect(out.flatMap(statuses)).toEqual(["counted", "counted", "counted", "capped"]);
		// Another municipality or service has its own four.
		expect(statuses(report(CARRIER, BARALT, { agua: "no" }, token()))).toEqual(["counted"]);
	});

	test("minting tokens from one address raises no limit: submissions, municipalities and challenges stay per address", () => {
		const { report } = setup("public");
		const out = Array.from({ length: 12 }, (_, i) =>
			report(CARRIER, i % 2 ? BARALT : CABIMAS, { luz: "no" }, token()),
		);
		// 8 submissions at once, whatever the tokens (and at most 4 counted per municipality and service).
		expect(out.filter((o) => o.ok)).toHaveLength(CROWD_RULES.perClient.burst);
		expect(out.at(-1)).toMatchObject({ ok: false, code: "rate" });
		const munis = setup("public");
		const all = [
			BARALT,
			CABIMAS,
			MARACAIBO,
			"ve.zulia.colon",
			"ve.zulia.catatumbo",
			"ve.zulia.mara",
			"ve.zulia.sucre",
		];
		const byMuni = all.map((m) => munis.report(CARRIER, m, { luz: "no" }, token()));
		expect(byMuni.at(-1)).toMatchObject({ ok: false, code: "municipalities" });
		const challenges = setup("public");
		const got = Array.from({ length: 14 }, () => challenges.crowd.challenge(CARRIER).ok);
		expect(got.filter(Boolean)).toHaveLength(CROWD_RULES.perClient.challengeBurst);
	});

	test("an attacker needs as many addresses as before for incident evidence: 3 addresses × 4 tokens make it, 2 × 4 do not", () => {
		const two = setup("public");
		for (const a of ["200.44.10.7", "200.44.10.8"])
			for (let k = 0; k < 4; k++) two.report(a, BARALT, { luz: "no" }, token());
		two.clock.now += CROWD_RULES.bucketMs;
		two.crowd.snapshot();
		const m2 = two.muni(BARALT);
		expect(m2).toMatchObject({ reports: 8, connections: 2, outage: { count: 8, connections: 2 } });
		expect(m2 && crowdEvidence(m2)).toBeNull();
		const three = setup("public");
		for (const a of ["200.44.10.7", "200.44.10.8", "200.44.10.9"])
			for (let k = 0; k < 4; k++) three.report(a, BARALT, { luz: "no" }, token());
		three.clock.now += CROWD_RULES.bucketMs;
		three.crowd.snapshot();
		const m3 = three.muni(BARALT);
		expect(m3 && crowdEvidence(m3)?.family).toBe("usuarios");
	});

	test("a malformed token is refused, not ignored", () => {
		const { report } = setup("public");
		for (const bad of ["short", "x".repeat(23), "ñ".repeat(22), "a b".repeat(8)])
			expect(report(CARRIER, BARALT, { luz: "no" }, bad)).toMatchObject({ ok: false, code: "invalid" });
	});

	test("public mode: after reports with tokens, no table holds a token, a token fingerprint, an address or its fingerprint", () => {
		const { store, crowd, report, clock } = setup("public");
		const tokens = Array.from({ length: 4 }, () => token());
		const from = ["200.44.10.7", "2001:db8:1234:5678::1", "190.202.1.9"];
		for (const f of from)
			for (const t of tokens) report(f, BARALT, { luz: "no", internet: "intermitente" }, t);
		clock.now += CROWD_RULES.bucketMs;
		crowd.snapshot();
		const tables = store.db
			.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all()
			.map((t) => t.name);
		expect(tables).toContain("crowd_counts");
		const dump = tables.map((t) => JSON.stringify(store.db.query(`SELECT * FROM "${t}"`).all())).join("\n");
		expect(dump).toContain(BARALT); // the dump is real
		const needles = [
			...from,
			"200.44.10",
			"2001:db8",
			...tokens,
			...from.map((f) => crowd.memory.fingerprint(f)),
			...tokens.map((t) => crowd.memory.device(t)),
		];
		for (const needle of needles) expect(dump).not.toContain(needle);
		expect(dump).not.toContain(String(T0));
	});

	test("the device fingerprint changes with the daily salt; yesterday's phone still updates within its window", () => {
		const { crowd, report, clock } = setup("public");
		const t = token();
		clock.now = T0 + DAY - 5 * MIN;
		const before = crowd.memory.device(t);
		expect(statuses(report(CARRIER, BARALT, { luz: "no" }, t))).toEqual(["counted"]);
		clock.now = T0 + DAY + 5 * MIN;
		expect(crowd.memory.device(t)).not.toBe(before);
		expect(statuses(report(CARRIER, BARALT, { luz: "si" }, t))).toEqual(["updated"]);
		// A different phone on the same address is still another reporter.
		expect(statuses(report(CARRIER, BARALT, { luz: "si" }, token()))).toEqual(["counted"]);
	});

	test("the same token from another address is another reporter (a phone moving from Wi-Fi to data is not linked)", () => {
		const { report } = setup("public");
		const t = token();
		expect(statuses(report(CARRIER, BARALT, { luz: "no" }, t))).toEqual(["counted"]);
		expect(statuses(report("190.202.1.9", BARALT, { luz: "no" }, t))).toEqual(["counted"]);
	});
});
