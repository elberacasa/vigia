import { expect, test } from "bun:test";
import { STANCE_LABELS } from "../../../src/adapters/rss/factory.ts";
import { registry } from "../../../src/ontology/registry.ts";
import { shortMunicipalityName, slug } from "../../../src/ontology/slug.ts";
import { FACILITIES } from "../map/facilities.gen.ts";
import { parseFacilities } from "../map/facilities.ts";
import { HEALTH } from "../map/health.gen.ts";
import { entityIdFromPath, entityPath, stateIdOf } from "./entity-route.ts";
import { INFRA_WORD, STANCE_WORD } from "./entity-words.ts";
import { municipalitySlug } from "./states.ts";

const reg = registry();

test("every entity has one page, and the page leads back to it", () => {
	const paths = new Set<string>();
	for (const e of reg.all) {
		const path = entityPath(e.id);
		expect(path).not.toBeNull();
		expect(entityIdFromPath(path as string)).toBe(e.id);
		paths.add(path as string);
	}
	expect(paths.size).toBe(reg.all.length);
	expect(entityPath("asn.8048")).toBe("/red/as8048");
	expect(entityPath("ve")).toBe("/lugar");
	expect(stateIdOf("ve.zulia.maracaibo.chiquinquira")).toBe("ve.zulia");
	expect(stateIdOf("infra.guri")).toBeNull();
	// Nothing outside the scheme is an entity page.
	for (const bad of ["/infra/", "/red/AS8048", "/medio/../x", "/lugar/a/b/c/d", "/institucion/bcv/x"])
		expect(entityIdFromPath(bad)).toBeNull();
});

test("the client builds municipality ids exactly as the ontology does", () => {
	for (const e of reg.all.filter((x) => x.type === "municipality")) {
		const seg = e.id.split(".")[2];
		expect(municipalitySlug(e.name.es)).toBe(seg as string);
		expect(slug(shortMunicipalityName(e.name.es))).toBe(seg as string);
	}
});

test("the facilities layer's data is the registry's facilities, point for point", () => {
	const drawn = [...parseFacilities(FACILITIES), ...parseFacilities(HEALTH)];
	const infra = reg.all.filter((e) => e.type === "infrastructure" && e.kind !== "power-grid");
	expect(drawn.length).toBe(infra.length);
	const byId = new Map(infra.map((e) => [e.id, e]));
	for (const f of drawn) {
		const e = byId.get(f.id);
		expect(e?.kind).toBe(f.kind);
		expect(Math.abs((e?.point?.lat ?? 99) - f.lat)).toBeLessThan(0.001);
		expect(Math.abs((e?.point?.lon ?? 99) - f.lon)).toBeLessThan(0.001);
		expect(INFRA_WORD[f.kind]).toBeDefined();
	}
	// Health centres come apart (their own chunk), and only them.
	expect(parseFacilities(HEALTH).every((f) => f.kind === "hospital")).toBe(true);
	expect(parseFacilities(FACILITIES).some((f) => f.kind === "hospital")).toBe(false);
});

test("outlet stances are the news panel's words", () => {
	expect(STANCE_WORD).toEqual(STANCE_LABELS as unknown as typeof STANCE_WORD);
});
