import { createHash } from "node:crypto";
import { HEADLINE_LICENCE, type NewsItem, type OutletSpec, parseFeed } from "../adapters/rss/factory.ts";
import { OUTLETS } from "../adapters/rss/outlets.ts";
import { type Adapter, HttpError, type Observation, SchemaError } from "../core/types.ts";
import { stateByIso } from "../geo/index.ts";
import { stripHtml } from "../news/text.ts";
import { checkFeedUrl, type SafeHttp } from "./net.ts";
import { type AddFeed, AddFeedSchema, USER_FEED_LIMIT, type UserFeed } from "./schema.ts";

/**
 * "Mis fuentes": RSS/Atom feeds the user adds by hand. Each one becomes an adapter like a built-in outlet (same
 * parser, store, scheduler, breaker, health and status page), with three differences:
 *
 * - it is fetched through SafeHttp (src/userfeeds/net.ts), never the shared client, because its URL is user input;
 * - it is labelled "añadida por ti" everywhere it appears (stance "user", `mine: true` in /api/meta);
 * - its headlines feed only the "Mis fuentes" panel (`user-news`): Vigía's own totals, map layer, incidents and
 *   brief keep using the reviewed outlet list, so a hand-added feed never changes a figure Vigía states.
 *
 * The list lives in config.json; removing a feed stops fetching it (headlines already stored stay in the local
 * archive, which is append-only and sealed).
 */

export interface UserFeedStore {
	list(): readonly UserFeed[];
	save(next: readonly UserFeed[]): void;
}

export interface FeedScheduler {
	add(adapter: Adapter): void;
	replace(adapter: Adapter): void;
	remove(id: string): void;
	trigger(id: string): void;
}

export type AddResult =
	| {
			ok: true;
			feed: UserFeed;
			/** What the test fetch found: headline count, newest dated item, and the feed's own title. */
			preview: { items: number; newestAt: number | null; title: string | null };
	  }
	| { ok: false; status: 400 | 409 | 422; reason: string };

const MIN = 60_000;

export function userFeedId(url: string): string {
	return `mia-${createHash("sha256").update(canonicalUrl(url)).digest("hex").slice(0, 10)}`;
}

/**
 * The comparison form of a feed URL: the same feed over http or https, with or without "www.", with or without a
 * trailing slash or a fragment, is one feed.
 */
export function canonicalUrl(raw: string): string {
	try {
		const u = new URL(raw.trim());
		const host = u.hostname.toLowerCase().replace(/^www\./, "");
		const port = u.port && u.port !== "80" && u.port !== "443" ? `:${u.port}` : "";
		return `${host}${port}${u.pathname.replace(/\/+$/, "")}${u.search}`;
	} catch {
		return raw.trim();
	}
}

export function outletOf(feed: UserFeed): OutletSpec {
	let homepage = feed.url;
	try {
		homepage = `${new URL(feed.url).origin}/`;
	} catch {
		// keep the URL
	}
	return {
		id: feed.id,
		name: feed.name,
		url: feed.url,
		kind: "rss",
		region: feed.region,
		stance: "user",
		homepage,
		intervalMs: feed.intervalMin * MIN,
	};
}

/** The feed's own title (channel or feed <title>), for a default name. */
export function feedTitle(body: string): string | null {
	const head = body.slice(0, 20_000);
	const m = /<(?:channel|feed)\b[^>]*>[\s\S]*?<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head);
	if (!m?.[1]) return null;
	const text = stripHtml(m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")).trim();
	return text ? text.slice(0, 80) : null;
}

function assertFeedBody(body: string): void {
	if (/^\s*<!doctype html|^\s*<html/i.test(body)) {
		throw new SchemaError("la dirección devolvió una página HTML, no un feed");
	}
}

/** Items kept per run of a user's feed (the newest), and the longest title and link kept (review 4 L4). */
export const MAX_USER_ITEMS = 200;
export const MAX_USER_TITLE = 300;
export const MAX_USER_LINK = 2_048;

/**
 * A hand-added feed is untrusted: a 2 MB feed parsed to 12,000 items with titles of up to ~2 MB, all headed for the
 * sealed, append-only archive. Keep the newest MAX_USER_ITEMS, titles cut at MAX_USER_TITLE characters (with "…"),
 * and drop items whose link is longer than MAX_USER_LINK.
 */
