import { z } from "zod";
import { SchemaError } from "../../core/types.ts";
import { plainlyPrivateUrl } from "../../media/public-host.ts";

/**
 * iptv-org's public database (github.com/iptv-org/api, public domain), reduced to the TV streams that concern
 * Venezuela and classified by a stated rule. Pure: the adapter fetches the four files, this decides.
 *
 * Measured 2026-09-28 (iptv-org.github.io/api, GitHub Pages, ETag + Last-Modified, rebuilt daily ~00:20 UTC):
 * channels.json 7.9 MB (1.0 MB gzip, 31,404 channels), feeds.json 8.0 MB (0.63 MB gzip), streams.json 3.7 MB
 * (0.59 MB gzip, 17,719 streams), blocklist.json 150 KB (1,440 entries: 1,073 DMCA, 367 NSFW). 197 channels are
 * Venezuelan; 129 streams concern Venezuela (84 of Venezuelan channels, the rest foreign channels whose feed lists
 * Venezuela as a broadcast area).
 *
 * The rule (in this order; the first that applies decides):
 * 1. closed      the channel closed or was replaced (iptv-org `closed` / `replaced_by`).
 * 2. nsfw        iptv-org marks it adult (`is_nsfw`), or its blocklist does ("nsfw").
 * 3. dmca        on iptv-org's blocklist after a copyright claim.
 * 4. foreign-pay a foreign channel listed for Venezuela: it reaches Venezuela by cable or satellite, so a stream
 *                of it here is a relay of a pay channel (a hard line of the project: no pay-TV restreams).
 *                Disney, FX, MTV, Cinecanal…
 * 5. pay-ve      a Venezuelan subscription channel (PAY_VE below, each with the reference that says so).
 * 6. spoofed     the stream only plays when the player pretends to be another site or browser (iptv-org
 *                `referrer` / `user_agent`): that is getting around the host's hotlink protection (a hard line:
 *                no bypassing access controls).
 * 7. relay-host  the stream is served from a bare IP address that, across iptv-org's whole list, carries channels
 *                of two or more countries, or from any host that also serves a pay channel excluded above: a
 *                cable head-end or IPTV operator re-broadcasting, not the broadcaster's own server. Measured: 181.78.8.199:8000 carries Globovisión, Venevisión, ANTV and Meridiano next to
 *                AXN, Disney Channel and NTN24; 38.134.250.110:8000 carries Televen next to four Colombian channels.
 * Otherwise on: a Venezuelan channel's stream from its own server or its streaming provider (streamlock, myplaytv,
 * fastchannel…), which is how regional free-to-air stations publish.
 */

export type IptvReason =
	| "closed"
	| "nsfw"
	| "dmca"
	| "foreign-pay"
	| "pay-ve"
	| "spoofed"
	| "relay-host"
	| "not-public";

export const REASON_TEXT: Readonly<Record<IptvReason, { es: string; en: string }>> = {
	closed: { es: "canal cerrado", en: "channel closed" },
	nsfw: { es: "contenido para adultos", en: "adult content" },
	dmca: {
		es: "retirado de iptv-org por reclamo de derechos",
		en: "removed by iptv-org after a copyright claim",
	},
	"foreign-pay": {
		es: "canal extranjero que llega a Venezuela por cable o satélite (TV de pago)",
		en: "foreign channel that reaches Venezuela by cable or satellite (pay TV)",
	},
	"pay-ve": { es: "canal venezolano por suscripción", en: "Venezuelan subscription channel" },
	spoofed: {
		es: "solo se reproduce simulando otro sitio o navegador (protección del servidor)",
		en: "plays only when the player pretends to be another site or browser (host protection)",
	},
	"relay-host": {
		es: "retransmitido desde una IP que reemite canales de varios países (cabecera de cable), no por la televisora",
		en: "re-broadcast from an IP that relays several countries' channels (a cable head-end), not by the broadcaster",
	},
	"not-public": {
		es: "la dirección no es un servidor público de internet (red local o no es http)",
		en: "the address is not a public internet server (a local network, or not http)",
	},
};

/**
 * Venezuelan subscription channels, each with the reference read on 2026-09-28. Italianissimo, Plous TV (Grupo Lorini)
 * and Venevisión Internacional stay on: no reference found says they are pay channels (decided 2026-09-28, default
 * yes); a cited one would add them here.
 */
