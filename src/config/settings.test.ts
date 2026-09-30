import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "../core/types.ts";
import { openSettings } from "./settings.ts";

const feed = (over: Partial<Adapter>): Adapter => ({ id: "f", ...over }) as Adapter;
const why = { es: "motivo", en: "reason" };

test("a feed's default follows the deployment mode; the user's switch wins in both", () => {
	const dir = mkdtempSync(join(tmpdir(), "vigia-settings-"));
	try {
		const settings = openSettings(dir);
		const personal = feed({ id: "gn-x", note: why, defaultIn: { local: true, public: false } });
		expect(settings.feedEnabled(personal)).toBe(true);
		expect(settings.feedEnabled(personal, "local")).toBe(true);
		expect(settings.feedEnabled(personal, "public")).toBe(false);
		expect(settings.feedEnabled(feed({ id: "p2p", optIn: why }), "local")).toBe(false);
		expect(settings.feedEnabled(feed({ id: "plain" }), "public")).toBe(true);
		settings.setFeed("gn-x", true);
		expect(settings.feedEnabled(personal, "public")).toBe(true);
		settings.setFeed("gn-x", false);
		expect(settings.feedEnabled(personal, "local")).toBe(false);
		// Saved and read back.
		expect(openSettings(dir).feedEnabled(personal, "local")).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the data saver: unset until chosen, saved, and a heavy feed held back only while the user has no switch for it", () => {
	const dir = mkdtempSync(join(tmpdir(), "vigia-settings-"));
	try {
		const settings = openSettings(dir);
		const heavy = feed({ id: "goes-nsa" });
		expect(settings.data.dataSaver).toBeUndefined();
		expect(settings.feedEnabled(heavy, "local", false)).toBe(true);
		settings.setDataSaver(true);
		expect(openSettings(dir).data.dataSaver).toBe(true);
		expect(settings.feedEnabled(heavy, "local", true)).toBe(false);
		settings.setFeed("goes-nsa", true);
		expect(settings.feedEnabled(heavy, "local", true)).toBe(true);
		settings.setDataSaver(false);
		expect(openSettings(dir).data.dataSaver).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
