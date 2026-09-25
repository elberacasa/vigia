/**
 * Keeping the chain over time (review 3, M4 and M5): a retention period never breaks it, sealing never blocks the
 * server, and days sealed with the first format keep verifying after the upgrade.
 */

import { expect, test } from "bun:test";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { buildBundle, localArchive, resolveRef, verifyBundle } from "./bundle.ts";
import {
	CHAIN_FORMAT,
	CHAIN_FORMAT_V1,
	chain,
	chainDigest,
	dayRows,
	GENESIS,
	merkleRoot,
	pruneObservations,
	rowHash,
	sealDays,
	sealInBackground,
	verifyChain,
} from "./chain.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const D1 = Date.UTC(2026, 8, 1, 10);

const obs = (series: string, at: number, value: number, licence = "demo", source = "demo"): Observation => ({
	source,
	series,
	sourceUrl: `https://example.org/${series}`,
	fetchedAt: at,
	observedAt: at - HOUR,
	licence,
	value: { v: value },
	confidence: 1,
	basis: "measurement",
});

test("M4: retention deletes old rows of sealed days and the chain still verifies (it used to say 'faltan filas')", () => {
	const store = new Store(":memory:");
	// Three rows a day for 40 days, then seal everything.
	const rows: Observation[] = [];
	for (let d = 0; d < 40; d++)
		for (const s of ["a", "b", "c"]) rows.push(obs(s, D1 + d * DAY, d * 10 + s.charCodeAt(0)));
	store.insert(rows);
	const now = D1 + 41 * DAY;
	sealDays(store, now);
	expect(chain(store)).toHaveLength(40);
	expect(verifyChain(store).every((d) => d.ok)).toBe(true);

	// Retention: everything observed and received before day 35 goes (but the newest row of each series).
	const deleted = pruneObservations(store, D1 + 35 * DAY, now);
	expect(deleted).toBe(35 * 3);
	const report = verifyChain(store);
	expect(report.filter((d) => !d.ok)).toEqual([]);
	expect(report.slice(0, 35).every((d) => d.pruned === 3 && d.rowsNow === 0)).toBe(true);

	// The rows that remain are still proven, from the day's kept hashes.
	const row = resolveRef(store, { source: "demo", series: "a", observedAt: null }, now);
	if (!row) throw new Error("no row");
	const bundle = buildBundle(
		store,
		{
			subject: { kind: "panel", id: "p", title: "p" },
			rows: [row],
			snapshot: null,
			rules: { es: [], en: [] },
			generator: "t",
		},
		now,
	);
	expect(bundle.observations[0]?.proof).not.toBeNull();
	expect(verifyBundle(JSON.parse(JSON.stringify(bundle)), localArchive(store))).toMatchObject({
		ok: true,
		anchored: 1,
	});

	// A row deleted by anything but the retention is still caught.
	store.db.run("DELETE FROM obs WHERE series = 'b' AND fetched_at = ?", [D1 + 36 * DAY]);
	const after = verifyChain(store);
	expect(after[36]?.ok).toBe(false);
	expect(after[36]?.problem).toContain("no las borró la retención");
});

test("M4: rows backfilled today with old observed times are kept by the retention (received recently)", () => {
	const store = new Store(":memory:");
	const now = D1 + 60 * DAY;
	store.insert([
		{ ...obs("h", now - HOUR, 1), observedAt: D1 - 400 * DAY },
		{ ...obs("h2", now - HOUR, 2), observedAt: D1 - 401 * DAY },
	]);
	expect(pruneObservations(store, now - 35 * DAY, now)).toBe(0);
});

test("M5: sealing in the background yields to the event loop and seals the same chain as the synchronous path", async () => {
	const make = () => {
		const store = new Store(":memory:");
		const rows: Observation[] = [];
		for (let d = 0; d < 3; d++) for (let i = 0; i < 6_000; i++) rows.push(obs(`s${i}`, D1 + d * DAY + i, i));
		store.insert(rows);
		return store;
	};
	const now = D1 + 4 * DAY;
	const sync = sealDays(make(), now);

	const store = make();
	let ticks = 0;
	const timer = setInterval(() => ticks++, 0);
	const background = await sealInBackground(store, now, { sliceMs: 2 });
	clearInterval(timer);
	expect(ticks).toBeGreaterThan(3);
	expect(background.map((e) => e.digest)).toEqual(sync.map((e) => e.digest));
	expect(verifyChain(store).every((d) => d.ok)).toBe(true);

	// Stopping the server mid-seal leaves only whole days sealed, and the next run finishes the job.
	const stopped = make();
	const abort = new AbortController();
	const pending = sealInBackground(stopped, now, { sliceMs: 1, signal: abort.signal });
	await new Promise((r) => setTimeout(r, 5));
	abort.abort();
	await expect(pending).rejects.toBeDefined();
	expect(verifyChain(stopped).every((d) => d.ok)).toBe(true);
	await sealInBackground(stopped, now);
	expect(chain(stopped).map((e) => e.digest)).toEqual(sync.map((e) => e.digest));
});

test("days sealed with format 1 keep verifying after the upgrade; new days chain on with format 2", () => {
	const store = new Store(":memory:");
	store.insert([
		obs("a", D1, 1),
		obs("i", D1, 2, "ioda-all-rights-reserved", "ioda-states"),
		obs("b", D1 + DAY, 3),
		obs("c", D1 + 2 * DAY, 4),
	]);
	// The chain as the first release wrote it: its old table, format-1 row hashes, format-1 digests.
	store.db.run(`CREATE TABLE chain (
		day TEXT PRIMARY KEY, rows INTEGER NOT NULL, root TEXT NOT NULL, prev TEXT NOT NULL,
		digest TEXT NOT NULL, sealed_at INTEGER NOT NULL
	)`);
	let prev = GENESIS;
	for (const day of ["2026-09-01", "2026-09-02"]) {
		const hashes = dayRows(store, day).map((r) => rowHash(r, CHAIN_FORMAT_V1));
		const root = merkleRoot(hashes);
		const digest = chainDigest(prev, day, hashes.length, root, CHAIN_FORMAT_V1);
		store.db.run("INSERT INTO chain VALUES (?, ?, ?, ?, ?, ?)", [day, hashes.length, root, prev, digest, 0]);
		prev = digest;
	}
	const now = D1 + 3 * DAY;
	const added = sealDays(store, now);
	expect(added.map((e) => [e.day, e.format, e.prev])).toEqual([["2026-09-03", CHAIN_FORMAT, prev]]);
	expect(chain(store).map((e) => e.format)).toEqual([CHAIN_FORMAT_V1, CHAIN_FORMAT_V1, CHAIN_FORMAT]);
	expect(verifyChain(store).every((d) => d.ok)).toBe(true);

	// A format-1 day: the open row is proven; the withheld one cannot be bound without its value, so it is
	// "not checked" (exit 2), never proven and never a failure.
	const rows = [
		resolveRef(store, { source: "demo", series: "a", observedAt: null }, now),
		resolveRef(store, { source: "ioda-states", series: "i", observedAt: null }, now),
	].filter((r) => r !== null);
	const bundle = buildBundle(
		store,
		{
			subject: { kind: "panel", id: "p", title: "p" },
			rows,
			snapshot: null,
			rules: { es: [], en: [] },
			generator: "t",
		},
		now,
	);
	const report = verifyBundle(JSON.parse(JSON.stringify(bundle)), localArchive(store));
	expect(report).toMatchObject({ ok: true, total: 2, proven: 1, anchored: 1, unproven: 1, withheld: 1 });
});
