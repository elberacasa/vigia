import { beforeAll, expect, test } from "bun:test";

// layout.ts reads the viewport, storage and document at import: give it a minimal browser.
const store = new Map<string, string>();
beforeAll(() => {
	Object.assign(globalThis, {
		matchMedia: (q: string) => ({ matches: q.includes("min-width: 1000"), addEventListener() {} }),
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
const load = async () => ({ ...(await import("./views.ts")), ...(await import("./layout.ts")) });
const NOW = Date.UTC(2026, 8, 24, 18);

test("a preset shows its panels first, in its order, and hides the rest", async () => {
	const { PRESETS, presetLayout, layout, PANEL_IDS } = await load();
	const periodista = PRESETS.find((p) => p.id === "periodista");
	if (!periodista || periodista.panels === "all") throw new Error("preset missing");
	const l = presetLayout(periodista, layout.value);
	expect(l.order.slice(0, periodista.panels.length)).toEqual([...periodista.panels]);
	expect(l.hidden.sort()).toEqual(PANEL_IDS.filter((id) => !periodista.panels.includes(id)).sort());
	const todo = PRESETS.find((p) => p.id === "todo");
	if (!todo) throw new Error("preset missing");
	expect(presetLayout(todo, l)).toMatchObject({ order: [...PANEL_IDS], hidden: [] });
	// Every preset only names panels that exist.
	for (const p of PRESETS) if (p.panels !== "all") for (const id of p.panels) expect(PANEL_IDS).toContain(id);
});

test("exported views round-trip through the file", async () => {
	const { exportViewsFile, parseViewsFile, layout } = await load();
	const view = {
		id: "v-abc123",
		name: "Mi redacción",
		savedAt: NOW - 1000,
		layout: layout.value,
		map: { layer: "reports" as const, quakes: false, fires: true, state: "VE-V" },
		density: "compacto" as const,
		panelPrefs: null,
	};
	const r = parseViewsFile(exportViewsFile([view], NOW), NOW);
	expect(r).toEqual({ ok: true, views: [view], skipped: 0 });
});

test("an imported file is untrusted: bad fields are repaired, junk is refused, sizes are capped", async () => {
	const { parseViewsFile, VIEW_LIMIT } = await load();
	const hostile = JSON.stringify({
		format: "vigia-vistas",
		v: 1,
		views: [
			{
				id: "<img src=x onerror=alert(1)>",
				name: "  Rara\u0000vista  ",
				savedAt: NOW + 10 ** 9,
				layout: { order: ["nope", "sismos"], hidden: ["x"], column: { sismos: "middle" } },
				map: { layer: "javascript:alert(1)", quakes: "yes", state: "VE-ZZ" },
				density: "enorme",
				panelPrefs: {
					news: { hiddenStances: ["state", "evil"], states: ["VE-V", "XX"] },
					map: { layer: "nope" },
				},
				__proto__: { polluted: true },
			},
			{ name: "" },
			42,
		],
	});
	const r = parseViewsFile(hostile, NOW);
	if (!r.ok) throw new Error("expected ok");
	expect(r.skipped).toBe(2);
	const v = r.views[0];
	expect(v?.id).toMatch(/^v-[0-9a-z]+$/);
	expect(v?.name).toBe("Rara vista");
	expect(v?.savedAt).toBe(NOW);
	expect(new Set(v?.layout.order).size).toBe(v?.layout.order.length ?? -1);
	expect(v?.layout.order).not.toContain("nope");
	expect(v?.layout.hidden).toEqual([]);
	expect(v?.map).toEqual({ layer: "connectivity", quakes: true, fires: false, state: null });
	expect(v?.density).toBe("comodo");
	expect(v?.panelPrefs?.news).toEqual({ hiddenStances: ["state"], hiddenReaches: [], states: ["VE-V"] });
	expect(v?.panelPrefs?.map.layer).toBeNull();
	expect(({} as Record<string, unknown>).polluted).toBeUndefined();

	expect(parseViewsFile("not json", NOW).ok).toBe(false);
	expect(parseViewsFile('{"format":"other","views":[]}', NOW).ok).toBe(false);
	expect(parseViewsFile(JSON.stringify({ format: "vigia-vistas", views: [{ name: "" }] }), NOW).ok).toBe(
		false,
	);
	expect(parseViewsFile("x".repeat(300_000), NOW).ok).toBe(false);
	const many = parseViewsFile(JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ name: `v${i}` }))), NOW);
	expect(many.ok && many.views.length).toBe(VIEW_LIMIT);
});

test("merging replaces a view of the same name and keeps the limit", async () => {
	const { mergeViews, repairViews } = await load();
	const saved = repairViews(
		[
			{ id: "v-aaaa", name: "Casa" },
			{ id: "v-bbbb", name: "Oficina" },
		],
		NOW,
	);
	const incoming = repairViews(
		[
			{ id: "v-cccc", name: "casa", density: "pared" },
			{ id: "v-aaaa", name: "Nueva" },
		],
		NOW,
	);
	const merged = mergeViews(saved, incoming);
	expect(merged.map((v) => [v.id, v.name, v.density])).toEqual([
		["v-aaaa", "casa", "pared"],
		["v-bbbb", "Oficina", "comodo"],
		[String(merged[2]?.id), "Nueva", "comodo"],
	]);
	expect(merged[2]?.id).not.toBe("v-aaaa");
});
