import type { CameraSpec } from "./types.ts";

/**
 * The public cameras Vigía watches: the census of 2026-09-28/29 (90 candidates, each with its status, terms and
 * verification in the project's sources notes, "Public cameras"). Every one is published by
 * its operator for the public and was verified live from this machine at night in Venezuela (03:50–05:00 UTC on
 * 2026-09-29). Venezuela itself has almost none: one operator (the Charallave airport company) publishes live stills;
 * no camera was found at any border crossing, in the Catatumbo, or from any Venezuelan public body.
 *
 * Kept out, with the reason in the census: third-party re-streams ("Caracas skyline" compilations), cameras run by
 * private individuals (hard line 1), anything behind a bot challenge or that needs a spoofed Referer (hard line 3),
 * insecam/Shodan finds (never fetched), SkylineWebcams and EarthCam (their terms forbid extracting images; EarthCam's
 * streams answer 403 without its player), and the Windy copies of the Charallave views (same pictures).
 *
 * Positions: the operator's own figure or the listing's mast position, as each entry says. Headings: the operator's
 * label (a compass word) or the view's landmarks, approximate; null when not determined.
 */

const MIN = 60_000;

/** Windy ids of cameras already listed here from their operator (Windy shows the same picture): never listed twice. */
export const WINDY_DUPLICATES: Readonly<Record<string, string>> = {
	"1656890691": "charallave-este",
	"1656890882": "charallave-oeste",
	"1656891018": "charallave-norte",
	"1656891108": "charallave-sur",
	"1409864366": "ciudad-guayana-climaguayana",
};

const CHARALLAVE = {
	operator: { name: "Aeropuerto Caracas, C.A.", url: "https://www.aeropuertocaracas.net/" },
	page: "https://www.aeropuertocaracas.net/weather/index_s.php",
	lat: 10.28887,
	lon: -66.82134,
	positionFrom:
		"Mástil de la cámara según su ficha en Windy (10.28887, −66.82134); el operador da la referencia del aeródromo N10 17.4 W66 48.9",
	country: "VE",
	terms: {
		url: "https://www.aeropuertocaracas.net/weather/index_s.php",
		note: "La página del operador publica las cuatro imágenes para el público («WebCams … Actualizadas cada 10 minutos»); no hay términos de uso, licencia ni aviso de derechos en la página ni en el sitio; robots.txt vacío (2026-09-29). Imagen de 1600×1200, unos 550 KB.",
		stills: true,
	},
	verified:
		"2026-09-29 04:02 y 04:10 UTC: HTTP 200 image/jpeg 1600×1200; la imagen cambió entre lecturas (el operador la renueva cada 10 min); sin Last-Modified.",
} as const;

const SHOWME = {
	operator: { name: "SHOWME Caribbean (cámaras web, Curazao)", url: "https://showmecaribbean.com/" },
	channelId: "UCRjMuOBDCfSsCNIe2p0_tdg",
	terms: {
		url: "https://www.youtube.com/t/terms",
		note: "Transmisión propia del operador en su canal de YouTube; sin términos propios en showmecaribbean.com. Se reproduce solo en el reproductor de YouTube; no se toman imágenes (su miniatura en vivo es una imagen promocional, medido el 2026-09-29).",
		stills: false,
	},
} as const;

const showmeVerified = (utc: string) =>
	`2026-09-29 ${utc} UTC: transmisión en vivo en el canal del operador (isLiveNow, reproducción OK).`;