export const PAY_VE: Readonly<Record<string, string>> = {
	"VePlus.ve": "es.wikipedia «Ve Plus»: «canal de televisión por suscripción … operado por Cisneros Media»",
	"SunChannel.ve":
		"es.wikipedia «Sun Channel»: «canal de televisión por suscripción latinoamericano de origen venezolano»",
	"eSportsMaxTV.ve":
		"es.wikipedia «Esports Max»: «canal de televisión por suscripción y televisión por Internet»",
	"MAXAnime.ve": "es.wikipedia «Max Anime»: «canal de televisión por suscripción y televisión por Internet»",
};

/** Owners (iptv-org `owners`) that make a channel state media. Only this label is kept: owner names are not stored. */
const STATE_OWNERS: readonly RegExp[] = [
	/Sistema Bolivariano de Comunicaci[oó]n/i,
	/National Assembly of Venezuela|Asamblea Nacional/i,
	/Compa[ñn][ií]a An[oó]nima Nacional de Tel[eé]fonos|\bCANTV\b/i,
	/Ministerio del Poder Popular|Gobernaci[oó]n|Alcald[ií]a/i,
];
/** State channels by iptv-org id (checked 2026-09-28), labelled even if a later list omits the `owners` field. */
const STATE_IDS = new Set([
	"VenezolanadeTelevision.ve",
	"TVes.ve",
	"Vive.ve",
	"AvilaTV.ve",
	"Colombeia.ve",
	"ConCienciaTV.ve",
	"AlbaTV.ve",
	"CanalCulturaVenezuela.ve",
	"TVFANB.ve",
	"ANTV.ve",
	"123TV.ve",
]);
/** teleSUR: a multi-state channel funded mainly by the Venezuelan state (the youtube-live label). */
const STATE_FUNDED_IDS = new Set(["Telesur.ve"]);

export type IptvOwnership = "state" | "state-funded" | "other";

/**
 * Regional channels iptv-org lists as country-wide (`c/VE`) but that serve one state, with why. iptv-org's own
 * `s/VE-…` and city areas win when present.
 */
export const REGION_VE: Readonly<
	Record<string, { readonly states: readonly string[]; readonly why: string }>
> = {
	"AnzoateguiTV.ve": { states: ["VE-B"], why: "nombre del canal" },
	"BarinasTV.ve": { states: ["VE-E"], why: "nombre del canal" },
	"Canal21Tachira.ve": { states: ["VE-S"], why: "nombre del canal" },
	"MonagasVision.ve": { states: ["VE-N"], why: "nombre del canal" },
	"PortuguesaTelevision.ve": { states: ["VE-P"], why: "nombre del canal" },
	"Telebocono.ve": { states: ["VE-T"], why: "nombre del canal (Boconó, Trujillo)" },
	"TRT.ve": { states: ["VE-S"], why: "es.wikipedia: sede en San Cristóbal, Táchira" },
	"PromarTV.ve": { states: ["VE-K"], why: "es.wikipedia: sede en Barquisimeto, Lara" },
	"LatinaTV.ve": { states: ["VE-K"], why: "es.wikipedia: sede en Barquisimeto, Lara" },
	"Telecentro.ve": { states: ["VE-K"], why: "es.wikipedia: sede en Barquisimeto, Lara" },
	"TAMTV.ve": { states: ["VE-L"], why: "tamtv.com.ve, Televisora Andina de Mérida (es.wikipedia)" },
	"TelevisoradeOriente.ve": {
		states: ["VE-B", "VE-N", "VE-R", "VE-O"],
		why: "es.wikipedia: emite para Anzoátegui, Monagas, Sucre y Nueva Esparta",
	},
};

/** iptv-org city codes (UN/LOCODE) in Venezuela used by feeds, to their state (iptv-org cities.json, public domain). */
const VE_CITY: Readonly<Record<string, string>> = {
	VECCS: "VE-A",
	VEBLA: "VE-B",
	VEPCZ: "VE-B",
	VEMYC: "VE-D",
	VEBNS: "VE-E",
	VECBL: "VE-F",
	VECGU: "VE-F",
	VEVLN: "VE-G",
	VEPBL: "VE-G",
	VECZE: "VE-I",
	VEPFI: "VE-I",
	VEBRM: "VE-K",
	VEMRD: "VE-L",
	VELTQ: "VE-M",
	VEMUN: "VE-N",
	VEPMV: "VE-O",
	VEGUQ: "VE-P",
	VECUM: "VE-R",
	VESCI: "VE-S",
	VEVLV: "VE-T",
	VESNF: "VE-U",
	VEMAR: "VE-V",
	VELAG: "VE-X",
	VETUV: "VE-Y",
	VEPYH: "VE-Z",
};

