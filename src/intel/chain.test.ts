import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { buildBundle, localArchive, resolveRef, verifyBundle } from "./bundle.ts";
import {
	chain,
	chainDigest,
	fieldsHash,
	GENESIS,
	merkleProof,
	merkleRoot,
	rootFromProof,
	sealDays,
	sha256,
	valueHash,
	verifyChain,
} from "./chain.ts";

const HOUR = 3_600_000;
const D1 = Date.UTC(2026, 8, 22, 10);
const D2 = Date.UTC(2026, 8, 23, 10);
const D3 = Date.UTC(2026, 8, 24, 10);

const obs = (series: string, at: number, value: number): Observation => ({
	source: "demo",
	series,
	sourceUrl: `https://example.org/${series}`,
	fetchedAt: at,
	observedAt: at - HOUR,
	licence: "demo",
	value: { v: value },
	confidence: 1,
	basis: "measurement",
	location: { lat: 10.5, lon: -66.9, state: "VE-A", place: "Caracas" },
});

function seeded(): Store {
	const store = new Store(":memory:");
	store.insert([obs("a", D1, 1), obs("b", D1 + HOUR, 2), obs("a", D2, 3), obs("c", D3, 4), obs("d", D3, 5)]);
	return store;
}

test("Merkle: every leaf proves to the root, for odd and even sizes; a wrong leaf does not", () => {
	for (const n of [1, 2, 3, 5, 8, 13]) {
		const hashes = Array.from({ length: n }, (_, i) => sha256(`row ${i}`));
		const root = merkleRoot(hashes);
		for (const h of hashes) {
			const proof = merkleProof(hashes, h);
			expect(proof).not.toBeNull();
			expect(rootFromProof(h, proof ?? [])).toBe(root);
		}
		expect(merkleProof(hashes, sha256("other"))).toBeNull();
		expect(rootFromProof(sha256("other"), merkleProof(hashes, hashes[0] as string) ?? [])).not.toBe(root);
	}
	// Order does not matter (leaves are sorted); a pinned vector guards the format.
	expect(merkleRoot(["b".repeat(64), "a".repeat(64)])).toBe(merkleRoot(["a".repeat(64), "b".repeat(64)]));
	expect(chainDigest(GENESIS, "2026-09-22", 2, "a".repeat(64))).toBe(
		sha256(`vigia-chain/2\n${GENESIS}\n2026-09-22\n2\n${"a".repeat(64)}`),
	);
	expect(chainDigest(GENESIS, "2026-09-22", 2, "a".repeat(64), "vigia-chain/1")).toBe(
		sha256(`vigia-chain/1\n${GENESIS}\n2026-09-22\n2\n${"a".repeat(64)}`),
	);
});

test("sealing: closed days only, in order, each chained to the one before; idempotent", () => {
	const store = seeded();
	// D3 closes at 25 Sept 00:00 UTC and is sealed an hour later.
	const sealed = sealDays(store, Date.UTC(2026, 8, 25, 0, 30));
	expect(sealed.map((e) => [e.day, e.rows])).toEqual([
		["2026-09-22", 2],
		["2026-09-23", 1],
	]);
	expect(sealed[0]?.prev).toBe(GENESIS);
	expect(sealed[1]?.prev).toBe(sealed[0]?.digest);
	expect(sealDays(store, Date.UTC(2026, 8, 25, 0, 30))).toEqual([]);
	const later = sealDays(store, Date.UTC(2026, 8, 25, 2));
	expect(later.map((e) => e.day)).toEqual(["2026-09-24"]);
	expect(later[0]?.prev).toBe(sealed[1]?.digest);
	expect(verifyChain(store).every((d) => d.ok)).toBe(true);
});

