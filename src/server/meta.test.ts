import { expect, test } from "bun:test";
import { unpackMeta } from "../../web/src/lib/data.ts";
import { etagMatches, packLicences, strongEtag } from "./meta.ts";

const cc = { id: "cc-by", name: "CC BY 4.0", url: "https://c", attribution: "A", commercial: true as const };
const noaaA = { id: "noaa", name: "PD", url: "https://n", attribution: "NESDIS", commercial: true as const };
const noaaB = { ...noaaA, attribution: "NHC" };

test("packLicences: one entry per distinct licence, same id with other text gets its own key, round-trips", () => {
	const feeds = [
		{ id: "a", licence: cc },
		{ id: "b", licence: cc },
		{ id: "c", licence: noaaA },
		{ id: "d", licence: noaaB },
		{ id: "mine", licence: null },
	];
	const packed = packLicences(feeds);
	expect(Object.keys(packed.licences)).toEqual(["cc-by", "noaa", "noaa~2"]);
	expect(packed.feeds.map((f) => f.licence)).toEqual(["cc-by", "cc-by", "noaa", "noaa~2", null]);
	const back = unpackMeta({ version: "t", ...packed } as never);
	expect(back.slice(0, 4).map((f) => f.licence)).toEqual([cc, cc, noaaA, noaaB]);
	expect(back[4]?.licence.name).toBe("");
});

test("etag: stable for the same body, matched plain, weak, gzip-suffixed or in a list", () => {
	const tag = strongEtag('{"a":1}');
	expect(strongEtag('{"a":1}')).toBe(tag);
	expect(strongEtag('{"a":2}')).not.toBe(tag);
	expect(etagMatches(tag, tag)).toBe(true);
	expect(etagMatches(`W/${tag}`, tag)).toBe(true);
	expect(etagMatches(`"x", ${tag.slice(0, -1)}-gz"`, tag)).toBe(true);
	expect(etagMatches('"other"', tag)).toBe(false);
	expect(etagMatches(null, tag)).toBe(false);
});
