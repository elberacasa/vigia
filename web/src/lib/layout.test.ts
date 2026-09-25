import { beforeAll, expect, test } from "bun:test";

// layout.ts reads the viewport, storage and document at import: give it a minimal browser (a phone, empty storage).
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
	expect(l.order.filter((id) => id !== "incidentes").slice(0, 2)).toEqual(["sismos", "dinero"]);
	// A panel the saved layout did not know goes to its default place: the incidents panel first.
	expect(l.order[0]).toBe("incidentes");
	expect([...l.order].sort()).toEqual([...PANEL_IDS].sort());
	expect(l.column.sismos).toBe("left");
	expect(l.column.dinero).toBe("left");
	expect(l.hidden).toEqual(["censura"]);
	expect(l.collapsed).toEqual({ phone: { noticias: false }, desk: {} });
	expect(repair(null).order).toEqual([...PANEL_IDS]);
});

test("phones start collapsed; moves stay within the list and are saved", async () => {
	const { isCollapsed, setCollapsed, movePanel, visibleOrder, hidePanel, hiddenPanels, resetLayout } =
		await load();
	resetLayout();
	expect(isCollapsed("dinero")).toBe(true);
	setCollapsed("dinero", false);
	expect(isCollapsed("dinero")).toBe(false);
	expect(movePanel("incidentes", -1)).toBe(false);
	expect(movePanel("conectividad", -1)).toBe(true);
	expect(visibleOrder.value.slice(1, 3)).toEqual(["conectividad", "dinero"]);
	hidePanel("conectividad");
	expect(hiddenPanels()).toEqual(["conectividad"]);
	expect(visibleOrder.value[1]).toBe("dinero");
	expect(JSON.parse(store.get("vigia:layout:v1") ?? "{}").hidden).toEqual(["conectividad"]);
	resetLayout();
	expect(hiddenPanels()).toEqual([]);
});