test("verify: an edited, deleted or added row breaks its day; a rewritten digest breaks the chain", () => {
	const store = seeded();
	sealDays(store, Date.UTC(2026, 8, 26));
	store.db.run(`UPDATE obs SET value = '{"v":99}' WHERE series = 'a' AND fetched_at = ?`, [D2]);
	let report = verifyChain(store);
	expect(report.map((d) => d.ok)).toEqual([true, false, true]);
	expect(report[1]?.problem).toBe("hay filas modificadas desde que se selló");

	const s2 = seeded();
	sealDays(s2, Date.UTC(2026, 8, 26));
	s2.db.run("DELETE FROM obs WHERE series = 'b'");
	report = verifyChain(s2);
	expect(report[0]?.problem).toContain("faltan 1 filas");

	const s3 = seeded();
	sealDays(s3, Date.UTC(2026, 8, 26));
	s3.db.run("UPDATE chain SET digest = ? WHERE day = '2026-09-23'", ["f".repeat(64)]);
	report = verifyChain(s3);
	expect(report[1]?.problem).toContain("alterada");
	expect(report[2]?.problem).toContain("enlace");
});

test("an evidence bundle proves its rows offline, and any edit to the file is caught", () => {
	const store = seeded();
	sealDays(store, Date.UTC(2026, 8, 24, 2));
	const now = Date.UTC(2026, 8, 24, 12);
	const rows = [
		resolveRef(store, { source: "demo", series: "a", observedAt: null }, now),
		resolveRef(store, { source: "demo", series: "c", observedAt: D3 - HOUR }, now),
	].filter((r) => r !== null);
	expect(rows.map((r) => r.value)).toEqual([{ v: 3 }, { v: 4 }]);
	const bundle = buildBundle(
		store,
		{
			subject: { kind: "incident", id: "x", title: "Prueba" },
			rows,
			snapshot: { any: "thing" },
			rules: { es: ["regla"], en: ["rule"] },
			generator: "Vigía test",
		},
		now,
	);
	expect(bundle.chain.entries.map((e) => e.day)).toEqual(["2026-09-23"]);
	expect(bundle.chain.unsealedDays).toEqual(["2026-09-24"]);
	// Round trip through a file.
	const file = JSON.parse(JSON.stringify(bundle)) as unknown;
	const report = verifyBundle(file, localArchive(store));
	expect(report).toMatchObject({ ok: true, fileHashOk: true, total: 2, proven: 1, anchored: 1, unproven: 1 });
	expect(report.local).toEqual([
		{ day: "2026-09-23", status: "same" },
		{ day: "2026-09-24", status: "absent" },
	]);
	expect(verifyBundle(file).local.map((l) => l.status)).toEqual(["unchecked", "unchecked"]);

	// Changing a value: the row's own hash no longer matches, and neither does the file's.
	const edited = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
	(edited.observations[0] as { value: unknown }).value = { v: 4 };
	const bad = verifyBundle(edited);
	expect(bad.ok).toBe(false);
	expect(bad.fileHashOk).toBe(false);
	expect(bad.problems.some((p) => p.includes("modificado"))).toBe(true);

	// Rewriting the row and its hash: the proof no longer reaches the sealed root.
	const forged = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
	const o = forged.observations[0];
	if (!o) throw new Error("no row");
	o.value = { v: 4 };
	o.valueHash = valueHash(o.value);
	const { day: _d, rowHash: _h, proof: _p, value: _v, ...fields } = o;
	o.rowHash = fieldsHash(fields);
	const forgedReport = verifyBundle(forged);
	expect(forgedReport.ok).toBe(false);

	// A different archive on this machine disagrees.
	const other = seeded();
	other.insert([obs("z", D2, 9)]);
	sealDays(other, Date.UTC(2026, 8, 24, 2));
	expect(verifyBundle(file, localArchive(other)).local).toEqual([
		{ day: "2026-09-23", status: "different" },
		{ day: "2026-09-24", status: "absent" },
	]);
	expect(chain(other).length).toBe(2);
});

test("not a bundle", () => {
	expect(verifyBundle({ hello: 1 }).problems[0]).toContain("no es un archivo de evidencia");
});

test("rows under a no-redistribution licence never enter a bundle", () => {
	const store = new Store(":memory:");
	store.insert([{ ...obs("r", D1, 1), source: "ripestat-routing", licence: "ripestat-no-redistribution" }]);
	const row = resolveRef(store, { source: "ripestat-routing", series: "r", observedAt: null }, D2);
	expect(row).not.toBeNull();
	const bundle = buildBundle(
		store,
		{
			subject: { kind: "panel", id: "connectivity", title: "x" },
			rows: row ? [row] : [],
			snapshot: null,
			rules: { es: [], en: [] },
			generator: "t",
		},
		D2,
	);
	expect(bundle.observations).toEqual([]);
});

