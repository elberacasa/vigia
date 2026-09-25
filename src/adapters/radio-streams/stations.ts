import type { Ownership } from "../youtube-live/channels.ts";

/**
 * The radio stations in "En vivo": each stream URL is the one the broadcaster's own website plays, read from
 * that site on 2026-09-24 (noted per station). HTTPS only: a plain-HTTP stream cannot play inside an HTTPS
 * page, so ALER's `http://aler.org:8000` relays and Radio Mundial's raw-IP streams were left out. The hosts here
 * are also the only ones the Content-Security-Policy lets the page play audio from (src/server/app.ts).
 */

export type RadioStation = {
	/** Stable slug; the series is `radio:<id>`. */
	readonly id: string;
	readonly name: string;
	/** Frequency and city, when the stream is one transmitter's. */
	readonly where: string;
	readonly streamUrl: string;
	/** The broadcaster's page that plays this stream. */
	readonly homepage: string;
	readonly lang: "es";
	readonly ownership: Ownership;
	readonly labelEs: string;
	readonly labelEn: string;
	readonly verified: string;
};

const FYA = {
	homepage: "https://www.radiofeyalegrianoticias.com/",
	lang: "es",
	ownership: "private",
	labelEs: "Educativa, sin fines de lucro · Venezuela",
	labelEn: "Educational non-profit · Venezuela",
} as const;

export const RADIO_STATIONS: readonly RadioStation[] = [
	{
		...FYA,
		id: "fya-nacional",
		name: "Radio Fe y Alegría Noticias",
		where: "Señal nacional",
		streamUrl: "https://tx.feyalegrianoticias.com/listen/nacional/radio.mp3",
		verified: "reproductor de radios.feyalegrianoticias.com/nacional-2/ (flujo «AUDIO FYA»)",
	},
	{
		...FYA,
		id: "fya-caracas",
		name: "Fe y Alegría Caracas",
		where: "1390 AM · Caracas",
		streamUrl: "https://tx.feyalegrianoticias.com/listen/caracas/radio.mp3",
		verified: "reproductor de radios.feyalegrianoticias.com/caracasam-2/",
	},
	{
		...FYA,
		id: "fya-maracaibo",
		name: "Fe y Alegría Maracaibo",
		where: "88.1 FM · Zulia",
		streamUrl: "https://tx.feyalegrianoticias.com/listen/maracaibofm/radio.mp3",
		verified: "reproductor de radios.feyalegrianoticias.com/maracaibo-fm/",
	},
	{
		...FYA,
		id: "fya-san-cristobal",
		name: "Fe y Alegría San Cristóbal",
		where: "FM · Táchira",
		streamUrl: "https://tx.feyalegrianoticias.com/listen/sancristobalfm/radio.mp3",
		verified: "reproductor de radios.feyalegrianoticias.com/san-cristobal",
	},
	{
		id: "rnv-informativa",
		name: "RNV Informativa",
		where: "Radio Nacional de Venezuela",
		streamUrl: "https://guri.tepuyserver.net/8048/stream",
		homepage: "https://rnv.gob.ve/",
		lang: "es",
		ownership: "state",
		labelEs: "Medio estatal · Venezuela",
		labelEn: "State media · Venezuela",
		verified: "reproductor de rnv.gob.ve (botón «INFORMATIVA», data-url del sitio)",
	},
];

/** The origins the page may play audio from: exactly the stations' stream hosts. */
export function streamOrigins(): string[] {
	return [...new Set(RADIO_STATIONS.map((s) => new URL(s.streamUrl).origin))].sort();
}
