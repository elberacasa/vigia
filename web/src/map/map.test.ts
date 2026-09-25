import { expect, test } from "bun:test";
import { FRAME, STATES } from "./geometry.gen.ts";
import {
	type ConnectivityHistory,
	history,
	historyRetry,
	historyState,
	indexAt,
	isoCaracas,
	loadHistory,
	parseViewTime,
	retryDelayMs,
	stepFor,
	stepLabel,
} from "./history.ts";
import { pathBox, project } from "./project.ts";
import { isRinging, markArrivals, quakeOpacity, quakeRadius } from "./QuakeLayer.tsx";
import { FULL, fitBox, MAX_ZOOM, zoomBox } from "./viewbox.ts";

const HOUR = 3_600_000;

test("pathBox bounds a generated state path; Lara sits inside the frame, north-west of centre", () => {
	const lara = STATES.find((s) => s.iso === "VE-K");
	if (!lara) throw new Error("Lara missing");
	const [x, y, w, h] = pathBox(lara.d);
	expect(w).toBeGreaterThan(50);
	expect(h).toBeGreaterThan(30);
	expect(x + w).toBeLessThan(FRAME.width / 2);
	expect(y + h).toBeLessThan(FRAME.height / 2);
	// Its label point is inside its box.
	expect(lara.label[0]).toBeGreaterThan(x);
	expect(lara.label[0]).toBeLessThan(x + w);
	expect(pathBox("M10 20l5 0l0 -30l-5 0z")).toEqual([10, -10, 5, 30]);
});

test("fitBox keeps the frame's aspect, adds margin, stays inside, and never zooms past the limit", () => {
	const aspect = FRAME.width / FRAME.height;
	const b = fitBox([600, 300, 100, 60]);
	expect(b[2] / b[3]).toBeCloseTo(aspect, 6);
	expect(b[2]).toBeGreaterThanOrEqual(130);
	expect(b[0]).toBeLessThanOrEqual(600 - 15);
	// A tiny state (Distrito Capital) stops at the maximum zoom.
	expect(fitBox([700, 250, 5, 5])[2]).toBeCloseTo(FRAME.width / MAX_ZOOM, 6);
	// A box at the frame's corner is shifted inside, not cropped.
	const corner = fitBox([0, 0, 40, 40]);
	expect(corner[0]).toBe(0);
	expect(corner[1]).toBe(0);
	// Anything as big as the country is the full view.
	expect(fitBox([0, 0, FRAME.width, FRAME.height])).toBe(FULL);
});

test("zoomBox zooms about the centre and returns exactly the full view when zooming out past it", () => {
	const inBox = zoomBox(FULL, 1 / 2);
	expect(inBox[2]).toBeCloseTo(FRAME.width / 2, 6);
	expect(inBox[0] + inBox[2] / 2).toBeCloseTo(FRAME.width / 2, 6);
	expect(zoomBox(inBox, 4)).toBe(FULL);
	expect(zoomBox(FULL, 1 / 100)[2]).toBeCloseTo(FRAME.width / MAX_ZOOM, 6);
});

test("quake marks: radius by magnitude (capped), outline fades with age on a log scale", () => {
	expect(quakeRadius(2)).toBe(6);
	expect(quakeRadius(4.5)).toBe(18);
	expect(quakeRadius(9)).toBe(40);
	expect(quakeOpacity(10 * 60_000)).toBe(1);
	expect(quakeOpacity(HOUR)).toBe(1);
	expect(quakeOpacity(30 * 24 * HOUR)).toBe(0.35);
	expect(quakeOpacity(90 * 24 * HOUR)).toBe(0.35);
	const day = quakeOpacity(24 * HOUR);
	expect(day).toBeGreaterThan(0.35);
	expect(day).toBeLessThan(1);
});

test("arrival rings: the first batch after load is seeded silently; only a new id is marked", () => {
	const at = (id: string) => ({ id, lat: 10, lon: -66, mag: 3, at: 0 });
	markArrivals([], 1);
	markArrivals([at("a"), at("b")], 2);
	expect(isRinging("a", 2)).toBe(false);
	markArrivals([at("a"), at("b"), at("c")], 3);
	expect(isRinging("c", 3)).toBe(true);
	expect(isRinging("b", 3)).toBe(false);
	// Rings once: the same id later is not new again, and the ring ends after 2.5 s.
	markArrivals([at("a"), at("b"), at("c")], 4);
	expect(isRinging("c", 3 + 2_600)).toBe(false);
});