test("values under a display-only licence are withheld: hash and proof only; the CLI says when nothing anchors", async () => {
	const store = new Store(":memory:");
	store.insert([
		{ ...obs("i", D1, 1), source: "ioda-states", licence: "ioda-all-rights-reserved" },
		obs("a", D1, 2),
	]);
	sealDays(store, Date.UTC(2026, 8, 24));
	const rows = ["i", "a"]
		.map((series) =>
			resolveRef(store, { source: series === "i" ? "ioda-states" : "demo", series, observedAt: null }, D2),
		)
		.filter((r) => r !== null);
	const bundle = buildBundle(
		store,
		{
			subject: { kind: "panel", id: "p", title: "p" },
			rows,
			snapshot: null,
			rules: { es: [], en: [] },
			generator: "t",
		},
		D2,
	);
	const ioda = bundle.observations.find((o) => o.source === "ioda-states");
	expect(ioda?.value).toBeNull();
	expect(ioda?.withheld).toBe("licence");
	const report = verifyBundle(JSON.parse(JSON.stringify(bundle)), localArchive(store));
	expect(report).toMatchObject({ ok: true, total: 2, proven: 2, withheld: 1, anchored: 2 });

	// Without a local archive the CLI never says "íntegra": exit code 2 and the digests to compare.
	const { verifyFile } = await import("./commands.ts");
	const path = join(import.meta.dir, "..", "..", "runs", "tmp", `vigia-bundle-${process.pid}.json`);
	mkdirSync(dirname(path), { recursive: true });
	await Bun.write(path, JSON.stringify(bundle));
	const lines: string[] = [];
	expect(verifyFile(path, null, (l) => lines.push(l))).toBe(2);
	expect(lines.join("\n")).toContain("NO comprobada");
	expect(lines.join("\n")).not.toContain("La evidencia es íntegra");
	const anchoredLines: string[] = [];
	expect(verifyFile(path, store, (l) => anchoredLines.push(l))).toBe(0);
	rmSync(path);
});

test("a deleted row does not stop the rest of its sealed day being proven (the day's row hashes are kept)", () => {
	const store = seeded();
	sealDays(store, Date.UTC(2026, 8, 24, 2));
	store.db.run("DELETE FROM obs WHERE series = 'b'");
	const row = resolveRef(store, { source: "demo", series: "a", observedAt: D1 - HOUR }, D3);
	const make = () =>
		buildBundle(
			store,
			{
				subject: { kind: "panel", id: "p", title: "p" },
				rows: row ? [row] : [],
				snapshot: null,
				rules: { es: [], en: [] },
				generator: "t",
			},
			D3,
		);
	const bundle = make();
	expect(bundle.chain.changedDays).toEqual([]);
	expect(bundle.observations[0]?.proof).not.toBeNull();
	expect(verifyBundle(JSON.parse(JSON.stringify(bundle)), localArchive(store))).toMatchObject({
		ok: true,
		anchored: 1,
	});
	// A row edited in the database after sealing is not in the seal: no proof, and the day is listed as changed.
	store.db.run(`UPDATE obs SET value = '{"v":99}' WHERE series = 'a' AND fetched_at = ?`, [D1]);
	const edited = resolveRef(store, { source: "demo", series: "a", observedAt: D1 - HOUR }, D3);
	const again = buildBundle(
		store,
		{
			subject: { kind: "panel", id: "p", title: "p" },
			rows: edited ? [edited] : [],
			snapshot: null,
			rules: { es: [], en: [] },
			generator: "t",
		},
		D3,
	);
	expect(again.chain.changedDays).toEqual(["2026-09-22"]);
	expect(again.observations[0]?.proof).toBeNull();
	// And this machine's archive says the edited row is not what it sealed.
	expect(verifyBundle(JSON.parse(JSON.stringify(again)), localArchive(store)).ok).toBe(false);
});
