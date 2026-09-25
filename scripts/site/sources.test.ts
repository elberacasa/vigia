import { expect, test } from "bun:test";
import { ADAPTERS } from "../../src/adapters/registry.ts";
import { keyless, newsPublishers } from "./facts.ts";
import { accessOf, GROUPS, miniPath, sources } from "./sources.ts";

const data = sources(ADAPTERS, newsPublishers(ADAPTERS));

test("every adapter is listed once, in a known group, with a homepage", () => {
	expect(data.rows.length).toBe(ADAPTERS.length);
	expect(new Set(data.rows.map((r) => r.id)).size).toBe(ADAPTERS.length);
	for (const r of data.rows) {
		expect(GROUPS).toContain(r.group);
		expect(r.homepage).toMatch(/^https?:\/\/[^/]+/);
	}
	expect(data.groups.reduce((n, g) => n + g.count, 0)).toBe(ADAPTERS.length);
});

test("the access counts follow the facts' rule (keyless: no key and on by default)", () => {
	expect(data.free).toBe(keyless(ADAPTERS));
	expect(data.free + data.key + data.optin).toBe(data.total);
	expect(accessOf({ keys: ["K"], optIn: { es: "", en: "" } })).toBe("key");
	expect(accessOf({ keys: [] })).toBe("free");
});

test("news splits by channel and reach; regional outlets are counted per state", () => {
	const group = (id: string) => data.rows.find((r) => r.id === id)?.group;
	expect(group("tg-vtv")).toBe("telegram");
	expect(group("youtube-live")).toBe("video");
	expect(group("bcv-official")).toBe("money");
	for (const r of data.rows.filter((x) => x.group === "regional")) expect(r.region).toMatch(/^VE-/);
	const withOutlets = data.states.filter((s) => s.outlets > 0);
	expect(withOutlets.length).toBeGreaterThan(10);
	for (const s of data.states) expect(s.d).toMatch(/^M\d+ \d+l/);
});

test("the mini map's outlines are simplified closed rings in whole units", () => {
	const square = "M0 0l40 0l0 0.1l0 39.9l-40 0l0 -40z";
	expect(miniPath(square, 0.25)).toBe("M0 0l10 0 0 10-10 0 0-10z");
});