test("history helpers: Caracas time in links, step labels, the step that holds a time", () => {
	const t = Date.UTC(2026, 8, 24, 22, 0); // 18:00 in Caracas
	expect(isoCaracas(t)).toBe("2026-09-24T18:00-04:00");
	expect(Date.parse(isoCaracas(t))).toBe(t);
	expect(stepLabel(t, HOUR, "es")).toBe("24 sept, 18:00–19:00");
	expect(stepLabel(t, 24 * HOUR, "es")).toBe("24 sept");
	const now = t + 3 * HOUR;
	expect(stepFor(t, now)).toBe("1h");
	expect(stepFor(now - 5 * 24 * HOUR, now)).toBe("6h");
	expect(stepFor(now - 20 * 24 * HOUR, now)).toBe("1d");
	const h = { times: [t - HOUR, t, t + HOUR], stepMs: HOUR } as ConnectivityHistory;
	expect(indexAt(h, t + 30 * 60_000)).toBe(1);
	expect(indexAt(h, t + 5 * HOUR)).toBe(-1);
});

test("project places Caracas in the frame", () => {
	const [x, y] = project(-66.9, 10.5);
	expect(x).toBeGreaterThan(0);
	expect(x).toBeLessThan(FRAME.width);
	expect(y).toBeGreaterThan(0);
	expect(y).toBeLessThan(FRAME.height / 3);
});

test("?t= without a zone is Caracas time; a day step starting at Caracas midnight is labelled that day (review 3, M8)", () => {
	expect(parseViewTime("2026-09-24")).toBe(Date.UTC(2026, 8, 24, 4));
	expect(parseViewTime("2026-09-24T18:00")).toBe(Date.UTC(2026, 8, 24, 22));
	expect(parseViewTime("2026-09-24T18:00-04:00")).toBe(Date.UTC(2026, 8, 24, 22));
	expect(parseViewTime("2026-09-24T22:00Z")).toBe(Date.UTC(2026, 8, 24, 22));
	expect(parseViewTime("ayer")).toBeNull();
	expect(parseViewTime(null)).toBeNull();
	// The server aligns day steps to 04:00 UTC: the bar for the 24th starts at 04:00 UTC on the 24th.
	expect(stepLabel(Date.UTC(2026, 8, 24, 4), 24 * HOUR, "es")).toBe("24 sept");
	expect(stepLabel(Date.UTC(2026, 8, 24, 22), 6 * HOUR, "es")).toBe("24 sept, 18:00–00:00");
});

test("history: a 503 is retried once after its Retry-After (clamped 1–30 s); a second 503 shows 'busy'", async () => {
	expect(retryDelayMs("7")).toBe(7_000);
	expect(retryDelayMs("0")).toBe(1_000);
	expect(retryDelayMs("600")).toBe(30_000);
	expect(retryDelayMs(null)).toBe(5_000);
	expect(retryDelayMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(5_000);
	const realFetch = globalThis.fetch;
	const realSleep = historyRetry.sleep;
	const waits: number[] = [];
	historyRetry.sleep = async (ms) => {
		waits.push(ms);
	};
	const busy = () => new Response('{"error":"ocupado"}', { status: 503, headers: { "retry-after": "5" } });
	const ok = () => new Response(JSON.stringify({ step: "1h", times: [], states: {} }), { status: 200 });
	try {
		let replies = [busy(), ok()];
		globalThis.fetch = (async () => replies.shift() ?? busy()) as unknown as typeof fetch;
		await loadHistory("1h", Date.UTC(2026, 8, 24, 12), true);
		expect(waits).toEqual([5_000]);
		expect(historyState.value).toBe("ok");
		expect(history.value?.step).toBe("1h");
		replies = [busy(), busy()];
		await loadHistory("1h", Date.UTC(2026, 8, 24, 13), true);
		expect(waits).toEqual([5_000, 5_000]);
		expect(historyState.value).toBe("busy");
	} finally {
		globalThis.fetch = realFetch;
		historyRetry.sleep = realSleep;
	}
});
