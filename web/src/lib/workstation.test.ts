import { beforeAll, expect, test } from "bun:test";

// router.ts and layout.ts read the page's address, storage and viewport at import: a minimal desk browser.
beforeAll(() => {
	Object.assign(globalThis, {
		matchMedia: (q: string) => ({ matches: q.includes("min-width: 1000"), addEventListener() {} }),
		localStorage: { getItem: () => null, setItem() {} },
		document: {
			addEventListener() {},
			querySelector: () => null,
			documentElement: { dataset: {}, removeAttribute() {} },
		},
		location: { pathname: "/", search: "", hash: "" },
		addEventListener() {},
		requestAnimationFrame: () => 0,
	});
});

test("every panel lives in exactly one module (Incidentes lives in the inspector)", async () => {
	const { MODULES, moduleOfPanel } = await import("./modules.ts");
	const { PANEL_IDS } = await import("./layout.ts");
	const placed = MODULES.flatMap((m) => m.columns.flat());
	expect(new Set(placed).size).toBe(placed.length);
	expect([...placed, "incidentes", "inusual"].sort()).toEqual([...PANEL_IDS].sort());
	expect(moduleOfPanel("sismos").id).toBe("tierra");
	expect(moduleOfPanel("incidentes").id).toBe("situacion");
	// Paths and number keys are unique; no module path shadows a page (/estado is the feed status page).
	expect(new Set(MODULES.map((m) => m.path)).size).toBe(MODULES.length);
	expect(new Set(MODULES.map((m) => m.key)).size).toBe(MODULES.length);
	for (const m of MODULES)
		expect(["/estado", "/guia", "/fuentes", "/ia", "/resumen", "/bloqueos"]).not.toContain(m.path);
});

test("addresses open the room, a module, a page or a place", async () => {
	const { parsePath } = await import("./router.ts");
	expect(parsePath("/")).toMatchObject({ route: "wall", module: "situacion" });
	expect(parsePath("/dinero")).toMatchObject({ route: "wall", module: "dinero" });
	expect(parsePath("/internet/")).toMatchObject({ route: "wall", module: "internet" });
	expect(parsePath("/en-vivo")).toMatchObject({ route: "wall", module: "envivo" });
	expect(parsePath("/estado")).toMatchObject({ route: "status" });
	expect(parsePath("/lugar/zulia")).toMatchObject({ route: "entity", entity: "ve.zulia" });
	expect(parsePath("/lugar/zulia/maracaibo")).toMatchObject({
		route: "entity",
		entity: "ve.zulia.maracaibo",
	});
	expect(parsePath("/lugar/distrito-capital/libertador/catedral")).toMatchObject({
		route: "entity",
		entity: "ve.distrito-capital.libertador.catedral",
	});
	expect(parsePath("/lugar")).toMatchObject({ route: "entity", entity: "ve" });
	expect(parsePath("/infra/planta-centro")).toMatchObject({ route: "entity", entity: "infra.planta-centro" });
	expect(parsePath("/red/as8048")).toMatchObject({ route: "entity", entity: "asn.8048" });
	expect(parsePath("/red/cantv")).toMatchObject({ route: "entity", entity: "net.cantv" });
	expect(parsePath("/institucion/bcv")).toMatchObject({ route: "entity", entity: "inst.bcv" });
	expect(parsePath("/medio/el-pitazo")).toMatchObject({ route: "entity", entity: "outlet.el-pitazo" });
	// Anything else still opens the room, as before.
	expect(parsePath("/lugar/Zulia")).toMatchObject({ route: "wall", module: "situacion" });
	expect(parsePath("/lugar/a/b/c/d")).toMatchObject({ route: "wall" });
	expect(parsePath("/infra/Guri")).toMatchObject({ route: "wall" });
	expect(parsePath("/no-existe")).toMatchObject({ route: "wall", module: "situacion" });
});

test("every state has one slug, and the slug leads back to it", async () => {
	const { STATE_SLUG, stateBySlug, slugify } = await import("./states.ts");
	const slugs = [...STATE_SLUG.values()];
	expect(new Set(slugs).size).toBe(slugs.length);
	for (const [iso, slug] of STATE_SLUG) {
		expect(slug).toMatch(/^[a-z0-9-]+$/);
		expect(stateBySlug(slug)).toBe(iso);
	}
	expect(STATE_SLUG.get("VE-O")).toBe("nueva-esparta");
	expect(slugify("Táchira")).toBe("tachira");
	expect(slugify("Indígena Bolivariano Guajira")).toBe("indigena-bolivariano-guajira");
});

test("the desk follows Personalizar: saved order within each column, moved panels, hidden ones left out", async () => {
	const { arrange, shownColumns } = await import("./arrange.ts");
	const { MODULE_BY_ID } = await import("./modules.ts");
	const { PANEL_IDS } = await import("./layout.ts");
	const tierra = MODULE_BY_ID.get("tierra");
	if (!tierra) throw new Error("no Tierra module");
	// The default order keeps each module's own column order.
	expect(arrange(tierra, PANEL_IDS, [], {})).toEqual(tierra.columns.map((c) => [...c]));
	// Incendios moved above Clima, Alertas moved to the third column, Rayos hidden.
	const order: string[] = [...PANEL_IDS].filter((id) => id !== "incendios");
	order.splice(order.indexOf("clima"), 0, "incendios");
	const cols = arrange(tierra, order as (typeof PANEL_IDS)[number][], ["rayos"], { alertas: 2 });
	expect(cols).toEqual([
		["sismos"],
		["incendios", "clima"],
		["alertas", "satelite", "inundaciones", "bosque"],
	]);
	// Under 1700 px the third column joins the second, and says which module columns it holds.
	expect(shownColumns(tierra, cols, false)).toEqual([
		{ panels: ["sismos"], width: 1, from: [0] },
		{
			panels: ["incendios", "clima", "alertas", "satelite", "inundaciones", "bosque"],
			width: 1,
			from: [1, 2],
		},
	]);
	// An emptied column disappears; a saved column index the module does not have is ignored.
	const envivo = MODULE_BY_ID.get("envivo");
	if (!envivo) throw new Error("no En vivo module");
	expect(shownColumns(envivo, arrange(envivo, PANEL_IDS, [], { radio: 0, camaras: 0 }), true)).toEqual([
		{ panels: ["tv", "camaras", "radio"], width: 2, from: [0] },
	]);
	expect(arrange(envivo, PANEL_IDS, [], { tv: 7 })).toEqual([["tv"], ["camaras", "radio"]]);
});