const Channel = z.object({
	id: z.string().min(1),
	name: z.string(),
	owners: z.array(z.string()).default([]),
	country: z.string(),
	categories: z.array(z.string()).default([]),
	is_nsfw: z.boolean().default(false),
	closed: z.string().nullable().default(null),
	replaced_by: z.string().nullable().default(null),
	website: z.string().nullable().default(null),
});
const Feed = z.object({
	channel: z.string(),
	id: z.string(),
	is_main: z.boolean().default(false),
	broadcast_area: z.array(z.string()).default([]),
	languages: z.array(z.string()).default([]),
});
const Stream = z.object({
	channel: z.string().nullable(),
	feed: z.string().nullable().default(null),
	title: z.string().default(""),
	url: z.string().min(8),
	quality: z.string().nullable().default(null),
	labels: z.array(z.string()).default([]),
	user_agent: z.string().nullable().default(null),
	referrer: z.string().nullable().default(null),
});
const Block = z.object({ channel: z.string(), reason: z.string() });

/** One stream in the Venezuela directory. A `type` alias so it is JSON-assignable. */
export type IptvEntry = {
	/** Stable id: `<channel>/<feed>/<url hash>`; the series is `iptv:<key>`. */
	readonly key: string;
	readonly channel: string;
	readonly feed: string | null;
	readonly name: string;
	readonly url: string;
	readonly https: boolean;
	readonly quality: string | null;
	readonly categories: string[];
	/** iptv-org's "Not 24/7" label: the channel is not always on air. */
	readonly notAlways: boolean;
	/** iptv-org's "Geo-blocked" label. */
	readonly geoBlocked: boolean;
	readonly country: string;
	/** ISO 3166-2 states the channel serves, when known; empty for national or unknown. */
	readonly states: string[];
	readonly statesFrom: "iptv-org" | "vigia" | null;
	readonly ownership: IptvOwnership;
	readonly website: string | null;
	readonly status: "on" | "excluded";
	readonly reason: IptvReason | null;
	/** For "pay-ve", the reference; for "relay-host", the host. */
	readonly reasonDetail: string | null;
};

export type IptvCatalog = { readonly entries: readonly IptvEntry[]; readonly streamsTotal: number };

function parseArray<T>(body: string, schema: z.ZodType<T>, name: string, min: number): T[] {
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		throw new SchemaError(`iptv-org ${name}: JSON no válido`);
	}
	if (!Array.isArray(json) || json.length < min)
		throw new SchemaError(`iptv-org ${name}: se esperaba una lista de al menos ${min}`);
	const out: T[] = [];
	for (const item of json) {
		const parsed = schema.safeParse(item);
		if (parsed.success) out.push(parsed.data);
	}
	return out;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
function hostOf(url: string): { host: string; hostname: string } | null {
	try {
		const u = new URL(url);
		return { host: u.host, hostname: u.hostname };
	} catch {
		return null;
	}
}

function coversVenezuela(area: readonly string[]): boolean {
	return area.some((a) => a === "c/VE" || a.startsWith("s/VE-") || a.startsWith("ct/VE"));
}

function statesFromArea(area: readonly string[]): string[] {
	const out = new Set<string>();
	for (const a of area) {
		if (a.startsWith("s/VE-")) out.add(a.slice(2));
		else if (a.startsWith("ct/VE")) {
			const iso = VE_CITY[a.slice(3)];
			if (iso) out.add(iso);
		}
	}
	return [...out].sort();
}

export function ownershipOf(channel: { id: string; owners: readonly string[] }): IptvOwnership {
	if (STATE_FUNDED_IDS.has(channel.id)) return "state-funded";
	if (STATE_IDS.has(channel.id) || channel.owners.some((o) => STATE_OWNERS.some((re) => re.test(o))))
		return "state";
	return "other";
}

export type CatalogFiles = { channels: string; feeds: string; streams: string; blocklist: string };

