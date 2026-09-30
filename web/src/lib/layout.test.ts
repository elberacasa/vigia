import { beforeAll, expect, test } from "bun:test";

// layout.ts reads the viewport, storage and document at import: give it a minimal browser (a phone, empty storage).
// Every test file runs in one process and a module is evaluated once, so when another file (views.test.ts, a desk)
// imported layout.ts first, its viewport was measured there: tests that depend on the form set `viewport` themselves
// (file order differs by OS: macOS ran views.test.ts first and this test failed there only).
const store = new Map<string, string>();
beforeAll(() => {
	Object.assign(globalThis, {
		matchMedia: (q: string) => ({ matches: q.includes("max-width"), addEventListener() {} }),
		localStorage: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
		},
		document: {
			addEventListener() {},
			querySelector: () => null,
			documentElement: { dataset: {}, removeAttribute() {} },
		},
		location: { search: "", hash: "" },
		requestAnimationFrame: () => 0,
	});
});
const load = () => import("./layout.ts");

test("a corrupt or outdated saved layout is repaired, never trusted", async () => {
	const { repair, PANEL_IDS } = await load();
	const l = repair({
		order: ["sismos", "nope", "sismos", 7, "dinero"],
		column: { sismos: "left", dinero: "middle" },
		hidden: ["censura", "censura", "gone"],
		collapsed: { phone: { noticias: false, x: true }, desk: "bad" },
	});
	expect(l.order.filter((id) => id !== "incidentes" && id !== "inusual").slice(0, 2)).toEqual([
		"sismos",
		"dinero",
	]);
	// Panels the saved layout did not know go to their default place: the incidents panel first, then "lo inusual".
	expect(l.order.slice(0, 2)).toEqual(["incidentes", "inusual"]);
	expect([...l.order].sort()).toEqual([...PANEL_IDS].sort());
	expect(l.column.sismos).toBe("left");
	expect(l.column.dinero).toBe("left");
	expect(l.hidden).toEqual(["censura"]);
	expect(l.collapsed).toEqual({ phone: { noticias: false }, desk: {} });
	expect(repair(null).order).toEqual([...PANEL_IDS]);
});

test("phones start collapsed; moves stay within the list and are saved", async () => {
	const {
		isCollapsed,
		setCollapsed,
		movePanel,
		visibleOrder,
		hidePanel,
		hiddenPanels,
		resetLayout,
		viewport,
	} = await load();
	viewport.value = "phone";
	resetLayout();
	expect(isCollapsed("dinero")).toBe(true);
	setCollapsed("dinero", false);
	expect(isCollapsed("dinero")).toBe(false);
	expect(movePanel("incidentes", -1)).toBe(false);
	expect(movePanel("conectividad", -1)).toBe(true);
	expect(visibleOrder.value.slice(2, 4)).toEqual(["conectividad", "dinero"]);
	hidePanel("conectividad");
	expect(hiddenPanels()).toEqual(["conectividad"]);
	expect(visibleOrder.value[2]).toBe("dinero");
	expect(JSON.parse(store.get("vigia:layout:v1") ?? "{}").hidden).toEqual(["conectividad"]);
	resetLayout();
	expect(hiddenPanels()).toEqual([]);
});

test("desks start open; each form keeps its own collapsed state", async () => {
	const { isCollapsed, setCollapsed, resetLayout, viewport } = await load();
	resetLayout();
	viewport.value = "mid";
	expect(isCollapsed("dinero")).toBe(false);
	setCollapsed("dinero", true);
	viewport.value = "phone";
	expect(isCollapsed("dinero")).toBe(true);
	setCollapsed("dinero", false);
	viewport.value = "mid";
	expect(isCollapsed("dinero")).toBe(true);
	resetLayout();
});
