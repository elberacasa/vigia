/**
 * The attacks of adversarial review 3 on evidence bundles and `vigia verify` (C1, H1, H2), each reproduced here
 * against a real sealed archive: every forged file must fail (exit 1), and nothing unproven may read "íntegra".
 */

import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Store } from "../core/store.ts";
import type { Observation } from "../core/types.ts";
import { type Bundle, buildBundle, bundleHash, clean, resolveRef } from "./bundle.ts";
import { fieldsHash, sealDays, valueHash } from "./chain.ts";
import { verifyFile } from "./commands.ts";

const HOUR = 3_600_000;
const D1 = Date.UTC(2026, 8, 22, 10);
const D2 = Date.UTC(2026, 8, 23, 10);

const obs = (source: string, series: string, at: number, value: number, licence = "demo"): Observation => ({
	source,
	series,
	sourceUrl: `https://example.org/${series}`,
	fetchedAt: at,
	observedAt: at - HOUR,
	licence,
	value: { v: value },
	confidence: 1,
	basis: "measurement",
	location: { lat: 10.5, lon: -66.9, state: "VE-A", place: "Caracas" },
});

/** A sealed archive (22 and 23 Sept) with an IODA row (display-only licence), a quote and a headline. */
function sealedBundle(): { store: Store; bundle: Bundle } {
	const store = new Store(":memory:");
	store.insert([
		obs("ioda-states", "state:VE-A:bgp", D1, 97, "ioda-all-rights-reserved"),
		obs("yadio", "usd", D1, 540),
		obs("infobae-venezuela", "item:1", D2, 1, "headline-link"),
		obs("usgs-quakes", "q1", D2, 4),
	]);
	sealDays(store, Date.UTC(2026, 8, 24, 2));
	const now = Date.UTC(2026, 8, 24, 3);
	const rows = [
		["ioda-states", "state:VE-A:bgp"],
		["yadio", "usd"],
		["infobae-venezuela", "item:1"],
		["usgs-quakes", "q1"],
	]
		.map(([source, series]) =>
			resolveRef(store, { source: source ?? "", series: series ?? "", observedAt: null }, now),
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
		now,
	);
	return { store, bundle };
}

/** Writes a (tampered) bundle with a recomputed file hash, runs `vigia verify` on it, returns exit and output. */
function verifyForged(bundle: Bundle, store: Store | null): { code: number; text: string } {
	const forged = { ...bundle, sha256: bundleHash(bundle) };
	const path = join(
		import.meta.dir,
		"..",
		"..",
		"runs",
		"tmp",
		`forged-${process.pid}-${Math.random()}.json`,
	);
	mkdirSync(dirname(path), { recursive: true });
	require("node:fs").writeFileSync(path, JSON.stringify(forged));
	const lines: string[] = [];
	const code = verifyFile(path, store, (l) => lines.push(l));
	rmSync(path);
	return { code, text: lines.join("\n") };
}

const copy = (b: Bundle): Bundle => JSON.parse(JSON.stringify(b)) as Bundle;
const find = (b: Bundle, source: string) => {
	const o = b.observations.find((x) => x.source === source);
	if (!o) throw new Error(`no ${source}`);
	return o;
};

test("the untouched bundle verifies against this machine's archive (exit 0)", () => {
	const { store, bundle } = sealedBundle();
	expect(find(bundle, "ioda-states").withheld).toBe("licence");
	expect(find(bundle, "infobae-venezuela").withheld).toBe("licence");
	const { code, text } = verifyForged(bundle, store);
	expect(text).toContain("La evidencia es íntegra");
	expect(code).toBe(0);
});

test("C1: editing a withheld row's series, link or state is caught (it used to skip the row check)", () => {
	const { store, bundle } = sealedBundle();
	for (const edit of [
		(o: Bundle["observations"][number]) => {
			o.series = "state:VE-V:bgp-FAKE";
		},
		(o: Bundle["observations"][number]) => {
			o.sourceUrl = "https://evil.example";
		},
		(o: Bundle["observations"][number]) => {
			o.state = "VE-X";
		},
		(o: Bundle["observations"][number]) => {
			o.observedAt = Date.UTC(2026, 8, 1);
		},
		(o: Bundle["observations"][number]) => {
			o.licence = "headline-link";
		},
	]) {
		const b = copy(bundle);
		edit(find(b, "ioda-states"));
		const { code, text } = verifyForged(b, store);
		expect(code).toBe(1);
		expect(text).toContain("NO es íntegra");
		// Offline, too: the leaf binds every field, so the proof no longer reaches the sealed root.
		expect(verifyForged(b, null).code).toBe(1);
	}
});