export const CAMERAS: readonly CameraSpec[] = [
	{
		id: "charallave-oeste",
		name: { es: "Aeropuerto de Charallave: vista oeste", en: "Charallave airport: west view" },
		kind: "airport",
		...CHARALLAVE,
		headingDeg: 270,
		headingFrom: "Etiqueta del operador «Vista Oeste»",
		view: {
			es: "Lado oeste del aeródromo de Charallave (Miranda), con luces lejanas en el horizonte.",
			en: "West side of the Charallave airfield (Miranda), with distant lights on the horizon.",
		},
		access: { type: "jpeg", url: "https://www.aeropuertocaracas.net/weather/oeste.jpg" },
		stillEveryMs: 20 * MIN,
		lights: {
			region: { x: 0.2, y: 0.58, w: 0.8, h: 0.18 },
			what: "luces lejanas hacia el oeste, sobre el horizonte (0,3 % de la zona encendida la noche del 2026-09-29)",
		},
	},
	{
		id: "charallave-este",
		name: { es: "Aeropuerto de Charallave: vista este", en: "Charallave airport: east view" },
		kind: "airport",
		...CHARALLAVE,
		headingDeg: 90,
		headingFrom: "Etiqueta del operador «Vista Este»",
		view: {
			es: "Plataforma, terminal y hangares del aeródromo de Charallave hacia el este.",
			en: "Apron, terminal and hangars of the Charallave airfield, looking east.",
		},
		access: { type: "jpeg", url: "https://www.aeropuertocaracas.net/weather/este.jpg" },
		stillEveryMs: 20 * MIN,
		lights: {
			region: { x: 0, y: 0.64, w: 0.72, h: 0.14 },
			what: "focos de la plataforma del aeropuerto (pueden tener planta propia: una señal débil de apagón)",
		},
	},
	{
		id: "charallave-norte",
		name: { es: "Aeropuerto de Charallave: vista norte", en: "Charallave airport: north view" },
		kind: "airport",
		...CHARALLAVE,
		headingDeg: 0,
		headingFrom: "Etiqueta del operador «Vista Norte»",
		view: {
			es: "Lado norte del aeródromo de Charallave; de noche, focos cercanos deslumbran la imagen.",
			en: "North side of the Charallave airfield; at night, nearby floodlights glare over the picture.",
		},
		access: { type: "jpeg", url: "https://www.aeropuertocaracas.net/weather/norte.jpg" },
		stillEveryMs: 60 * MIN,
		lights: null,
	},
	{
		id: "charallave-sur",
		name: { es: "Aeropuerto de Charallave: vista sur", en: "Charallave airport: south view" },
		kind: "airport",
		...CHARALLAVE,
		headingDeg: 180,
		headingFrom: "Etiqueta del operador «Vista Sur»",
		view: {
			es: "Pista y cerros al sur del aeródromo de Charallave; casi oscura de noche.",
			en: "Runway and hills south of the Charallave airfield; almost dark at night.",
		},
		access: { type: "jpeg", url: "https://www.aeropuertocaracas.net/weather/sur.jpg" },
		stillEveryMs: 60 * MIN,
		lights: null,
	},
	{
		id: "ciudad-guayana-climaguayana",
		name: { es: "Ciudad Guayana: cielo hacia el suroeste", en: "Ciudad Guayana: sky to the south-west" },
		kind: "weather",
		operator: {
			name: "Climaguayana (estación meteorológica de Alta Vista Sur)",
			url: "https://www.windy.com/webcams/1409864366",
		},
		page: "https://www.windy.com/webcams/1409864366",
		lat: 8.28973,
		lon: -62.72153,
		positionFrom: "Ficha de la cámara en Windy (8.28973, −62.72153)",
		headingDeg: 225,
		headingFrom: "Título de Windy «South-west»",
		view: {
			es: "Cielo y horizonte de Ciudad Guayana con los datos de la estación (temperatura, humedad, viento, lluvia).",
			en: "Sky and horizon over Ciudad Guayana with the station's readings (temperature, humidity, wind, rain).",
		},
		country: "VE",
		access: { type: "embed", url: "https://webcams.windy.com/webcams/public/embed/player/1409864366/day" },
		stillEveryMs: 15 * MIN,
		terms: {
			url: "https://api.windy.com/webcams/terms",
			note: "Publicada por su operador en Windy. Sin clave de Windy solo se muestra en el reproductor público de Windy (permitido); los términos de su API no dejan guardar ni redistribuir imágenes.",
			stills: false,
		},
		lights: null,
		verified:
			"2026-09-29 04:02 y 04:15 UTC: la imagen de la estación (Meteobridge, 640×360) se renovaba (Last-Modified 04:00:34 y luego 04:15:35 GMT); el reproductor de Windy mostraba entonces su cuadro de las 03:11 UTC, una hora atrás.",
	},
	{
		id: "bonaire-kralendijk",
		name: { es: "Bonaire: malecón de Kralendijk", en: "Bonaire: Kralendijk waterfront" },
		kind: "skyline",
		operator: { name: "Breathe-IT (breathebonaire.com)", url: "http://www.breathebonaire.com/" },
		page: "http://www.breathebonaire.com/",
		lat: 12.15,
		lon: -68.277,
		positionFrom: "Edificio Terramar en el malecón de Kralendijk, según el pie de la imagen; aproximada",
		headingDeg: null,
		headingFrom: null,
		view: {
			es: "Malecón y puerto de Kralendijk con su alumbrado; a unos 80 km de la costa de Falcón (la vista no mira hacia Venezuela).",
			en: "Kralendijk promenade and harbour with its street lights; about 80 km from the Falcón coast (the view does not face Venezuela).",
		},
		country: "BQ",
		access: { type: "jpeg", url: "http://www.breathebonaire.com/~bonairecam10/current.jpg" },
		stillEveryMs: 10 * MIN,
		terms: {
			url: "http://www.breathebonaire.com/",
			note: "Sin términos de uso en la página; pie «©2007 - 2026 www.breathebonaire.com». Cámara de referencia del método de brillo nocturno: fuera de Venezuela, nunca cuenta para un incidente.",
			stills: true,
		},
		lights: {
			region: { x: 0.24, y: 0.12, w: 0.76, h: 0.2 },
			what: "farolas del malecón y luces del puerto (0,6 % de la zona encendida la noche del 2026-09-29)",
		},
		verified:
			"2026-09-29 04:10 UTC (HTTP 206, censo), 04:18 UTC y 04:35 UTC (HTTP 200, imagen de 960×544 que cambió); el reloj impreso coincide con la hora de lectura; su Last-Modified va una hora atrasado (no se usa).",
	},
	{
		id: "curazao-willemstad-handelskade",
		name: {
			es: "Curazao: Handelskade y puente Reina Emma",
			en: "Curaçao: Handelskade and Queen Emma bridge",
		},
		kind: "skyline",
		operator: SHOWME.operator,
		page: "https://www.youtube.com/watch?v=28U-t3fA9ks",
		lat: 12.1052,
		lon: -68.9362,
		positionFrom: "Brionplein, Otrobanda (descripción de la transmisión); aproximada",
		headingDeg: 90,
		headingFrom: "Mira al este sobre la bahía de Santa Ana hacia Punda; cámara móvil",
		view: {
			es: "Fachadas de Handelskade, el puente flotante Reina Emma y el tráfico del puerto de Willemstad.",
			en: "Handelskade facades, the Queen Emma pontoon bridge and harbour traffic in Willemstad.",
		},
		country: "CW",
		access: { type: "youtube", channelId: SHOWME.channelId, videoId: "28U-t3fA9ks" },
		stillEveryMs: 30 * MIN,
		terms: SHOWME.terms,
		lights: null,
		verified: showmeVerified("04:13"),
	},
	{
		id: "curazao-avila-beach",
		name: { es: "Curazao: playa del Avila Beach Hotel", en: "Curaçao: Avila Beach Hotel beach" },
		kind: "beach",
		operator: SHOWME.operator,
		page: "https://www.youtube.com/watch?v=-oiR7FxcwYU",
		lat: 12.101,
		lon: -68.923,
		positionFrom: "Avila Beach Hotel, costa sur de Curazao; aproximada",
		headingDeg: 180,
		headingFrom:
			"La playa mira al Caribe abierto hacia el sur, hacia Venezuela (a unos 65 km, bajo el horizonte)",
		view: {
			es: "Playa y muelle del hotel mirando al sur, hacia Venezuela (que queda bajo el horizonte).",
			en: "The hotel's beach and pier looking south, towards Venezuela (below the horizon).",
		},
		country: "CW",
		access: { type: "youtube", channelId: SHOWME.channelId, videoId: "-oiR7FxcwYU" },
		stillEveryMs: 30 * MIN,
		terms: SHOWME.terms,
		lights: null,
		verified: showmeVerified("04:13"),
	},
	{
		id: "klein-curazao",
		name: { es: "Klein Curazao: playa", en: "Klein Curaçao: beach" },
		kind: "beach",
		operator: SHOWME.operator,
		page: "https://www.youtube.com/watch?v=0ImA9IcyQwA",
		lat: 11.988,
		lon: -68.6445,
		positionFrom: "Klein Curazao, torre de Mermaid Boat Trips; aproximada",
		headingDeg: 270,
		headingFrom: "Mira sobre la playa y los botes fondeados al oeste; aproximada",
		view: {
			es: "Playa de Klein Curazao, el punto de las islas ABC más cercano a Venezuela.",
			en: "Beach on Klein Curaçao, the point of the ABC islands closest to Venezuela.",
		},
		country: "CW",
		access: { type: "youtube", channelId: SHOWME.channelId, videoId: "0ImA9IcyQwA" },
		stillEveryMs: 30 * MIN,
		terms: SHOWME.terms,
		lights: null,
		verified: showmeVerified("04:13"),
	},
	{
		id: "aruba-eagle-beach",
		name: { es: "Aruba: Eagle Beach", en: "Aruba: Eagle Beach" },
		kind: "beach",
		operator: SHOWME.operator,
		page: "https://www.youtube.com/watch?v=_ZXMjk5K0_s",
		lat: 12.5505,
		lon: -70.0585,
		positionFrom: "Costa Linda Beach Resort, Eagle Beach; aproximada",
		headingDeg: 270,
		headingFrom: "Eagle Beach mira al oeste sobre el mar; aproximada",
		view: { es: "Eagle Beach y el mar al oeste.", en: "Eagle Beach and the sea to the west." },
		country: "AW",
		access: { type: "youtube", channelId: SHOWME.channelId, videoId: "_ZXMjk5K0_s" },
		stillEveryMs: 30 * MIN,
		terms: SHOWME.terms,
		lights: null,
		verified: showmeVerified("04:14"),
	},
	{
		id: "bonaire-sorobon",
		name: { es: "Bonaire: bahía de Lac (Sorobon)", en: "Bonaire: Lac Bay (Sorobon)" },
		kind: "beach",
		operator: SHOWME.operator,
		page: "https://www.youtube.com/watch?v=EcumU_n6fTY",
		lat: 12.084,
		lon: -68.222,
		positionFrom: "Sorobon Luxury Beach Resort; aproximada",
		headingDeg: 90,
		headingFrom: "Panorámica de 180° sobre la bahía de Lac, que abre al este; aproximada",
		view: { es: "Playa de windsurf de la bahía de Lac.", en: "The Lac Bay windsurf beach." },
		country: "BQ",
		access: { type: "youtube", channelId: SHOWME.channelId, videoId: "EcumU_n6fTY" },
		stillEveryMs: 30 * MIN,
		terms: SHOWME.terms,
		lights: null,
		verified: showmeVerified("04:13"),
	},
];