/** Pure: the four iptv-org files → the classified Venezuela directory, sorted by channel name then key. */
export function buildCatalog(files: CatalogFiles): IptvCatalog {
	const channels = new Map(parseArray(files.channels, Channel, "channels", 100).map((c) => [c.id, c]));
	const feeds = parseArray(files.feeds, Feed, "feeds", 100);
	const streams = parseArray(files.streams, Stream, "streams", 100);
	const blocked = new Map(
		parseArray(files.blocklist, Block, "blocklist", 1).map((b) => [b.channel, b.reason]),
	);
	const feedBy = new Map(feeds.map((f) => [`${f.channel}\u0000${f.id}`, f]));
	const mainFeed = new Map<string, z.infer<typeof Feed>>();
	for (const f of feeds) if (f.is_main || !mainFeed.has(f.channel)) mainFeed.set(f.channel, f);

	// Countries each bare-IP host carries, across the whole list (rule 7).
	const hostCountries = new Map<string, Set<string>>();
	for (const s of streams) {
		const h = hostOf(s.url);
		const c = s.channel ? channels.get(s.channel) : undefined;
		if (!h || !c || !IPV4.test(h.hostname)) continue;
		const set = hostCountries.get(h.host) ?? new Set<string>();
		set.add(c.country);
		hostCountries.set(h.host, set);
	}

	const seen = new Set<string>();
	const payHosts = new Set<string>();
	const entries: IptvEntry[] = [];
	for (const s of streams) {
		if (!s.channel) continue;
		const c = channels.get(s.channel);
		if (!c) continue;
		const feed = (s.feed ? feedBy.get(`${s.channel}\u0000${s.feed}`) : undefined) ?? mainFeed.get(s.channel);
		const area = feed?.broadcast_area ?? [];
		if (c.country !== "VE" && !coversVenezuela(area)) continue;
		const h = hostOf(s.url);
		if (!h || seen.has(s.url)) continue;
		seen.add(s.url);

		let reason: IptvReason | null = null;
		let detail: string | null = null;
		const block = blocked.get(c.id);
		if (plainlyPrivateUrl(s.url)) reason = "not-public";
		else if (c.closed !== null || c.replaced_by !== null) reason = "closed";
		else if (c.is_nsfw || block === "nsfw") reason = "nsfw";
		else if (block !== undefined) reason = "dmca";
		else if (c.country !== "VE") reason = "foreign-pay";
		else if (PAY_VE[c.id]) {
			reason = "pay-ve";
			detail = PAY_VE[c.id] ?? null;
		} else if (s.referrer !== null || s.user_agent !== null) reason = "spoofed";
		else if ((hostCountries.get(h.host)?.size ?? 0) >= 2) {
			reason = "relay-host";
			detail = h.host;
		}
		if (reason === "foreign-pay" || reason === "pay-ve") payHosts.add(h.host);

		const fromArea = statesFromArea(area);
		const curated = REGION_VE[c.id];
		const states = fromArea.length ? fromArea : curated ? [...curated.states] : [];
		entries.push({
			key: `${c.id}/${s.feed ?? feed?.id ?? "-"}/${Bun.hash(s.url).toString(36)}`,
			channel: c.id,
			feed: s.feed ?? feed?.id ?? null,
			name: c.name,
			url: s.url,
			https: s.url.startsWith("https://"),
			quality: s.quality,
			categories: c.categories,
			notAlways: s.labels.includes("Not 24/7"),
			geoBlocked: s.labels.includes("Geo-blocked"),
			country: c.country,
			states,
			statesFrom: fromArea.length ? "iptv-org" : curated ? "vigia" : null,
			ownership: ownershipOf(c),
			website: c.website,
			status: reason === null ? "on" : "excluded",
			reason,
			reasonDetail: detail,
		});
	}
	// Rule 7, second half: a host that also serves a pay channel in this directory is a relay, whatever its name
	// (measured: bantel-cdn1.iptvperu.tv carries teleSUR next to Star Channel and 30 others).
	const out = entries.map((e): IptvEntry => {
		const host = hostOf(e.url)?.host ?? "";
		return e.status === "on" && payHosts.has(host)
			? { ...e, status: "excluded", reason: "relay-host", reasonDetail: host }
			: e;
	});
	out.sort((a, b) => a.name.localeCompare(b.name, "es") || a.key.localeCompare(b.key));
	return { entries: out, streamsTotal: streams.length };
}

/** Why a region was set by Vigía (shown next to the state). */
export function regionWhy(channel: string): string | null {
	return REGION_VE[channel]?.why ?? null;
}
