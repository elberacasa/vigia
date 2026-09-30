import { expect, test } from "bun:test";
import { Store } from "../../core/store.ts";
import type { FetchContext, RawResponse } from "../../core/types.ts";
import { MissingKeyError, SchemaError } from "../../core/types.ts";
import { camerasView } from "../../panels/cameras.ts";
import { LIST_CONTENT_TYPE, readWebcam, WINDY_KEY_ID, WINDY_QUERIES, windyWebcams } from "./index.ts";

/** Synthetic list in the shape of Windy's API v3 (invented cameras and titles). */
const list = (webcams: unknown[]): RawResponse => ({
	url: "https://api.windy.com/webcams/api/v3/webcams?countries=VE",
	status: 200,
	contentType: LIST_CONTENT_TYPE,
	body: JSON.stringify({ total: webcams.length, webcams }),
	fetchedAt: Date.UTC(2026, 8, 29, 12),
});
const cam = (id: number, over: Record<string, unknown> = {}) => ({
	webcamId: id,
	title: `Ciudad de prueba ${id}`,
	status: "active",
	lastUpdatedOn: "2026-09-29T11:30:00.000Z",
	location: { city: "Prueba", region: "Zulia", country_code: "VE", latitude: 10.65, longitude: -71.64 },
	player: { day: `https://webcams.windy.com/webcams/public/embed/player/${id}/day` },
	urls: { detail: `https://www.windy.com/webcams/${id}` },
	images: { current: { preview: "https://imgproxy.windy.com/secret-token.jpg" } },
	...over,
});

test("locked without the user's key; with it, three lists, the key only in a header", async () => {
	const asked: { url: string; headers: Record<string, string> | undefined }[] = [];
	const ctx = (key: string | undefined): FetchContext => ({
		http: {
			async request(url, o = {}) {
				asked.push({ url, headers: o.headers as Record<string, string> | undefined });
				return { ...list([cam(1)]), url };
			},
		},
		key: (id) => (id === WINDY_KEY_ID ? key : undefined),
		now: () => 1,
		signal: new AbortController().signal,
	});
	await expect(windyWebcams.fetch(ctx(undefined))).rejects.toBeInstanceOf(MissingKeyError);
	expect(asked).toEqual([]);
	await windyWebcams.fetch(ctx("abcdefgh12345678"));
	expect(asked).toHaveLength(WINDY_QUERIES.length);
	for (const a of asked) {
		expect(a.url).not.toContain("abcdefgh12345678");
		expect(a.headers?.["x-windy-api-key"]).toBe("abcdefgh12345678");
		expect(a.url).not.toContain("images");
	}
});

test("normalise: one observation per camera across lists; no image URL is ever kept", () => {
	const obs = windyWebcams.normalise([list([cam(1), cam(2)]), list([cam(2), { webcamId: 3 }])]);
	expect(obs.map((o) => o.series)).toEqual(["windy:1", "windy:2"]);
	expect(obs[0]?.value).toMatchObject({
		id: "1",
		status: "active",
		lat: 10.65,
		country: "VE",
		title: "Cámara en Windy · Prueba",
	});
	// Never the camera's own title, never a precise position.
	const home = readWebcam(
		cam(9, {
			title: "Casa de Fulano",
			location: { city: "X", country_code: "VE", latitude: 10.123456, longitude: -71.987654 },
		}),
	);
	expect(home?.title).not.toContain("Fulano");
	expect([home?.lat, home?.lon]).toEqual([10.12, -71.99]);
	expect(windyWebcams.defaultIn).toEqual({ local: true, public: false });
	expect(obs[0]?.observedAt).toBe(Date.parse("2026-09-29T11:30:00.000Z"));
	expect(JSON.stringify(obs)).not.toContain("imgproxy");
	expect(() => windyWebcams.normalise([{ ...list([]), body: "<html>" }])).toThrow(SchemaError);
	expect(windyWebcams.licence.raw).toBe(false);
});

test("only Windy's own player is ever framed; anything else falls back to the standard player URL", () => {
	expect(readWebcam(cam(5, { player: { day: "https://evil.example/x" } }))?.player).toBe(
		"https://webcams.windy.com/webcams/public/embed/player/5/day",
	);
	expect(readWebcam(cam(5, { webcamId: "5/../../x" }))).toBeNull();
	expect(readWebcam({ ...cam(6), location: undefined })).toBeNull();
});

test("the cameras panel lists Windy cameras with Windy's credit, and never twice a camera the census has", () => {
	const store = new Store(":memory:");
	const now = Date.UTC(2026, 8, 29, 12);
	store.insert(windyWebcams.normalise([list([cam(77), cam(1656890882), cam(88, { status: "inactive" })])]));
	const view = camerasView(store, now);
	const windy = view.cameras.filter((c) => c.origin === "windy");
	expect(windy.map((c) => c.id)).toEqual(["windy-77", "windy-88"]);
	expect(windy[0]).toMatchObject({
		status: "live",
		image: null,
		entity: null,
		state: "VE-V",
		creditEs: "Webcams provided by windy.com — add a webcam",
		play: { type: "embed", url: "https://webcams.windy.com/webcams/public/embed/player/77/day" },
	});
	expect(windy[1]?.status).toBe("down");
});
