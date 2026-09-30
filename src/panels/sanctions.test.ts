import { expect, test } from "bun:test";
import { join } from "node:path";
import { federalRegister } from "../adapters/federal-register/index.ts";
import { ofacSdn } from "../adapters/ofac-sdn/index.ts";
import { type GeneralLicence, ofacVenezuela } from "../adapters/ofac-venezuela/index.ts";
import { hasFixture, loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import type { Adapter } from "../core/types.ts";
import { type ChangeRow, licenceList, removedIds, sanctionsView, tally } from "./sanctions.ts";

const DAY = 86_400_000;
const fixture = (a: Adapter) => join(import.meta.dir, "..", "adapters", a.id, "fixtures", "2026-09-28");
const adapters: readonly Adapter[] = [ofacSdn, ofacVenezuela, federalRegister];
// The SDN and Federal Register recordings are internal (see their tests); the end-to-end run needs them.
const recorded = adapters.every((a) => hasFixture(fixture(a)));

test.skipIf(!recorded)("end to end on the recordings of 2026-09-28", () => {
	const store = new Store(":memory:");
	for (const a of adapters) store.insert(a.normalise(loadFixture(fixture(a))));
	const started = performance.now();
	const v = sanctionsView(store, Date.parse("2026-09-29T02:30:00Z"));
	expect(performance.now() - started).toBeLessThan(300);

	expect(v.sdn.asOf?.publicationId).toBe(984);
	expect(v.sdn.publicationsBehind).toBe(0);
	expect(v.sdn.counts).toEqual({ total: 409, individuals: 190, entities: 104, vessels: 60, aircraft: 55 });
	expect(v.sdn.byProgram[0]).toEqual({ program: "VENEZUELA-EO13850", n: 176 });
	expect(v.sdn.officials.length).toBe(88);
	expect(v.sdn.unnamedIndividuals).toBe(102);
	expect(v.sdn.officials[0]?.url).toStartWith("https://sanctionssearch.ofac.treas.gov/Details.aspx?id=");
	// The recording's changes on the Venezuela programmes: 1 addition (Aug), 5 removals (Mar ×2, Apr, May ×2).
	// (Publication 845 of 14 Apr, one more removal, is not in the recording.)
	expect(v.sdn.tally.days365).toEqual({ add: 1, remove: 5, update: 0 });
	expect(v.sdn.tally.days30).toEqual({ add: 0, remove: 0, update: 0 });
	expect(v.sdn.changes[0]).toMatchObject({ publicationId: 959, action: "add" });
	expect(v.sdn.publicationsRead).toBe(7);

	expect(v.licences.list.length).toBe(43);
	expect(v.licences.list.slice(0, 3).map((l) => l.id)).toEqual(["46E", "48D", "49B"]);
	expect(v.licences.recentCount).toBe(v.licences.list.filter((l) => l.issued >= "2026-08-30").length);
	expect(v.licences.removed).toEqual([]);
	expect(v.licences.actions[0]?.title).toBe("Issuance of Amended Venezuela General Licenses");

	expect(v.register.documents[0]?.number).toBe("2026-19422");
	expect(v.register.documents.every((d) => d.relevance !== "text" && d.title !== null)).toBe(true);
	expect(v.register.bodyOnly30d).toBeGreaterThan(0);
});

const change = (at: number, action: ChangeRow["action"]): ChangeRow => ({
	at,
	publicationId: 1,
	action,
	subject: { type: "individual", named: false },
	programs: ["VENEZUELA"],
	listedOn: null,
	url: "https://ofac.treasury.gov/recent-actions/20260101",
});

test("tally counts actions since a time", () => {
	const rows = [
		change(10 * DAY, "add"),
		change(9 * DAY, "remove"),
		change(2 * DAY, "remove"),
		change(DAY, "update"),
	];
	expect(tally(rows, 5 * DAY)).toEqual({ add: 1, remove: 1, update: 0 });
	expect(tally(rows, 0)).toEqual({ add: 1, remove: 2, update: 1 });
});

test("a licence replaced by its next revision is amended, not removed", () => {
	expect(removedIds(["5Y", "8L", "41"], ["5Z", "41"])).toEqual(["8L"]);
	expect(removedIds(null, ["5Z"])).toEqual([]);
});

const gl = (id: string, issued: string): { observedAt: number; value: GeneralLicence } => ({
	observedAt: Date.parse(`${issued}T04:00:00Z`),
	value: {
		kind: "licence",
		id,
		number: /^\d+/.exec(id)?.[0] ?? id,
		revision: id.replace(/^\d+/, ""),
		title: "Authorizing invented things",
		issued,
		url: `https://ofac.treasury.gov/media/${id}`,
	},
});

test("licence list: the newest revision per number, newest first, recent within 30 days, only what the page shows", () => {
	const now = Date.parse("2026-09-29T00:00:00Z");
	const rows = [
		gl("5Y", "2026-06-01"),
		gl("5Z", "2026-09-16"),
		gl("41", "2024-01-01"),
		gl("8L", "2025-03-01"),
	];
	const list = licenceList(rows, ["5Z", "41"], now);
	expect(list.map((l) => [l.id, l.recent])).toEqual([
		["5Z", true],
		["41", false],
	]);
	expect(licenceList(rows, null, now).map((l) => l.id)).toEqual(["5Z", "8L", "41"]);
});
