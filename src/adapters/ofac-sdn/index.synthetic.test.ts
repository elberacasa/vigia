import { expect, test } from "bun:test";
import type { RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { WIKIDATA_SPARQL } from "../wikidata-officials/sparql.ts";
import {
	type ChangeValue,
	OFAC_SLS,
	ofacSdn,
	recentActionsUrl,
	SDN_CSV_URL,
	type SnapshotValue,
} from "./index.ts";
import { isPublicOfficeTitle, labelMatches, nameWords, ofacNameParts, officialMatches } from "./officials.ts";
import { parseDelta, programs, venezuelaRows } from "./parse.ts";

/**
 * Synthetic files in the shapes of OFAC's Sanctions List Service and Wikidata's SPARQL JSON. Every name, number and
 * date is invented.
 */

const AT = Date.UTC(2026, 0, 20, 12);
const raw = (url: string, body: string): RawResponse => ({
	url,
	status: 200,
	contentType: "",
	body,
	fetchedAt: AT,
});

const FILLER = Array.from(
	{ length: 1_000 },
	(_, i) => `${i + 1},"FILLER TRADING ${i}",-0- ,"SDGT",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- `,
);
const CSV = [
	...FILLER,
	'90001,"PEREZ RIVAS, Ana Maria",individual,"VENEZUELA","Venezuela\'s Minister of Invented Affairs",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"DOB 01 Jan 1970; Cedula No. 1.234.567 (Venezuela)."',
	'90002,"GOMEZ LARA, Luis Alberto",individual,"VENEZUELA-EO13850",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"DOB 02 Feb 1971; Passport X123 (Venezuela)."',
	'90003,"TORRES DIAZ, Carlos",individual,"VENEZUELA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"DOB 03 Mar 1972."',
	'90004,"INVENTED OIL CORP.",-0- ,"VENEZUELA-EO13850] [RUSSIA-EO14024",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Linked To: TORRES DIAZ, Carlos."',
	'90005,"SEA INVENTION",vessel,"VENEZUELA-EO13850",-0- ,-0- ,"Crude Oil Tanker",-0- ,-0- ,"Panama",-0- ,"Vessel Registration Identification IMO 1234567; Linked To: INVENTED OIL CORP."',
	'90006,"YV9999",aircraft,"VENEZUELA-EO13884",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Aircraft Model Falcon 1X; Aircraft Tail Number YV9999."',
	'90007,"YV9998",aircraft,"VENEZUELA-EO13884",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Aircraft Model Falcon 1X; Aircraft Tail Number YV9998."',
	"\u001a",
].join("\r\n");

const HISTORY = JSON.stringify([
	{ publicationID: 501, datePublished: "2026-01-15T10:30:00.123" },
	{ publicationID: 500, datePublished: "2026-01-10T09:00:00" },
]);

const DELTA = `<?xml version="1.0" encoding="utf-8"?>
<sanctionsData xmlns="https://www.treasury.gov/ofac/DeltaFile/1.0">
  <publicationInfo><datePublished>2026-01-15T00:00:00-05:00</datePublished><publicationType>Standard Action</publicationType></publicationInfo>
  <entities>
    <entity id="90003" action="add">
      <generalInfo><identityId>1</identityId><entityType refId="600">Individual</entityType></generalInfo>
      <sanctionsLists><sanctionsList id="1" refId="1550" datePublished="2026-01-15">SDN List</sanctionsList></sanctionsLists>
      <sanctionsPrograms><sanctionsProgram id="2" refId="3">VENEZUELA</sanctionsProgram></sanctionsPrograms>
      <names><name id="3"><isPrimary>true</isPrimary><translations><translation id="4"><isPrimary>true</isPrimary>
        <formattedFullName>TORRES DIAZ, Carlos</formattedFullName></translation></translations></name></names>
      <features><feature id="5"><type featureTypeId="8">Birthdate</type><value>03 Mar 1972</value></feature></features>
    </entity>
    <entity id="90002" action="remove">
      <generalInfo><identityId>2</identityId><entityType refId="600">Individual</entityType></generalInfo>
      <sanctionsLists><sanctionsList id="6" refId="1550" datePublished="2019-05-01">SDN List</sanctionsList></sanctionsLists>
      <sanctionsPrograms><sanctionsProgram id="7" refId="3">VENEZUELA-EO13850</sanctionsProgram></sanctionsPrograms>
      <names><name id="8"><isPrimary>true</isPrimary><translations><translation id="9"><isPrimary>true</isPrimary>
        <formattedFullName>GOMEZ LARA, Luis Alberto</formattedFullName></translation></translations></name></names>
    </entity>
    <entity id="90008" action="add">
      <generalInfo><identityId>3</identityId><entityType refId="602">Vessel</entityType></generalInfo>
      <sanctionsPrograms><sanctionsProgram id="10" refId="3">VENEZUELA-EO13850</sanctionsProgram></sanctionsPrograms>
      <names><name id="11"><isPrimary>true</isPrimary><translations><translation id="12"><isPrimary>true</isPrimary>
        <formattedFullName>OCEAN MADE UP</formattedFullName></translation></translations></name></names>
      <features><feature id="13"><type featureTypeId="2">VESSEL TYPE</type><value>Crude Oil Tanker</value></feature>
        <feature id="14"><type featureTypeId="3">Vessel Flag</type><value>Panama</value></feature></features>
    </entity>
    <entity id="90009" action="add">
      <generalInfo><identityId>4</identityId><entityType refId="601">Entity</entityType></generalInfo>
      <sanctionsPrograms><sanctionsProgram id="15" refId="4">SDGT</sanctionsProgram></sanctionsPrograms>
      <names><name id="16"><isPrimary>true</isPrimary><translations><translation id="17"><isPrimary>true</isPrimary>
        <formattedFullName>NOT VENEZUELA LTD</formattedFullName></translation></translations></name></names>
    </entity>
  </entities>
</sanctionsData>`;

const WIKIDATA = JSON.stringify({
	head: { vars: ["person", "personLabel", "posLabel", "start"] },
	results: {
		bindings: [
			{
				person: { type: "uri", value: "http://www.wikidata.org/entity/Q900001" },
				personLabel: { type: "literal", value: "Luis Gómez" },
				posLabel: { type: "literal", value: "gobernador del estado Inventado" },
				start: { type: "literal", value: "2017-10-16T00:00:00Z" },
			},
			{
				person: { type: "uri", value: "http://www.wikidata.org/entity/Q900001" },
				personLabel: { type: "literal", value: "Luis Gómez" },
				posLabel: { type: "literal", value: "diputado de Venezuela" },
				start: { type: "literal", value: "2011-01-05T00:00:00Z" },
			},
		],
	},
});

const raws = [
	raw(`${OFAC_SLS}/changes/history/2026`, HISTORY),
	raw(`${OFAC_SLS}/changes/501`, DELTA),
	raw(SDN_CSV_URL, CSV),
	raw(`${WIKIDATA_SPARQL}?query=x`, WIKIDATA),
];

test("snapshot: counts, named officials (OFAC title, Wikidata), everyone else only counted", () => {
	const obs = ofacSdn.normalise(raws);
	const snap = obs.find((o) => o.series === "snapshot");
	expect(new Date(snap?.observedAt ?? 0).toISOString()).toBe("2026-01-15T15:30:00.000Z");
	const v = snap?.value as SnapshotValue;
	expect(v.publicationId).toBe(501);
	expect(v.counts).toEqual({ total: 7, individuals: 3, entities: 1, vessels: 1, aircraft: 2 });
	expect(v.byProgram).toEqual({
		VENEZUELA: 2,
		"VENEZUELA-EO13850": 3,
		"RUSSIA-EO14024": 1,
		"VENEZUELA-EO13884": 2,
	});
	expect(v.officials).toEqual([
		{
			uid: "90002",
			name: "GOMEZ LARA, Luis Alberto",
			title: null,
			basis: "wikidata",
			wikidata: { qid: "Q900001", label: "Luis Gómez", position: "gobernador del estado Inventado" },
			programs: ["VENEZUELA-EO13850"],
		},
		{
			uid: "90001",
			name: "PEREZ RIVAS, Ana Maria",
			title: "Venezuela's Minister of Invented Affairs",
			basis: "ofac-title",
			wikidata: null,
			programs: ["VENEZUELA"],
		},
	]);
	expect(v.unnamedIndividuals).toBe(1);
	expect(v.entities).toEqual([
		{ uid: "90004", name: "INVENTED OIL CORP.", programs: ["VENEZUELA-EO13850", "RUSSIA-EO14024"] },
	]);
	expect(v.vessels).toEqual([
		{
			uid: "90005",
			name: "SEA INVENTION",
			vesselType: "Crude Oil Tanker",
			flag: "Panama",
			imo: "1234567",
			programs: ["VENEZUELA-EO13850"],
		},
	]);
	expect(v.aircraftByModel).toEqual([{ model: "Falcon 1X", count: 2 }]);
	const text = JSON.stringify(obs);
	for (const leak of ["TORRES", "Carlos", "1972", "Cedula", "Passport", "YV9999", "Linked To"])
		expect(text).not.toContain(leak);
});

test("changes: OFAC's actions, dated by the publication, other programmes ignored", () => {
	const obs = ofacSdn.normalise(raws);
	const changes = obs.filter((o) => o.value.kind === "change");
	expect(changes.map((c) => (c.value as ChangeValue).subject)).toEqual([
		{ type: "individual", named: false },
		{
			type: "individual",
			named: true,
			uid: "90002",
			name: "GOMEZ LARA, Luis Alberto",
			title: null,
			basis: "wikidata",
			wikidata: { qid: "Q900001", label: "Luis Gómez", position: "gobernador del estado Inventado" },
		},
		{ type: "vessel", uid: "90008", name: "OCEAN MADE UP", vesselType: "Crude Oil Tanker", flag: "Panama" },
	]);
	expect(changes.map((c) => (c.value as ChangeValue).action)).toEqual(["add", "remove", "add"]);
	// The unnamed one links to the day's page, not to the person's record.
	expect(changes[0]?.sourceUrl).toBe("https://ofac.treasury.gov/recent-actions/20260115");
	expect(changes[1]?.sourceUrl).toBe("https://sanctionssearch.ofac.treas.gov/Details.aspx?id=90002");
	expect(new Date(changes[0]?.observedAt ?? 0).toISOString()).toBe("2026-01-15T15:30:00.000Z");
	expect(obs.find((o) => o.series === "publication:501")?.value).toMatchObject({
		venezuelaEntries: 3,
		totalEntries: 4,
	});
	expect(JSON.stringify(changes)).not.toContain("1972");
});

test("without Wikidata only OFAC's titles name anyone", () => {
	const obs = ofacSdn.normalise(raws.filter((r) => !r.url.startsWith(WIKIDATA_SPARQL)));
	const v = obs.find((o) => o.series === "snapshot")?.value as SnapshotValue;
	expect(v.officials.map((o) => o.name)).toEqual(["PEREZ RIVAS, Ana Maria"]);
	expect(v.unnamedIndividuals).toBe(2);
	expect(v.wikidataChecked).toBe(false);
});

test("a run with no new publication stores only the history's markers it was given", () => {
	expect(ofacSdn.normalise([raws[0] as RawResponse])).toEqual([]);
	expect(() => ofacSdn.normalise([])).toThrow(SchemaError);
	expect(() => ofacSdn.normalise([raw(`${OFAC_SLS}/changes/history/2026`, "<html>")])).toThrow("JSON");
	expect(() => ofacSdn.normalise([raws[0] as RawResponse, raw(SDN_CSV_URL, "a,b\n")])).toThrow("SDN.CSV");
});

test("name rules", () => {
	expect(isPublicOfficeTitle("Governor of Invented State")).toBe(true);
	expect(isPublicOfficeTitle("Major General, Commander of an Invented Region")).toBe(true);
	expect(isPublicOfficeTitle("Owner of a private bakery")).toBe(false);
	expect(isPublicOfficeTitle("-0-")).toBe(false);
	expect(nameWords("RODRÍGUEZ de la PAZ, Ñáñez")).toEqual(["rodriguez", "paz", "nanez"]);
	expect(ofacNameParts("GOMEZ LARA, Luis Alberto")).toEqual({
		surnames: ["gomez", "lara"],
		given: ["luis", "alberto"],
	});
	expect(labelMatches("Luis Gómez", "GOMEZ LARA, Luis Alberto")).toBe(true);
	expect(labelMatches("Luis Alberto Gómez Lara", "GOMEZ LARA, Luis Alberto")).toBe(true);
	expect(labelMatches("Alberto Gómez", "GOMEZ LARA, Luis Alberto")).toBe(false);
	expect(labelMatches("Luis Gómez Pérez", "GOMEZ LARA, Luis Alberto")).toBe(false);
	expect(labelMatches("Gómez", "GOMEZ LARA, Luis Alberto")).toBe(false);
	// One holder who could be two sanctioned people names neither; two holders for one person name nobody.
	const holder = (qid: string, label: string) => ({ qid, label, position: "diputado de Venezuela" });
	const two = officialMatches(["GOMEZ LARA, Luis Alberto", "GOMEZ PAZ, Luis"], [holder("Q1", "Luis Gómez")]);
	expect(two.size).toBe(0);
	const both = officialMatches(
		["GOMEZ LARA, Luis Alberto"],
		[holder("Q1", "Luis Gómez"), holder("Q2", "Luis Gómez Lara")],
	);
	expect(both.size).toBe(0);
	expect(programs("VENEZUELA-EO13850] [RUSSIA-EO14024")).toEqual(["VENEZUELA-EO13850", "RUSSIA-EO14024"]);
	expect(recentActionsUrl("2026-04-01T15:40:21.27")).toBe(
		"https://ofac.treasury.gov/recent-actions/20260401",
	);
});

test("parsers reject what is not OFAC's", () => {
	expect(() =>
		parseDelta(
			"<sanctionsData><publicationInfo><datePublished>soon</datePublished></publicationInfo></sanctionsData>",
		),
	).toThrow("fecha");
	expect(() => venezuelaRows("1,2,3\n")).toThrow("SDN.CSV");
});
