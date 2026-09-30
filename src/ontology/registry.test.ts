import { expect, test } from "bun:test";
import { FACILITIES } from "../adapters/firms-flares/facilities.ts";
import { ISPS } from "../adapters/ioda-asn/index.ts";
import { OUTLETS } from "../adapters/rss/outlets.ts";
import { normalize } from "../news/text.ts";
import { INSTITUTIONS } from "./institutions.ts";
import { FACILITY_NAMES } from "./linker.ts";
import { INFRA_ITEMS, registry } from "./registry.ts";
import { SEGMENT, shortMunicipalityName, slug } from "./slug.ts";
import { ENTITY_TYPES } from "./types.ts";

const reg = registry();
const byType = (t: string) => reg.all.filter((e) => e.type === t);

test("every official unit is there (25 states, 335 municipalities, 1,134 parishes), and search is fast", () => {
	const started = performance.now();
	reg.search("maracaibo");
	expect(performance.now() - started).toBeLessThan(50);
	expect(byType("country").map((e) => e.id)).toEqual(["ve"]);
	expect(byType("state")).toHaveLength(25);
	expect(byType("municipality")).toHaveLength(335);
	expect(byType("parish")).toHaveLength(1134);
	expect(byType("infrastructure").length).toBe(INFRA_ITEMS.length);
	expect(byType("network")).toHaveLength(ISPS.length + ISPS.flatMap((i) => i.asns).length);
	expect(byType("institution")).toHaveLength(INSTITUTIONS.length);
	for (const t of ENTITY_TYPES) expect(byType(t).length).toBeGreaterThan(0);
});

test("ids are unique, readable and follow the scheme of their type", () => {
	expect(new Set(reg.all.map((e) => e.id)).size).toBe(reg.all.length);
	const prefix: Record<string, RegExp> = {
		country: /^ve$/,
		state: /^ve\.[^.]+$/,
		municipality: /^ve\.[^.]+\.[^.]+$/,
		parish: /^ve\.[^.]+\.[^.]+\.[^.]+$/,
		infrastructure: /^infra\.[^.]+$/,
		network: /^(net|asn)\.[^.]+$/,
		outlet: /^outlet\.[^.]+$/,
		institution: /^inst\.[^.]+$/,
		camera: /^cam\.[a-z0-9-]+$/,
	};
	for (const e of reg.all) {
		expect(e.id, e.id).toMatch(prefix[e.type] as RegExp);
		for (const seg of e.id.split(".")) expect(seg, e.id).toMatch(SEGMENT);
	}
	expect(reg.get("ve.zulia")?.codes.iso).toBe("VE-V");
	expect(reg.get("ve.zulia.maracaibo")?.codes.pcode).toBe("VE2313");
	expect(reg.get("ve.miranda.guaicaipuro")?.name.es).toBe("Bolivariano Guaicaipuro");
	expect(reg.get("ve.distrito-capital.libertador.23-de-enero")?.type).toBe("parish");
	expect(reg.get("infra.planta-centro")?.kind).toBe("power-plant");
	expect(reg.get("infra.guri")?.attributes.capacityMW).toBe(10235);
	expect(reg.get("asn.8048")?.parents).toEqual(["net.cantv"]);
	expect(reg.get("outlet.el-pitazo")?.type).toBe("outlet");
	expect(reg.get("inst.bcv")?.short).toBe("BCV");
});

test("every parent exists, and the containment chain is state → municipality → parish", () => {
	const ids = new Set(reg.all.map((e) => e.id));
	for (const e of reg.all) for (const p of e.parents) expect(ids.has(p), `${e.id} → ${p}`).toBe(true);
	for (const s of byType("state")) expect(s.parents).toEqual(["ve"]);
	for (const m of byType("municipality")) expect(reg.get(m.parents[0] ?? "")?.type, m.id).toBe("state");
	for (const p of byType("parish")) expect(reg.get(p.parents[0] ?? "")?.type, p.id).toBe("municipality");
	// Every municipality has at least one parish, and ancestors end at the country.
	const withParish = new Set(byType("parish").map((p) => p.parents[0]));
	for (const m of byType("municipality")) expect(withParish.has(m.id), m.id).toBe(true);
	expect(reg.ancestors("ve.distrito-capital.libertador.altagracia").map((e) => e.id)).toEqual([
		"ve.distrito-capital.libertador",
		"ve.distrito-capital",
		"ve",
	]);
	for (const e of byType("infrastructure")) {
		const chain = reg.ancestors(e.id);
		expect(chain.at(-1)?.id, e.id).toBe("ve");
	}
});

test("relations point at entities that exist; every entity names a dataset with a licence", () => {
	for (const e of reg.all) {
		for (const r of e.related) expect(reg.get(r.id), `${e.id} ${r.rel} ${r.id}`).toBeDefined();
		const d = reg.datasets[e.dataset];
		expect(d, e.id).toBeDefined();
		expect(d.licence.name.length).toBeGreaterThan(0);
		expect(d.attribution.length).toBeGreaterThan(0);
	}
	expect(reg.get("infra.refineria-amuay")?.related).toEqual([{ rel: "operator", id: "inst.pdvsa" }]);
	expect(reg.get("net.cantv")?.related).toEqual([{ rel: "operator", id: "inst.cantv" }]);
});