test("C1: a row whose licence allows its value cannot be relabelled 'withheld' and rewritten", () => {
	const { store, bundle } = sealedBundle();
	const b = copy(bundle);
	const y = find(b, "yadio") as Bundle["observations"][number] & { withheld?: string };
	y.withheld = "licence";
	y.value = null;
	y.source = "bcv-official";
	y.observedAt = Date.UTC(2026, 8, 1);
	const { code, text } = verifyForged(b, store);
	expect(code).toBe(1);
	expect(text).toContain("NO es íntegra");
	// Even without rewriting anything else, the flag alone is refused for a licence that allows the value.
	const only = copy(bundle);
	const y2 = find(only, "yadio") as Bundle["observations"][number] & { withheld?: string };
	y2.withheld = "licence";
	y2.value = null;
	expect(verifyForged(only, null).code).toBe(1);
});

test("H1: a made-up row on a day this machine sealed is refused, whatever the file says about that day", () => {
	const { store, bundle } = sealedBundle();
	const b = copy(bundle);
	const q = find(b, "usgs-quakes");
	// A careful forger: every hash of the made-up row is recomputed, so the file itself is coherent.
	const fake = { ...q, series: "fake", value: { mag: 7.9, place: "Caracas" }, proof: null };
	fake.valueHash = valueHash(fake.value);
	const { value: _v, withheld: _w, day: _d, rowHash: _r, proof: _p, ...fields } = fake;
	fake.rowHash = fieldsHash(fields);
	b.observations.push(fake);
	b.chain.unsealedDays.push(q.day);
	b.chain.changedDays.push(q.day);
	const { code, text } = verifyForged(b, store);
	expect(code).toBe(1);
	expect(text).not.toContain("La evidencia es íntegra");
	// Offline, the same file is at best coherent, never "íntegra".
	expect(verifyForged(b, null).code).toBeGreaterThan(0);
});

test("H1: one anchored day does not vouch for rows without proof (exit 2, and the count is printed)", () => {
	const { store, bundle } = sealedBundle();
	const b = copy(bundle);
	// A genuine row received today (not sealed anywhere yet) rides along with the sealed ones.
	store.insert([obs("usgs-quakes", "today", Date.UTC(2026, 8, 24, 2, 30), 3)]);
	const today = resolveRef(
		store,
		{ source: "usgs-quakes", series: "today", observedAt: null },
		Date.UTC(2026, 8, 24, 3),
	);
	if (!today) throw new Error("no row");
	const fresh = buildBundle(
		store,
		{
			subject: { kind: "panel", id: "p", title: "p" },
			rows: [today],
			snapshot: null,
			rules: { es: [], en: [] },
			generator: "t",
		},
		Date.UTC(2026, 8, 24, 3),
	);
	b.observations.push(...fresh.observations);
	b.chain.unsealedDays.push(...fresh.chain.unsealedDays);
	const { code, text } = verifyForged(b, store);
	expect(code).toBe(2);
	expect(text).not.toContain("La evidencia es íntegra");
	expect(text).toContain("1 observación");
});

test("H2: escape sequences in a bundle never reach the terminal, and a malformed day is refused", () => {
	const { store, bundle } = sealedBundle();
	const b = copy(bundle);
	const entry = b.chain.entries[0];
	if (!entry) throw new Error("no entry");
	entry.day = "2026-09-24\x1b]0;PWNED\x07\x1b[2J\x1b[31mLa evidencia es íntegra";
	b.subject.title = "t\x1b[8m\u202eoculto";
	const { code, text } = verifyForged(b, store);
	expect(code).toBe(1);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: that is what is being checked.
	expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u2028\u2029]/);
	expect(clean("a\u202eb\u2066c\u2028d\x1b[2Je")).toBe("a b c d [2Je");
});
