/**
 * Every short failure code of the stream probes and frame grabs (src/media/grab.ts, probe.ts, hls.ts, the frame
 * decoder) in words, Spanish and English, so no card ever shows "sin cuadro (private-host)". No imports: the web
 * client uses the same table (web/src/lib/media.ts). A code this table does not know is said in general words,
 * never echoed raw.
 */

export type ReasonWords = { readonly es: string; readonly en: string };

const WORDS: Readonly<Record<string, ReasonWords>> = {
	// The playlist.
	ended: {
		es: "la transmisión terminó (su lista de video está cerrada)",
		en: "the broadcast ended (its playlist is closed)",
	},
	"stale-playlist": {
		es: "la señal repite un tramo viejo (la lista de video no avanza)",
		en: "the stream replays an old window (the playlist is not moving)",
	},
	"not-playlist": { es: "la dirección no es una lista de video", en: "the address is not a video playlist" },
	"no-variant": {
		es: "la lista de video no ofrece ninguna calidad legible",
		en: "the playlist offers no readable quality",
	},
	empty: { es: "la lista de video está vacía", en: "the playlist is empty" },
	// The address.
	"private-host": {
		es: "la señal apunta a una dirección privada o no pública, que Vigía no abre",
		en: "the stream points to a private or non-public address, which Vigía does not open",
	},
	timeout: { es: "la señal no respondió a tiempo", en: "the stream did not answer in time" },
	dns: {
		es: "el nombre del servidor de la señal no existe",
		en: "the stream's server name does not resolve",
	},
	tls: {
		es: "el certificado de seguridad de la señal no es válido",
		en: "the stream's security certificate is not valid",
	},
	refused: {
		es: "el servidor de la señal rechazó la conexión",
		en: "the stream's server refused the connection",
	},
	network: { es: "no hubo conexión con la señal", en: "no connection to the stream" },
	// The segment and its frame.
	"segment-timeout": { es: "el tramo de video tardó demasiado", en: "the video segment took too long" },
	"segment-not-media": { es: "el tramo de video no contiene video", en: "the video segment holds no video" },
	"segment-unread": { es: "no se pudo leer el tramo de video", en: "the video segment could not be read" },
	incomplete: {
		es: "el tramo de video terminó antes del primer cuadro completo",
		en: "the video segment ended before its first whole frame",
	},
	"not-keyframe": {
		es: "el tramo de video no trae un cuadro completo",
		en: "the video segment carries no whole frame",
	},
	"no-video": { es: "la señal no trae video (solo audio)", en: "the stream carries no video (audio only)" },
	"not-ts": {
		es: "formato de video sin cuadro legible (fMP4)",
		en: "video format without a readable frame (fMP4)",
	},
	codec: { es: "códec de video no compatible", en: "unsupported video codec" },
	"decode-error": {
		es: "el decodificador de video falló con este cuadro",
		en: "the video decoder failed on this frame",
	},
	"decode-output": {
		es: "el decodificador de video no devolvió una imagen",
		en: "the video decoder returned no picture",
	},
	"decoder-start": { es: "el decodificador de video no arrancó", en: "the video decoder did not start" },
	"no-store": { es: "este equipo no guarda imágenes", en: "this computer does not keep pictures" },
	unknown: { es: "no se pudo tomar un cuadro", en: "no frame could be taken" },
};

/** HTTP statuses in words: `of` is "de la señal" / "del video" (a segment), `ofEn` its English. */
const HTTP: Readonly<Record<string, (of: string, ofEn: string) => ReasonWords>> = {
	"401": (of, ofEn) => ({
		es: `el servidor ${of} pide una clave`,
		en: `the server ${ofEn} asks for a login`,
	}),
	"403": (of, ofEn) => ({ es: `el servidor ${of} negó el acceso`, en: `the server ${ofEn} refused access` }),
	"404": (of, ofEn) => ({
		es: `la dirección ${of} ya no existe`,
		en: `the address ${ofEn} no longer exists`,
	}),
	"410": (of, ofEn) => ({ es: `la dirección ${of} fue retirada`, en: `the address ${ofEn} was withdrawn` }),
	"429": (of, ofEn) => ({
		es: `el servidor ${of} pidió esperar (demasiadas consultas)`,
		en: `the server ${ofEn} asked to wait (too many requests)`,
	}),
};

/** "http-404" → "la dirección de la señal ya no existe (404)"; "segment-http-502" → "el servidor del video falló (error 502)". */
function httpWords(status: string, segment: boolean): ReasonWords {
	const of = segment ? "del video" : "de la señal";
	const ofEn = segment ? "of the video" : "of the stream";
	const known = Object.hasOwn(HTTP, status) ? HTTP[status] : undefined;
	if (known) {
		const w = known(of, ofEn);
		return { es: `${w.es} (${status})`, en: `${w.en} (${status})` };
	}
	if (status.startsWith("5"))
		return {
			es: `el servidor ${of} falló (error ${status})`,
			en: `the server ${ofEn} failed (error ${status})`,
		};
	return {
		es: `el servidor ${of} respondió con un error (${status})`,
		en: `the server ${ofEn} answered with an error (${status})`,
	};
}

/** Whether the table has words of its own for `code` (else `failureWords` says it in general words). */
export function knownFailure(code: string): boolean {
	return Object.hasOwn(WORDS, code) || /^(segment-)?http-\d{3}$/.test(code);
}

/** Words for one failure code; never the code itself (an HTTP status number is kept, in brackets). */
export function failureWords(code: string): ReasonWords {
	const http = /^(segment-)?http-(\d{3})$/.exec(code);
	if (http) return httpWords(http[2] ?? "", Boolean(http[1]));
	return (Object.hasOwn(WORDS, code) ? WORDS[code] : undefined) ?? (WORDS.unknown as ReasonWords);
}

/** Every code the table words (for tests and the docs). */
export const FAILURE_CODES: readonly string[] = Object.keys(WORDS);
