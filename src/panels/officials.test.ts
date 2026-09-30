import { expect, test } from "bun:test";
import { join } from "node:path";
import { wikidataOfficials } from "../adapters/wikidata-officials/index.ts";
import { loadFixture } from "../core/fixtures.ts";
import { Store } from "../core/store.ts";
import { officialsView } from "./officials.ts";

test("offices by kind, current first, with the rule and the counts", () => {
	const store = new Store(":memory:");
	store.insert(
		wikidataOfficials.normalise(
			loadFixture(join(import.meta.dir, "..", "adapters", "wikidata-officials", "fixtures", "2026-09-28")),
		),
	);
	const v = officialsView(store, Date.parse("2026-09-29T03:00:00Z"));
	expect(v.counts).toEqual({ current: 8, ended: 29, unknown: 6 });
	expect(v.offices[0]).toMatchObject({ kind: "president", status: "current" });
	expect(v.offices[1]?.kind).toBe("vice-president");
	const governors = v.offices.filter((o) => o.kind === "governor");
	expect(governors.find((o) => o.state === "VE-V")?.stateName).toBe("Zulia");
	expect(v.offices.findIndex((o) => o.kind === "governor")).toBeGreaterThan(
		v.offices.findIndex((o) => o.kind === "minister"),
	);
	expect(v.rule).toContain("Wikidata");
	expect(v.stale).toBe(false);
});
