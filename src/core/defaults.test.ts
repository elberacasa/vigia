import { expect, test } from "bun:test";
import { defaultTexts, onByDefault } from "./defaults.ts";

const why = { es: "motivo", en: "reason" };

test("without defaultIn: on unless opt-in, the same in both modes", () => {
	for (const mode of ["local", "public"] as const) {
		expect(onByDefault({}, mode)).toBe(true);
		expect(onByDefault({ note: why }, mode)).toBe(true);
		expect(onByDefault({ optIn: why }, mode)).toBe(false);
		expect(defaultTexts({ optIn: why }, mode)).toEqual({ optIn: why, note: null });
		expect(defaultTexts({ note: why }, mode)).toEqual({ optIn: null, note: why });
	}
});

test("defaultIn decides per mode, and its note is the reason shown where it is off", () => {
	const personal = { note: why, defaultIn: { local: true, public: false } };
	expect(onByDefault(personal, "local")).toBe(true);
	expect(onByDefault(personal, "public")).toBe(false);
	expect(defaultTexts(personal, "local")).toEqual({ optIn: null, note: why });
	expect(defaultTexts(personal, "public")).toEqual({ optIn: why, note: null });
	// defaultIn wins over optIn.
	const mirrorOnly = { optIn: why, defaultIn: { local: false, public: true } };
	expect(onByDefault(mirrorOnly, "public")).toBe(true);
	expect(onByDefault(mirrorOnly, "local")).toBe(false);
});
