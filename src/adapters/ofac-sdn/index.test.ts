import { expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { Observation } from "../../core/types.ts";
import { type ChangeValue, type OfacValue, ofacSdn, type SnapshotValue } from "./index.ts";

// Recorded 2026-09-29 01:40–01:58 UTC from the Sanctions List Service and Wikidata. Kept out of the public repository
// (the SDN list and OFAC's delta files carry private persons' names, birth dates and documents); the synthetic tests
// cover the same code everywhere. Trimmed before commit, line for line: SDN.CSV keeps its first 1,000 lines and every
// Venezuela-programme line (409 of 19,391); the Wikidata answer keeps the 155 of 1,704 rows whose label can match a
// Venezuela-programme individual (no other row can change a result). Four 2026 publications with Venezuela entries
// (827, 841, 884, 959), fetched from the same service minutes later, are added to the three newest (976, 977, 984).
const dir = join(import.meta.dir, "fixtures", "2026-09-28");
const recorded = hasFixture(dir);
const obs: Observation<OfacValue>[] = recorded ? ofacSdn.normalise(loadFixture(dir)) : [];
const snapshot = obs.find((o) => o.value.kind === "snapshot")?.value as SnapshotValue | undefined;
const changes = obs.filter((o) => o.value.kind === "change") as Observation<ChangeValue>[];

test.skipIf(!recorded)(
	"the list on 2026-09-28: 409 Venezuela-programme entries, as of publication 984",
	() => {
		expect(snapshot?.publicationId).toBe(984);
		expect(snapshot?.counts).toEqual({
			total: 409,
			individuals: 190,
			entities: 104,
			vessels: 60,
			aircraft: 55,
		});
		expect(snapshot?.byProgram).toMatchObject({
			VENEZUELA: 166,
			"VENEZUELA-EO13850": 176,
			"VENEZUELA-EO13884": 67,
		});
		// 23 Sep 2026 10:07:28 US Eastern (daylight time) = 14:07:28 UTC.
		expect(new Date(obs.find((o) => o.series === "snapshot")?.observedAt ?? 0).toISOString()).toBe(
			"2026-09-23T14:07:28.000Z",
		);
		expect(snapshot?.wikidataChecked).toBe(true);
	},
);

test.skipIf(!recorded)("88 of 190 individuals are named: 51 by OFAC's title, the rest by Wikidata", () => {
	expect(snapshot?.officials.length).toBe(88);
	expect(snapshot?.unnamedIndividuals).toBe(102);
	expect(snapshot?.officials.filter((o) => o.basis === "ofac-title").length).toBe(51);
	const padrino = snapshot?.officials.find((o) => o.name === "PADRINO LOPEZ, Vladimir");
	expect(padrino).toMatchObject({ basis: "wikidata", wikidata: { qid: "Q19519696" } });
	// Two sanctioned men share a first name and surname; each matches his own Wikidata item, one to one.
	const gutierrez = snapshot?.officials.filter((o) => o.name.startsWith("GUTIERREZ PARRA, Jose")) ?? [];
	expect(gutierrez.map((o) => o.wikidata?.label).sort()).toEqual([
		"José Bernabé Gutiérrez",
		"José Luis Gutiérrez",
	]);
});

test.skipIf(!recorded)(
	"nothing about an unnamed individual is stored: no name, id, birth date or document",
	() => {
		const text = JSON.stringify(obs);
		for (const secret of ["DOB ", "Cedula", "Passport", "Linked To", "nationality", "Gender"]) {
			expect(text).not.toContain(secret);
		}
		// Named officials carry their OFAC id (a link to their record); the count of every other individual is all.
		const named = new Set(snapshot?.officials.map((o) => o.uid));
		expect(named.size).toBe(88);
		expect(text.match(/"type":"individual","named":false/g)?.length ?? 0).toBe(
			changes.filter((c) => c.value.subject.type === "individual" && !c.value.subject.named).length,
		);
	},
);

test.skipIf(!recorded)("OFAC's own changes of 2026: the removal of 1 April is dated and named", () => {
	const april = changes.find((c) => c.value.publicationId === 841);
	expect(april?.value).toMatchObject({
		action: "remove",
		programs: ["VENEZUELA"],
		listedOn: "2018-09-25",
		subject: { type: "individual", named: true, basis: "wikidata", name: "RODRIGUEZ GOMEZ, Delcy Eloina" },
	});
	expect(new Date(april?.observedAt ?? 0).toISOString()).toBe("2026-04-01T19:40:21.000Z");
	expect(april?.sourceUrl).toBe("https://sanctionssearch.ofac.treas.gov/Details.aspx?id=25077");
	const added = changes.filter((c) => c.value.action === "add").map((c) => c.value.subject);
	expect(added).toEqual([{ type: "entity", uid: "58278", name: "BLUWAVES PROPERTIES LIMITED" }]);
	// 884 removed 76 entries, two of them on a Venezuela programme (tankers).
	const may = changes.filter((c) => c.value.publicationId === 884).map((c) => c.value.subject);
	expect(may).toMatchObject([
		{ type: "vessel", name: "DESPINA ANDRIANNA", vesselType: "Crude Oil Tanker", flag: "Liberia" },
		{ type: "vessel", name: "MIA", vesselType: "Crude Oil Tanker", flag: "Guyana" },
	]);
	const pub = obs.find((o) => o.series === "publication:884")?.value;
	expect(pub).toMatchObject({ kind: "publication", venezuelaEntries: 2, totalEntries: 76 });
	// Publications without Venezuela entries still get a marker, so the next run does not fetch them again.
	expect(obs.filter((o) => o.value.kind === "publication").length).toBe(7);
	for (const o of obs) {
		expect(o.source).toBe("ofac-sdn");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.basis).toBe("official");
	}
});

test.skipIf(!recorded)("aircraft are counted by model, never by tail number", () => {
	expect(snapshot?.aircraftByModel.reduce((n, a) => n + a.count, 0)).toBe(55);
	expect(JSON.stringify(snapshot)).not.toMatch(/"YV\d{3,4}"/);
});