export function capUserItems(items: Observation<NewsItem>[]): Observation<NewsItem>[] {
	return items
		.filter((o) => o.value.link.length <= MAX_USER_LINK)
		.sort((a, b) => b.observedAt - a.observedAt)
		.slice(0, MAX_USER_ITEMS)
		.map((o) =>
			o.value.title.length > MAX_USER_TITLE
				? {
						...o,
						value: {
							...o.value,
							title: `${[...o.value.title]
								.slice(0, MAX_USER_TITLE - 1)
								.join("")
								.trimEnd()}…`,
						},
					}
				: o,
		);
}

export function userFeedAdapter(feed: UserFeed, http: SafeHttp): Adapter<NewsItem> {
	const outlet = outletOf(feed);
	const intervalMs = feed.intervalMin * MIN;
	return {
		id: feed.id,
		layer: "news",
		name: { es: `${feed.name} (añadida por ti)`, en: `${feed.name} (added by you)` },
		provider: feed.name,
		homepage: outlet.homepage,
		licence: HEADLINE_LICENCE,
		keys: [],
		intervalMs,
		freshness: { fetchMs: 4 * intervalMs, dataMs: 14 * 24 * 60 * MIN },
		async fetch(ctx) {
			const raw = await http.get(feed.url, ctx.signal);
			assertFeedBody(raw.body);
			return [raw];
		},
		normalise(raws) {
			const raw = raws[0];
			if (!raw) throw new SchemaError("sin respuesta");
			return capUserItems(parseFeed(raw.body, outlet, raw.fetchedAt, { untrusted: true }));
		},
	};
}

export class UserFeeds {
	readonly #store: UserFeedStore;
	readonly #http: SafeHttp;
	readonly #now: () => number;
	#scheduler: FeedScheduler | null = null;
	readonly #builtinUrls: Map<string, string>;

	constructor(store: UserFeedStore, http: SafeHttp, now: () => number = Date.now, builtins = OUTLETS) {
		this.#store = store;
		this.#http = http;
		this.#now = now;
		this.#builtinUrls = new Map(builtins.map((o) => [canonicalUrl(o.url), o.name]));
	}

	/** Connects the scheduler once it exists (it is built from `adapters()`). */
	attach(scheduler: FeedScheduler): void {
		this.#scheduler = scheduler;
	}

	list(): readonly UserFeed[] {
		return this.#store.list();
	}

	isMine(id: string): boolean {
		return this.#store.list().some((f) => f.id === id);
	}

