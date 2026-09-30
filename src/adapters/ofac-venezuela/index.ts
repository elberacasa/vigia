import { Conditional } from "../../core/conditional.ts";
import type { Adapter, Observation } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { usEasternToMs } from "../../formats/time.ts";
import { OFAC_LICENCE, OFAC_VENEZUELA_PAGE } from "../ofac-sdn/index.ts";

/**
 * OFAC's "Venezuela-Related Sanctions" programme page: the general licences in force (number, revision letter, what
 * each authorises and the date OFAC issued that revision) and the latest Venezuela-related recent actions.
 *
 * Measured 2026-09-28: 93 KB of Drupal HTML, 8–11 s per request (the site is slow for every client), no validators
 * that change (`cache-control: no-cache, private`). 43 general licences listed, from GL 2A (5 Aug 2019) to GL 62
 * (21 Aug 2026); three were revised on 28 Sep 2026 (46E, 48D, 49B) and the page's newest recent action was that
 * day's "Issuance of Amended Venezuela General Licenses". robots.txt allows the page.
 *
 * Each list item reads "Venezuela General License 5Z - Authorizing … (September 16, 2026)": the date in parentheses
 * is the revision's issue date, which becomes `observedAt`, so a new revision is a new observation of the same
 * licence number. A list observation (`list`) records which licences the page shows, so one that expires or is
 * revoked (moved to OFAC's archive page) is noticed as missing.
 */

export type GeneralLicence = {
	readonly kind: "licence";
	/** "5Z": number and revision letter as OFAC writes them. */
	readonly id: string;
	readonly number: string;
	/** "" for the original, "A", "B", … "Z" for revisions. */
	readonly revision: string;
	/** OFAC's own description ("Authorizing Certain Transactions …"). */
	readonly title: string;
	/** "YYYY-MM-DD", the revision's issue date. */
	readonly issued: string;
	readonly url: string;
};

export type LicenceList = { readonly kind: "list"; readonly ids: string[] };

export type RecentAction = {
	readonly kind: "action";
	readonly title: string;
	/** "YYYY-MM-DD" (the release date OFAC prints). */
	readonly date: string;
	readonly url: string;
};

export type OfacVenezuelaValue = GeneralLicence | LicenceList | RecentAction;

const MONTHS: Readonly<Record<string, number>> = {
	January: 1,
	February: 2,
	March: 3,
	April: 4,
	May: 5,
	June: 6,
	July: 7,
	August: 8,
	September: 9,
	October: 10,
	November: 11,
	December: 12,
};

const ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	quot: '"',
	apos: "'",
	lt: "<",
	gt: ">",
	nbsp: " ",
};

export function plain(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
			if (e.startsWith("#x") || e.startsWith("#X"))
				return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
			if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
			return ENTITIES[e.toLowerCase()] ?? m;
		})
		.replace(/\s+/g, " ")
		.trim();
}

/** "(September 16, 2026)" at the end of a description → "2026-09-16". */
export function issueDate(text: string): string | null {
	const m =
		/\((January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})\)\s*$/.exec(
			text,
		);
	if (!m) return null;
	const month = MONTHS[m[1] ?? ""] ?? 0;
	const iso = `${m[3]}-${String(month).padStart(2, "0")}-${(m[2] ?? "").padStart(2, "0")}`;
	const d = new Date(`${iso}T00:00:00Z`);
	return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

// Measured variants: "7C </a>- …", a <div id="gl21"> wrapper inside the <li>, and plain "5Z</a> - …".
const LICENCE_ITEM =
	/<a href="([^"]+)"[^>]*>\s*Venezuela General License (\d+)([A-Z]{0,2})\s*<\/a>([\s\S]*?)<\/li>/g;
const ACTION_BLOCK = /Recent Actions regarding Venezuela-Related Sanctions<\/h3>([\s\S]*?)<\/ul>/;
const ACTION_ITEM =
	/<a href="(\/recent-actions\/[\w-]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<time datetime="(\d{4}-\d{2}-\d{2})T[^"]*"/g;

const absolute = (href: string) => new URL(href, "https://ofac.treasury.gov/").toString();
const etMidnight = (iso: string) =>
	usEasternToMs(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10)));