test("every infrastructure point is in Venezuela's box and every linked source's codes resolve", () => {
	for (const e of byType("infrastructure")) {
		expect(e.point, e.id).not.toBeNull();
		expect(e.point?.lat).toBeGreaterThan(0.5);
		expect(e.point?.lat).toBeLessThan(16);
		expect(e.point?.lon).toBeGreaterThan(-74);
		expect(e.point?.lon).toBeLessThan(-59);
	}
	// Every outlet feed, flare facility, ISP and ASN the linker meets has its entity.
	for (const o of OUTLETS) expect(reg.byCode(`feed:${o.id}`), o.id).toBeDefined();
	for (const f of FACILITIES) expect(reg.byCode(`facility:${f.id}`), f.id).toBeDefined();
	for (const i of ISPS) {
		expect(reg.byCode(`isp:${i.id}`)?.id).toBe(`net.${i.id}`);
		for (const a of i.asns) expect(reg.byCode(`asn:${a}`)?.id).toBe(`asn.${a}`);
	}
	for (const s of byType("state")) expect(reg.byCode(`iso:${s.codes.iso}`)?.id).toBe(s.id);
	// A facility with a curated headline name exists (a typo would silently drop the rule).
	for (const [phrase, id] of Object.entries(FACILITY_NAMES)) expect(reg.get(id), phrase).toBeDefined();
	// The 18 PortWatch ports and the Guri dam's altimetry code.
	expect(byType("infrastructure").filter((e) => e.codes.portwatch)).toHaveLength(18);
	expect(reg.byCode("dahiti:67")?.id).toBe("infra.represa-del-guri");
});

test("institutions: organ names are unique and headline phrases never collide or match common words", () => {
	const organs = INSTITUTIONS.flatMap((i) => i.organs ?? []);
	expect(new Set(organs).size).toBe(organs.length);
	for (const o of organs) expect(o).toBe(o.toUpperCase());
	const phrases = INSTITUTIONS.flatMap((i) => (i.text ?? []).map((t) => normalize(t)));
	expect(new Set(phrases).size).toBe(phrases.length);
	// Short acronyms that are ordinary words or other bodies' names in Spanish headlines are not used.
	for (const bad of ["an", "mp", "ine", "fe", "pan"]) expect(phrases).not.toContain(bad);
	for (const i of INSTITUTIONS) if (i.attachedTo) expect(reg.get(i.attachedTo), i.id).toBeDefined();
	expect(reg.byCode("organ:MINISTERIO DEL PODER POPULAR PARA LA SALUD")?.id).toBe("inst.mpp-salud");
	expect(reg.byCode("publisher-of:bcv-official")?.id).toBe("inst.bcv");
});

test("search finds places, facilities, networks and institutions by name, alias and code", () => {
	const top = (q: string, type?: (typeof ENTITY_TYPES)[number]) =>
		reg.search(q, { type, limit: 3 })[0]?.entity.id;
	expect(top("zulia")).toBe("ve.zulia");
	expect(top("Maracaibo")).toBe("ve.zulia.maracaibo");
	expect(top("maracaibo", "infrastructure")).toBe("infra.puerto-maracaibo");
	expect(top("guaicaipuro")).toBe("ve.miranda.guaicaipuro");
	expect(top("Planta Centro")).toBe("infra.planta-centro");
	expect(top("guri")).toBe("infra.guri");
	expect(top("8048")).toBe("asn.8048");
	expect(top("AS8048")).toBe("asn.8048");
	expect(top("ccs")).toBe("infra.aeropuerto-ccs");
	expect(top("bcv")).toBe("inst.bcv");
	expect(top("el pitazo")).toBe("outlet.el-pitazo");
	expect(top("23 de enero")).toBe("ve.distrito-capital.libertador.23-de-enero");
	// Codes match exactly or by prefix, never inside another number.
	expect(reg.search("8048", { limit: 10 }).map((h) => h.entity.id)).toEqual(["asn.8048"]);
	expect(reg.search("")).toEqual([]);
	expect(reg.search("zzzz-nada")).toEqual([]);
	expect(reg.search("a", { limit: 999 }).length).toBeLessThanOrEqual(51);
});

test("slugs and municipal short names", () => {
	expect(slug("Anzoátegui")).toBe("anzoategui");
	expect(slug("Peña Larga")).toBe("pena-larga");
	expect(slug("  23 de Enero ")).toBe("23-de-enero");
	expect(slug("Casa de máquinas «Macagua»")).toBe("casa-de-maquinas-macagua");
	expect(shortMunicipalityName("Indígena Bolivariano Guajira")).toBe("Guajira");
	expect(shortMunicipalityName("Autónomo Alto Orinoco")).toBe("Alto Orinoco");
	expect(shortMunicipalityName("Libertador")).toBe("Libertador");
});