	/**
	 * The feeds as outlets. Two feeds of one site (a section and the front page) are one publisher, so "N medios"
	 * counts sites, as it does for Vigía's own outlets: the first feed added from a host is the publisher.
	 */
	outlets(): OutletSpec[] {
		const first = new Map<string, string>();
		return this.#store.list().map((f) => {
			const o = outletOf(f);
			const host = canonicalUrl(f.url).split("/")[0] ?? f.id;
			const main = first.get(host);
			if (!main) first.set(host, f.id);
			return main ? { ...o, publisher: main } : o;
		});
	}

	adapters(): Adapter[] {
		return this.#store.list().map((f) => userFeedAdapter(f, this.#http) as Adapter);
	}

	/** Checks, fetches once, parses, then saves and schedules. Nothing is saved unless the feed parses with items. */
	async add(input: unknown, signal?: AbortSignal): Promise<AddResult> {
		const parsed = AddFeedSchema.safeParse(input);
		if (!parsed.success)
			return { ok: false, status: 400, reason: "Datos no válidos para añadir una fuente." };
		const body: AddFeed = parsed.data;
		if (body.region?.startsWith("VE-") && !stateByIso(body.region))
			return { ok: false, status: 400, reason: "Estado desconocido." };
		const check = checkFeedUrl(body.url);
		if (!check.ok) return { ok: false, status: 400, reason: check.reason };
		const url = check.url.toString();
		const current = this.#store.list();
		if (current.length >= USER_FEED_LIMIT)
			return { ok: false, status: 409, reason: `Puedes tener hasta ${USER_FEED_LIMIT} fuentes propias.` };
		const id = userFeedId(url);
		if (current.some((f) => f.id === id))
			return { ok: false, status: 409, reason: "Ya añadiste esa fuente." };
		const builtin = this.#builtinUrls.get(canonicalUrl(url));
		if (builtin) return { ok: false, status: 409, reason: `Vigía ya sigue ese feed: ${builtin}.` };

		let raw: Awaited<ReturnType<SafeHttp["get"]>>;
		try {
			raw = await this.#http.get(url, signal);
			assertFeedBody(raw.body);
		} catch (error) {
			const reason =
				error instanceof HttpError || error instanceof SchemaError ? error.message : "error de red";
			return { ok: false, status: 422, reason: `No se pudo leer el feed: ${reason}.` };
		}
		const title = feedTitle(raw.body);
		const draft: UserFeed = {
			id,
			url,
			name: body.name?.trim() || title || check.url.hostname,
			region: body.region ?? "national",
			intervalMin: body.intervalMin ?? 30,
			addedAt: this.#now(),
		};
		let items: ReturnType<typeof parseFeed>;
		try {
			items = capUserItems(parseFeed(raw.body, outletOf(draft), raw.fetchedAt, { untrusted: true }));
		} catch (error) {
			const reason = error instanceof Error ? error.message : "formato desconocido";
			return { ok: false, status: 422, reason: `No es un feed RSS o Atom (${reason}).` };
		}
		if (!items.length)
			return {
				ok: false,
				status: 422,
				reason: "El feed no tiene titulares con enlace: ¿es la dirección correcta?",
			};
		// Re-read before saving: another add may have finished while this one was fetching.
		const latest = this.#store.list();
		if (latest.some((f) => f.id === id)) return { ok: false, status: 409, reason: "Ya añadiste esa fuente." };
		if (latest.length >= USER_FEED_LIMIT)
			return { ok: false, status: 409, reason: `Puedes tener hasta ${USER_FEED_LIMIT} fuentes propias.` };
		this.#store.save([...latest, draft]);
		this.#scheduler?.add(userFeedAdapter(draft, this.#http) as Adapter);
		this.#scheduler?.trigger(id);
		const dated = items.filter((o) => !o.value.dateMissing).map((o) => o.observedAt);
		return {
			ok: true,
			feed: draft,
			preview: { items: items.length, newestAt: dated.length ? Math.max(...dated) : null, title },
		};
	}

	/** Name, region and interval can change; the URL cannot (remove and add instead). */
	update(
		id: string,
		patch: unknown,
	): { ok: true; feed: UserFeed } | { ok: false; status: 400 | 404; reason: string } {
		const current = this.#store.list();
		const feed = current.find((f) => f.id === id);
		if (!feed) return { ok: false, status: 404, reason: "Fuente desconocida." };
		const parsed = AddFeedSchema.omit({ url: true }).safeParse(patch);
		if (!parsed.success) return { ok: false, status: 400, reason: "Datos no válidos." };
		const p = parsed.data;
		if (p.region?.startsWith("VE-") && !stateByIso(p.region))
			return { ok: false, status: 400, reason: "Estado desconocido." };
		const next: UserFeed = {
			...feed,
			...(p.name?.trim() ? { name: p.name.trim() } : {}),
			...(p.region ? { region: p.region } : {}),
			...(p.intervalMin ? { intervalMin: p.intervalMin } : {}),
		};
		this.#store.save(current.map((f) => (f.id === id ? next : f)));
		this.#scheduler?.replace(userFeedAdapter(next, this.#http) as Adapter);
		return { ok: true, feed: next };
	}

	remove(id: string): boolean {
		const current = this.#store.list();
		if (!current.some((f) => f.id === id)) return false;
		this.#store.save(current.filter((f) => f.id !== id));
		this.#scheduler?.remove(id);
		return true;
	}

	/** /api/meta fields for a user feed (the sources atlas shape, plus `mine`). */
	meta(feed: UserFeed): Record<string, string | boolean | string[] | null> {
		let host = feed.url;
		try {
			host = new URL(feed.url).hostname.replace(/^www\./, "");
		} catch {
			// keep
		}
		return {
			category: ["news"],
			kind: "feed",
			region: feed.region === "national" ? "VE" : feed.region === "international" ? "intl" : feed.region,
			country: feed.region === "international" ? "INT" : "VE",
			lang: null,
			publisher: host,
			added: `${new Date(feed.addedAt).toISOString().slice(0, 16)}Z`,
			stance: "user",
			panels: ["user-news"],
			mine: true,
		};
	}
}