export function parseLicences(html: string): GeneralLicence[] {
	const out: GeneralLicence[] = [];
	for (const m of html.matchAll(LICENCE_ITEM)) {
		const description = plain(m[4] ?? "").replace(/^-\s*/, "");
		const issued = issueDate(description);
		if (!issued) continue;
		const number = m[2] ?? "";
		const revision = m[3] ?? "";
		out.push({
			kind: "licence",
			id: `${number}${revision}`,
			number,
			revision,
			title: description.replace(/\s*\([^()]*\d{4}\)\s*$/, ""),
			issued,
			url: absolute(m[1] ?? ""),
		});
	}
	return out;
}

export function parseActions(html: string): RecentAction[] {
	const block = ACTION_BLOCK.exec(html)?.[1];
	if (!block) return [];
	return [...block.matchAll(ACTION_ITEM)].map((m) => ({
		kind: "action",
		title: plain(m[2] ?? ""),
		date: m[3] ?? "",
		url: absolute(m[1] ?? ""),
	}));
}

const conditional = new Conditional();

export const ofacVenezuela: Adapter<OfacVenezuelaValue> = {
	id: "ofac-venezuela",
	layer: "society",
	name: { es: "Licencias generales de OFAC para Venezuela", en: "OFAC Venezuela general licences" },
	provider: "OFAC, US Department of the Treasury",
	homepage: OFAC_VENEZUELA_PAGE,
	licence: OFAC_LICENCE,
	keys: [],
	// Licences change a few times a month; every 6 h is plenty for a page that takes ~10 s to serve.
	intervalMs: 6 * 3_600_000,
	// Event-like (no new licence for weeks is normal): stale only when the page cannot be read for two days.
	freshness: { fetchMs: 48 * 3_600_000, dataMs: null },

	async fetch(ctx) {
		const raw = await ctx.http.request(OFAC_VENEZUELA_PAGE, {
			headers: { accept: "text/html", ...conditional.headers() },
			okStatuses: conditional.okStatuses(),
			hostGapMs: 5_000,
			timeoutMs: 45_000,
			maxBytes: 4 * 1024 * 1024,
			signal: ctx.signal,
		});
		conditional.remember(raw, () => ofacVenezuela.normalise([raw]));
		return [raw];
	},

	normalise(raws) {
		const raw = raws[0];
		if (!raw) throw new SchemaError("no response");
		if (raw.status === 304) return [];
		if (!/Venezuela-Related Sanctions/.test(raw.body))
			throw new SchemaError("OFAC: no es la página de Venezuela");
		const licences = parseLicences(raw.body);
		if (licences.length < 5)
			throw new SchemaError(`OFAC: solo ${licences.length} licencias generales legibles`);
		const actions = parseActions(raw.body);
		const base = {
			source: "ofac-venezuela",
			fetchedAt: raw.fetchedAt,
			licence: OFAC_LICENCE.id,
			confidence: 1,
			basis: "official" as const,
		};
		const out: Observation<OfacVenezuelaValue>[] = [];
		const latestAllowed = raw.fetchedAt + 86_400_000;
		for (const l of licences) {
			const observedAt = etMidnight(l.issued);
			if (observedAt > latestAllowed) continue;
			out.push({ ...base, series: `gl:${l.number}`, sourceUrl: l.url, observedAt, value: l });
		}
		for (const a of actions) {
			const observedAt = etMidnight(a.date);
			if (!Number.isFinite(observedAt) || observedAt > latestAllowed) continue;
			out.push({
				...base,
				series: `action:${a.url.split("/").pop()}`,
				sourceUrl: a.url,
				observedAt,
				value: a,
			});
		}
		// The list is dated by the newest licence revision: a licence dropped from the page without a new one issued
		// yields a new list row at the same time (different content), and the newest row wins.
		const newest = Math.max(...out.filter((o) => o.value.kind === "licence").map((o) => o.observedAt));
		out.push({
			...base,
			series: "list",
			sourceUrl: OFAC_VENEZUELA_PAGE,
			observedAt: newest,
			value: { kind: "list", ids: licences.map((l) => l.id) },
		});
		return out;
	},
};
