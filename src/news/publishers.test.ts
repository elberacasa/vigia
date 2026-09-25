import { expect, test } from "bun:test";
import { OUTLETS } from "../adapters/rss/outlets.ts";
import { publisherOf } from "./publishers.ts";

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
/** "Efecto Cocuyo (YouTube)" and "Efecto Cocuyo" are one name; "El Tiempo (Anzoátegui)" and "(Colombia)" are not. */
const nameKey = (name: string) =>
	fold(name)
		.replace(/\((youtube|telegram)\)/g, "")
		.replace(/[^a-z0-9]+/g, "");
/** The publisher's site; a YouTube or Telegram channel page says nothing about who publishes it. */
const siteKey = (url: string) => {
	const host = new URL(url).hostname.replace(/^www\./, "");
	return /(^|\.)youtube\.com$|^youtu\.be$|^t\.me$/.test(host) ? null : host;
};

test("review 4 M4: feeds of one outlet (same id but the yt-/tg- prefix, same name, same site) declare one publisher", () => {
	const groups = new Map<string, string[]>();
	const add = (key: string, id: string) => groups.set(key, [...(groups.get(key) ?? []), id]);
	for (const o of OUTLETS) {
		add(`id ${o.id.replace(/^(yt|tg)-/, "")}`, o.id);
		add(`name ${nameKey(o.name)}`, o.id);
		const site = siteKey(o.homepage);
		if (site) add(`site ${site}`, o.id);
	}
	const unlinked = [...groups]
		.filter(([, ids]) => new Set(ids.map((id) => publisherOf(id).id)).size > 1)
		.map(([key, ids]) => `${key}: ${ids.map((id) => `${id} -> ${publisherOf(id).id}`).join(", ")}`);
	expect(unlinked).toEqual([]);
});

test("review 4 M4: Efecto Cocuyo's and VPItv's YouTube channels count as the same medio as their sites", () => {
	expect(publisherOf("yt-efecto-cocuyo").id).toBe("efecto-cocuyo");
	expect(publisherOf("yt-vpitv").id).toBe("vpitv");
});
