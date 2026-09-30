/**
 * Every threshold of the camera layer, stated BEFORE any measurement (2026-09-29) and never tuned silently: a change
 * is a dated, recorded decision. The texts the UI shows behind "?" are generated from these constants
 * (`cameraRulesText`), so the words can never drift from the code. No model anywhere; no face, person or content
 * analysis: a still is only ever reduced to its capture time, a hash of its bytes, a 64-bit difference hash and the
 * mean brightness of one fixed region.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const CAMERA_RULES = {
	/** Stills are at most this wide (modest resolution: a view, never a close-up). */
	stillWidth: 480,
	jpegQuality: 72,
	/** A camera is live while its newest still is at most this many cadences old (plus slack). */
	liveCadences: 2,
	liveSlackMs: 5 * MIN,
	/** "Cámara caída": this many consecutive rounds without a still, spanning at least this long. */
	downRounds: 2,
	downMinMs: 20 * MIN,
	/**
	 * "Imagen congelada": the operator's server sends byte-identical pictures this many times in a row, spanning at
	 * least this long (a live view always changes some bytes: noise, light, a clock overlay). A repeated picture is
	 * always dated by when Vigía first saw it, never by the later read.
	 */
	frozenStills: 2,
	frozenMinMs: 30 * MIN,
	/** A still counts as night when the sun is this far below the horizon at the camera (nautical dusk). */
	nightSunDeg: -12,
	/** The camera's own baseline: its night stills of the last N days, within ± this of the same local hour. */
	baselineDays: 14,
	baselineHourWindowMs: 60 * MIN,
	/** At least this many distinct nights in the baseline, or no judgement ("sin línea base"). */
	minBaselineNights: 5,
	/**
	 * What is measured in the lights region: the share of its pixels brighter than half scale (luma > 128), not its
	 * mean. Decided on the first night frames (2026-09-29, before any baseline existed): these cameras raise their
	 * gain at night, so the region's mean is mostly sensor noise (≈50 of 255 on Charallave's west view) and would
	 * barely move if every light went out, while the lights themselves are the few saturated pixels.
	 */
	lightsLuma: 128,
	/** Lights normally cover at least this share of the region, or the view is too dark to measure a drop. */
	minBaselineShare: 0.0005,
	/** "Oscura": the lights region at or below this share of its baseline… */
	darkRatio: 0.5,
	/** …in this many consecutive night stills, at least this far apart. */
	darkStills: 2,
	darkMinSpanMs: 15 * MIN,
	/** How long a camera's darkness counts as incident evidence after its last dark still. */
	evidenceFreshMs: 3 * HOUR,
	/** History read per camera for its state and baseline. */
	historyMs: 15 * DAY,
} as const;

const pct = (x: number) => `${Math.round(x * 100)} %`;

/** The rules in words, generated from CAMERA_RULES. */
export function cameraRulesText(): { es: string[]; en: string[] } {
	const r = CAMERA_RULES;
	return {
		es: [
			`Solo cámaras que su operador publica para el público (un municipio, un hotel, una red de cámaras donde quien la opera la registró, un organismo público). Nunca cámaras privadas o sin protección encontradas por rastreo, nunca retransmisiones de terceros.`,
			`Vigía toma una imagen fija de cada cámara a su ritmo (nunca más rápido de lo que el operador la renueva), de ${r.stillWidth} px de ancho como máximo, y la sirve desde su propio servidor. La imagen reducida se guarda 3 días; de ella solo se calcula su hora, una huella de sus bytes, una huella visual de 64 bits, su brillo medio y la parte de una zona fija que está iluminada. No hay reconocimiento de rostros ni de personas, ni conteo, ni acercamiento.`,
			`«En vivo»: la imagen más reciente tiene menos de ${r.liveCadences} veces el intervalo de la cámara (más ${Math.round(r.liveSlackMs / MIN)} min). «Cámara caída»: ${r.downRounds} rondas seguidas sin imagen durante al menos ${Math.round(r.downMinMs / MIN)} min (la cámara o su servidor no responde; no es una acusación). «Imagen congelada»: ${r.frozenStills} imágenes seguidas idénticas byte por byte durante al menos ${Math.round(r.frozenMinMs / MIN)} min.`,
			`Brillo nocturno (familia «cámaras públicas»): de noche (sol a más de ${-r.nightSunDeg}° bajo el horizonte en la cámara), se mide qué parte de la zona de luces de la vista está iluminada (píxeles con brillo > ${r.lightsLuma} de 255) y se compara con la mediana de la misma cámara a la misma hora (± ${Math.round(r.baselineHourWindowMs / MIN)} min) en los últimos ${r.baselineDays} días, con al menos ${r.minBaselineNights} noches distintas y luces normalmente visibles (≥ ${(r.minBaselineShare * 100).toLocaleString("es")} % de la zona). «Oscura» cuando baja a ${pct(r.darkRatio)} o menos de su línea base en ${r.darkStills} imágenes seguidas separadas al menos ${Math.round(r.darkMinSpanMs / MIN)} min, con la cámara viva (no congelada).`,
			`Niebla, lluvia, un cambio de exposición o de encuadre también oscurecen una imagen: por eso una cámara oscura solo se suma a un incidente que otras fuentes ya abrieron (como los reportes de usuarios); nunca abre uno ni pone el título.`,
		],
		en: [
			"Only cameras their operator publishes for the public (a city, a hotel, a webcam network where its operator registered it, a public body). Never private or unsecured cameras found by scanning, never third-party re-streams.",
			`Vigía takes one still of each camera at its own pace (never faster than the operator renews it), at most ${r.stillWidth} px wide, and serves it from its own server. The reduced still is kept 3 days; from it only its time, a hash of its bytes, a 64-bit visual hash, its mean brightness and how much of one fixed region is lit are computed. No face or person recognition, no counting, no zoom.`,
			`"Live": the newest still is less than ${r.liveCadences} times the camera's interval old (plus ${Math.round(r.liveSlackMs / MIN)} min). "Camera down": ${r.downRounds} rounds in a row without a still over at least ${Math.round(r.downMinMs / MIN)} min (the camera or its server does not answer; not an accusation). "Frozen picture": ${r.frozenStills} byte-identical stills in a row over at least ${Math.round(r.frozenMinMs / MIN)} min.`,
			`Night brightness ("public cameras" family): at night (sun more than ${-r.nightSunDeg}° below the horizon at the camera), the share of the view's lights region that is lit (pixels brighter than ${r.lightsLuma} of 255) is compared with the same camera's median at the same hour (± ${Math.round(r.baselineHourWindowMs / MIN)} min) over the last ${r.baselineDays} days, with at least ${r.minBaselineNights} distinct nights and lights normally visible (≥ ${r.minBaselineShare * 100} % of the region). "Dark" when it falls to ${pct(r.darkRatio)} or less of its baseline in ${r.darkStills} stills in a row at least ${Math.round(r.darkMinSpanMs / MIN)} min apart, with the camera alive (not frozen).`,
			"Fog, rain, an exposure or framing change also darken a picture: so a dark camera only joins an incident other sources already opened (like user reports); it never opens one or sets its title.",
		],
	};
}
