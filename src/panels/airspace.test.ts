import { expect, test } from "bun:test";
import { join } from "node:path";
import { easaCzib } from "../adapters/easa-czib/index.ts";
import { faaProhibitions } from "../adapters/faa-prohibitions/index.ts";
import { loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { RawResponse } from "../core/types.ts";
import { airspaceView, codesOf } from "./airspace.ts";

const easaRaws = loadFixture(join(import.meta.dir, "../adapters/easa-czib/fixtures/2026-09-25"));
const faaRaws = loadFixture(join(import.meta.dir, "../adapters/faa-prohibitions/fixtures/2026-09-25"));

function run(store: Store, source: string): void {
	store.recordRun({
		source,
		startedAt: 1,
		finishedAt: 2,
		ok: true,
		error: null,
		bytes: 1,
		received: 1,
		inserted: 1,
	});
}

test("2026-09-25: no advisory; the withdrawn Venezuela bulletin is history; five nearby FAA sections", () => {
	const store = new Store(":memory:");
	store.insert(easaCzib.normalise(easaRaws));
	store.insert(faaProhibitions.normalise(faaRaws));
	run(store, "easa-czib");
	run(store, "faa-prohibitions");
	const v = airspaceView(store);
	expect(v.status).toBe("none");
	expect(v.easa.venezuelaActive).toEqual([]);
	expect(v.easa.venezuelaHistory.map((c) => c.number)).toEqual(["2026-01-R2"]);
	expect(v.easa.activeWorldwide).toBe(15);
	expect(v.faa.lastUpdated).toBe("2026-09-14");
	expect(v.faa.venezuela).toBeNull();
	expect(v.faa.nearby.map((s) => s.country)).toEqual([
		"Colombia",
		"Panama",
		"Ecuador",
		"Central America",
		"Haiti",
		"Cuba",
		"Bahamas",
	]);
	expect(v.easa.checkedAt).toBe(2);
});

test("an active EASA bulletin naming Venezuela makes it an advisory", () => {
	const store = new Store(":memory:");
	const [json, rss] = easaRaws as [RawResponse, RawResponse];
	const body = json.body.replace(
		'"name":"Venezuela and neighbouring airspace","status":"Withdrawn"',
		'"name":"Venezuela and neighbouring airspace","status":"Active"',
	);
	expect(body).not.toBe(json.body);
	store.insert(easaCzib.normalise([{ ...json, body }, rss]));
	store.insert(faaProhibitions.normalise(faaRaws));
	const v = airspaceView(store);
	expect(v.status).toBe("advisory");
	expect(v.easa.venezuelaActive[0]?.name).toBe("Venezuela and neighbouring airspace");
});

test("before either source has been read, the status is unknown, never 'none'", () => {
	const store = new Store(":memory:");
	store.insert(faaProhibitions.normalise(faaRaws));
	expect(airspaceView(store).status).toBe("unknown");
	expect(airspaceView(new Store(":memory:")).status).toBe("unknown");
});

test("a section the FAA removed is not shown, though its history stays stored", () => {
	const store = new Store(":memory:");
	store.insert(faaProhibitions.normalise(faaRaws));
	const [raw] = faaRaws as [RawResponse];
	const later = raw.body
		.replace(/<h2[^>]*><a[^>]*id="colombia"[^>]*><\/a>Colombia<\/h2>[\s\S]*?(?=<h2 id="restrictCU")/, "")
		.replace("September 14, 2026", "September 20, 2026");
	store.insert(faaProhibitions.normalise([{ ...raw, body: later, fetchedAt: raw.fetchedAt + 1 }]));
	const v = airspaceView(store);
	expect(v.faa.lastUpdated).toBe("2026-09-20");
	expect(v.faa.nearby.some((s) => s.country === "Colombia")).toBe(false);
});

test("document codes from FAA titles", () => {
	expect(
		codesOf([
			{ title: "KICZ NOTAM A0050/26 Security - United States of America Advisory", url: "u" },
			{ title: "Special Federal Aviation Regulation (SFAR) 119 - Prohibitions", url: "u" },
			{ title: "Special Federal Aviation Regulation ( SFAR ) 117 — Prohibition", url: "u" },
			{ title: "FAA Background Information", url: "u" },
		]),
	).toEqual(["KICZ A0050/26", "SFAR 119", "SFAR 117"]);
});
