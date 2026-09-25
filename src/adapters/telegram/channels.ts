/**
 * Public Telegram channels Vigía reads by default (kind "telegram", read from https://t.me/s/<handle>).
 *
 * Only outlets, institutions and NGOs, never a person's own channel. Each was verified on 2026-09-25 from this
 * machine: the preview answers 200 with posts from that week, and the channel is the outlet's own (its site links
 * to it, or its posts link to the outlet's domain and its description names it). A channel of an outlet Vigía
 * already reads counts as that outlet (`publisher`), never as a second, independent voice. Stances follow the
 * outlet list's; state media are labelled "estatal".
 *
 * Checked and left out (302, no preview or dormant): efectococuyo, talcualdigital, elnacionalweb, NTN24ve (newest
 * post December 2025), caraotadigital, lapatilla, globovision, monitoreamos, vesinfiltro, provea (newest 2023),
 * elestimulo (newest 2024), BCV_ORG_VE (one post, 2025), Minsalud_ve (not linked from mpps.gob.ve), NetBlocks
 * (Venezuela rarely; the internet panels measure it directly), and personal channels of politicians.
 */
import type { OutletSpec } from "../rss/factory.ts";

const MIN = 60_000;

/** On by default, with this note on /fuentes and a switch in the guide. */
export const TELEGRAM_NOTE = {
	es: "Vista pública del canal en Telegram (t.me/s), leída una página cada 15 minutos o más por decisión del proyecto.",
	en: "The channel's public Telegram preview (t.me/s), read one page every 15 minutes or more by the project's decision.",
} as const;

type Channel = Omit<OutletSpec, "kind" | "url" | "homepage" | "note"> & { readonly handle: string };

const CHANNELS: readonly Channel[] = [
	// About 100–300 posts a day each (measured 2026-09-24/25): read every 15 minutes.
	{
		id: "tg-ultimas-noticias",
		handle: "UNoticias",
		name: "Últimas Noticias (Telegram)",
		region: "national",
		stance: "state-aligned",
		intervalMs: 15 * MIN,
	},
	{
		id: "tg-vtv",
		handle: "vtv_canal8",
		name: "VTV (Telegram)",
		region: "national",
		stance: "state",
		publisher: "vtv",
		intervalMs: 15 * MIN,
	},
	{
		id: "tg-telesur",
		handle: "teleSUR_tv",
		name: "teleSUR (Telegram)",
		region: "international",
		stance: "state",
		publisher: "telesur",
		onlyVenezuela: true,
		intervalMs: 15 * MIN,
	},
	// Tens of posts a day.
	{
		id: "tg-banca-y-negocios",
		handle: "bancaynegocios",
		name: "Banca y Negocios (Telegram)",
		region: "national",
		stance: "independent",
		intervalMs: 20 * MIN,
	},
	{
		id: "tg-el-diario",
		handle: "eldiario",
		name: "El Diario (Telegram)",
		region: "national",
		stance: "independent",
		publisher: "el-diario",
		intervalMs: 20 * MIN,
	},
	{
		id: "tg-runrunes",
		handle: "runrunes",
		name: "Runrunes (Telegram)",
		region: "national",
		stance: "independent",
		publisher: "runrunes",
		intervalMs: 30 * MIN,
	},
	{
		id: "tg-el-pitazo",
		handle: "elpitazo",
		name: "El Pitazo (Telegram)",
		region: "national",
		stance: "independent",
		publisher: "el-pitazo",
		intervalMs: 30 * MIN,
	},
	{
		id: "tg-prensa-presidencial",
		handle: "prensapresidencial",
		name: "Prensa Presidencial (Telegram)",
		region: "national",
		stance: "state",
		genre: "official",
		intervalMs: 30 * MIN,
	},
	// A few posts a day or fewer.
	{
		id: "tg-cronica-uno",
		handle: "cronicauno",
		name: "Crónica.Uno (Telegram)",
		region: "national",
		stance: "independent",
		publisher: "cronica-uno",
		intervalMs: 60 * MIN,
	},
	{
		id: "tg-vpitv",
		handle: "vpitv",
		name: "VPItv (Telegram)",
		region: "national",
		stance: "commercial",
		publisher: "vpitv",
		intervalMs: 60 * MIN,
	},
];

export const TELEGRAM_CHANNELS: readonly OutletSpec[] = CHANNELS.map(({ handle, ...c }) => ({
	...c,
	kind: "telegram" as const,
	url: `https://t.me/s/${handle}`,
	homepage: `https://t.me/${handle}`,
	note: TELEGRAM_NOTE,
}));
