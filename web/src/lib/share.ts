/**
 * Share cards: 1080×1350 PNGs (the WhatsApp/Instagram portrait) drawn with Canvas 2D from the same geometry and the
 * same server-computed figures the page shows. Every card carries the mark, the date and time in Caracas, the answer
 * as its headline, the figures, and a footer naming every source with the age of its data. Made on the device;
 * nothing is uploaded. No AI text is ever drawn on a card.
 *
 * Templates: map (what the map shows now), dollar, internet, quakes, state.
 */
import { NEIGHBOURS, STATES } from "../map/geometry.gen.ts";
import type { StateFill } from "../map/Map.tsx";
import { pathBox, project } from "../map/project.ts";
import { quakeRadius } from "../map/QuakeLayer.tsx";
import { healthById, metaById } from "./data.ts";
import { ago, clock, num, pct, stamp, TZ } from "./format.ts";
import type { Clause } from "./headline.ts";

const W = 1080;
const H = 1350;
const PAD = 64;
type Lang = "es" | "en";
type Ctx = CanvasRenderingContext2D;

function css(name: string, fallback: string, from: Element = document.documentElement): string {
	return getComputedStyle(from).getPropertyValue(name).trim() || fallback;
}

function palette() {
	return {
		bg: css("--bg", "#07090e"),
		// The map's own sea and neighbour tones live on the map view (styles/map.css).
		sea: css("--map-sea", "#060a10", document.querySelector(".mapview") ?? document.documentElement),
		surface: css("--surface-1", "#10141c"),
		line: css("--line", "#232a37"),
		land: css("--map-land", "#151c29"),
		border: css("--map-border", "#2e384b"),
		neighbour: css(
			"--map-neighbour",
			"#0e131b",
			document.querySelector(".mapview") ?? document.documentElement,
		),
		text: css("--text", "#edeff3"),
		text2: css("--text-2", "#aab2c0"),
		text3: css("--text-3", "#8a94a7"),
		signal: css("--signal", "#f6b532"),
		info: css("--info", "#6cb4ff"),
		ok: css("--ok", "#3fd49a"),
		warn: css("--warn", "#ff9f43"),
		alert: css("--alert", "#ff5a5f"),
	};
}
type Palette = ReturnType<typeof palette>;

const UI = "Archivo, system-ui, sans-serif";
const MONO = "'Chivo Mono', ui-monospace, monospace";

function wrap(ctx: Ctx, text: string, maxWidth: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const w of text.split(" ")) {
		const next = line ? `${line} ${w}` : w;
		if (ctx.measureText(next).width > maxWidth && line) {
			lines.push(line);
			line = w;
		} else line = next;
	}
	if (line) lines.push(line);
	return lines;
}

/** "24 sept 2026 · 20:18" in Caracas. */
export function cardStamp(t: number, lang: Lang): string {
	const date = new Intl.DateTimeFormat(lang === "es" ? "es-VE" : "en-US", {
		timeZone: TZ,
		day: "numeric",
		month: "short",
		year: "numeric",
	})
		.format(t)
		.replace(/\./g, "")
		.replace(/ de /g, " ");
	return `${date} · ${clock(t, lang)}`;
}

/**
 * "IODA, Georgia Tech … · dato de hace 18 min": a source and the age of its newest datum, or when it was last checked
 * for event feeds where silence is normal (the same rule as the panel badges).
 */
export function sourceLine(feed: string, now: number, lang: Lang): string | null {
	const m = metaById.value.get(feed);
	const h = healthById.value.get(feed);
	if (!m) return null;
	if (!h?.lastSuccessAt) return `${m.provider} · ${lang === "es" ? "sin datos" : "no data"}`;
	const future = h.newestObservedAt !== null && h.newestObservedAt > now;
	const event = m.freshness.dataMs === null || future;
	const at = event ? h.lastSuccessAt : (h.newestObservedAt ?? h.lastSuccessAt);
	const age = ago(now - at, lang);
	return `${m.provider} · ${event ? (lang === "es" ? `revisado ${age}` : `checked ${age}`) : lang === "es" ? `dato de ${age}` : `data ${age}`}`;
}

function drawMark(ctx: Ctx, p: Palette, x: number, y: number, s: number): void {
	ctx.save();
	ctx.translate(x, y);
	ctx.scale(s, s);
	ctx.strokeStyle = p.text;
	ctx.lineWidth = 6.5;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	const beam = (deg: number): [number, number] => {
		const a = (deg * Math.PI) / 180;
		return [32 + 33 * Math.sin(a), 53 - 33 * Math.cos(a)];
	};
	ctx.beginPath();
	ctx.moveTo(...beam(-30));
	ctx.lineTo(32, 53);
	ctx.lineTo(...beam(30));
	ctx.stroke();
	ctx.fillStyle = p.signal;
	for (let i = 0; i < 8; i++) {
		const a = ((-33 + (i * 66) / 7) * Math.PI) / 180;
		ctx.beginPath();
		ctx.arc(32 + 43 * Math.sin(a), 53 - 43 * Math.cos(a), 2.6, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.restore();
}

interface Frame {
	eyebrow: string;
	/** The answer, 56 px; wraps to at most three lines. */
	headline: string;
	headlineColor?: string;
	sub?: string;
	now: number;
	lang: Lang;
	/** Feed ids behind the figures; each becomes a footer line with its age. */
	feeds: readonly string[];
	/** Extra footer text (a method note), one line. */
	note?: string;
	/** Draws the figures between `top` and `bottom`. */
	body: (ctx: Ctx, p: Palette, top: number, bottom: number) => void;
}

/** Link printed on the card; a self-hosted instance on this machine prints none (it would not open for others). */
function publicUrl(): string | null {
	const host = location.hostname;
	if (host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "[::1]")
		return null;
	return `${location.host}${location.pathname === "/" ? "" : location.pathname}`;
}

async function render(f: Frame): Promise<Blob> {
	await document.fonts.ready;
	const canvas = document.createElement("canvas");
	canvas.width = W;
	canvas.height = H;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("canvas");
	const p = palette();
	const es = f.lang === "es";
	ctx.fillStyle = p.bg;
	ctx.fillRect(0, 0, W, H);
	ctx.fillStyle = p.signal;
	ctx.fillRect(0, 0, W, 6);

	// Header: mark + wordmark, date and time in Caracas.
	drawMark(ctx, p, PAD, 44, 1.05);
	ctx.fillStyle = p.text;
	ctx.font = `800 44px ${UI}`;
	ctx.fillText("VIGÍA", PAD + 88, 104);
	ctx.textAlign = "right";
	ctx.fillStyle = p.text;
	ctx.font = `500 26px ${MONO}`;
	ctx.fillText(cardStamp(f.now, f.lang), W - PAD, 86);
	ctx.fillStyle = p.text3;
	ctx.font = `400 20px ${MONO}`;
	ctx.fillText(es ? "hora de Caracas" : "Caracas time", W - PAD, 116);
	ctx.textAlign = "left";

	// Eyebrow and headline.
	ctx.fillStyle = p.signal;
	ctx.font = `800 24px ${UI}`;
	ctx.fillText(f.eyebrow.toUpperCase().split("").join(String.fromCharCode(8202)), PAD, 206);
	ctx.fillStyle = f.headlineColor ?? p.text;
	ctx.font = `800 56px ${UI}`;
	let y = 272;
	for (const line of wrap(ctx, f.headline, W - 2 * PAD).slice(0, 3)) {
		ctx.fillText(line, PAD, y);
		y += 64;
	}
	if (f.sub) {
		ctx.fillStyle = p.text2;
		ctx.font = `500 28px ${UI}`;
		for (const line of wrap(ctx, f.sub, W - 2 * PAD).slice(0, 2)) {
			ctx.fillText(line, PAD, y + 4);
			y += 38;
		}
	}

	// Footer: every source with its age, then the method note and the honesty line.
	const sources = f.feeds.map((id) => sourceLine(id, f.now, f.lang)).filter((s): s is string => s !== null);
	ctx.font = `400 21px ${UI}`;
	const srcLines = wrap(ctx, `${es ? "Fuentes" : "Sources"}: ${sources.join("; ")}`, W - 2 * PAD).slice(0, 3);
	const noteLines = f.note ? wrap(ctx, f.note, W - 2 * PAD).slice(0, 2) : [];
	const footTop = H - 70 - (srcLines.length + noteLines.length) * 28 - 24;
	ctx.fillStyle = p.line;
	ctx.fillRect(PAD, footTop, W - 2 * PAD, 2);
	let fy = footTop + 40;
	ctx.fillStyle = p.text2;
	for (const line of srcLines) {
		ctx.fillText(line, PAD, fy);
		fy += 28;
	}
	ctx.fillStyle = p.text3;
	for (const line of noteLines) {
		ctx.fillText(line, PAD, fy);
		fy += 28;
	}
	ctx.font = `600 21px ${UI}`;
	ctx.fillStyle = p.text3;
	const url = publicUrl();
	ctx.fillText(
		es
			? "Vigía · código abierto · cada cifra con su fuente y su hora"
			: "Vigía · open source · every figure with its source and time",
		PAD,
		H - 44,
	);
	if (url) {
		ctx.textAlign = "right";
		ctx.fillStyle = p.text;
		ctx.fillText(url, W - PAD, H - 44);
		ctx.textAlign = "left";
	}

	f.body(ctx, p, y + 36, footTop - 36);

	return await new Promise<Blob>((resolve, reject) =>
		canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/png"),
	);
}

type Quake = { lat: number; lon: number; mag: number };

/** The map fitted into a box (optionally cropped to `focus`, a state ISO), fills and quake circles in place. */
function drawMap(
	ctx: Ctx,
	p: Palette,
	box: { x: number; y: number; w: number; h: number },
	fills: Readonly<Record<string, StateFill>>,
	quakes: readonly Quake[],
	focus?: string,
	raster?: LoadedRaster,
): void {
	let view: [number, number, number, number] = [0, 0, 1399, 1240];
	if (focus) {
		const s = STATES.find((x) => x.iso === focus);
		if (s) {
			const b = pathBox(s.d);
			const m = Math.max(b[2], b[3]) * 0.35;
			view = [b[0] - m, b[1] - m, b[2] + 2 * m, b[3] + 2 * m];
		}
	}
	const scale = Math.min(box.w / view[2], box.h / view[3]);
	const offX = box.x + (box.w - view[2] * scale) / 2 - view[0] * scale;
	const offY = box.y + (box.h - view[3] * scale) / 2 - view[1] * scale;
	// The map sits in its own framed sea, so the frame's straight edges read as a frame, not as cut-off land.
	const frame = {
		x: offX + view[0] * scale,
		y: offY + view[1] * scale,
		w: view[2] * scale,
		h: view[3] * scale,
	};
	ctx.save();
	ctx.beginPath();
	ctx.roundRect(frame.x, frame.y, frame.w, frame.h, 14);
	ctx.fillStyle = p.sea;
	ctx.fill();
	ctx.strokeStyle = p.line;
	ctx.lineWidth = 2;
	ctx.stroke();
	ctx.clip();
	ctx.translate(offX, offY);
	ctx.scale(scale, scale);
	ctx.fillStyle = p.neighbour;
	for (const n of NEIGHBOURS) if (n.kind !== "disputed") ctx.fill(new Path2D(n.d));
	if (raster) {
		// Satellite or night lights exactly as on the map: the image in its lon/lat bounds, states as outlines.
		const [x0, y0] = project(raster.bounds.west, raster.bounds.north);
		const [x1, y1] = project(raster.bounds.east, raster.bounds.south);
		const light = luminance(p.bg) > 0.5;
		ctx.save();
		if (raster.blend) {
			ctx.globalCompositeOperation = light ? "multiply" : "screen";
			if (light) ctx.filter = "invert(1)";
		}
		ctx.drawImage(raster.image, x0, y0, x1 - x0, y1 - y0);
		ctx.restore();
		for (const s of STATES) {
			ctx.strokeStyle =
				s.iso === focus ? p.signal : light && raster.blend ? p.border : "rgba(255,255,255,0.45)";
			ctx.lineWidth = (s.iso === focus ? 4 : 1.6) / scale;
			ctx.stroke(new Path2D(s.d));
		}
	}
	for (const s of raster ? [] : STATES) {
		const fill = fills[s.iso];
		const path = new Path2D(s.d);
		ctx.fillStyle = p.land;
		ctx.globalAlpha = focus && s.iso !== focus ? 0.45 : 1;
		ctx.fill(path);
		const tone =
			fill?.tone === "severe"
				? p.alert
				: fill?.tone === "drop"
					? p.warn
					: fill?.tone === "signal"
						? p.signal
						: null;
		if (tone) {
			ctx.fillStyle = tone;
			ctx.globalAlpha =
				(fill?.tone === "signal"
					? 0.15 + 0.55 * (fill.intensity ?? 0.5)
					: fill?.tone === "severe"
						? 0.6
						: 0.45) * (focus && s.iso !== focus ? 0.45 : 1);
			ctx.fill(path);
		}
		ctx.globalAlpha = 1;
		ctx.strokeStyle = s.iso === focus ? p.signal : p.border;
		ctx.lineWidth = (s.iso === focus ? 4 : 1.6) / scale;
		ctx.stroke(path);
	}
	for (const q of quakes) {
		const [x, qy] = project(q.lon, q.lat);
		// Same size on the card whatever the crop: radius in full-view units times the crop's share of the frame.
		const r = quakeRadius(q.mag) * (view[2] / 1399) * 1.3;
		ctx.globalAlpha = 0.35;
		ctx.fillStyle = p.signal;
		ctx.beginPath();
		ctx.arc(x, qy, r, 0, Math.PI * 2);
		ctx.fill();
		ctx.globalAlpha = 1;
		ctx.strokeStyle = p.signal;
		ctx.lineWidth = 2.5 / scale;
		ctx.stroke();
	}
	ctx.restore();
}

/** A labelled figure: small caps label over a big number, with a line of detail. */
function figure(
	ctx: Ctx,
	p: Palette,
	x: number,
	y: number,
	label: string,
	value: string,
	detail: string,
	color?: string,
) {
	ctx.fillStyle = p.text3;
	ctx.font = `700 20px ${UI}`;
	ctx.fillText(label.toUpperCase(), x, y);
	ctx.fillStyle = color ?? p.text;
	ctx.font = `800 64px ${UI}`;
	ctx.fillText(value, x, y + 70);
	ctx.fillStyle = p.text2;
	ctx.font = `500 22px ${UI}`;
	ctx.fillText(detail, x, y + 106);
}

// ——— templates ———

/** A raster layer to draw under the state outlines (same-origin image, so the canvas stays exportable). */
export interface MapRaster {
	url: string;
	bounds: { west: number; east: number; south: number; north: number };
	/** Night lights: blended like on the map (screen on dark, inverted multiply on light). */
	blend: boolean;
}
type LoadedRaster = Omit<MapRaster, "url"> & { image: HTMLImageElement };

function luminance(hex: string): number {
	const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex.trim());
	if (!m) return 0;
	const [r, g, b] = [m[1], m[2], m[3]].map((x) => Number.parseInt(x ?? "0", 16) / 255) as [
		number,
		number,
		number,
	];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

async function loadRaster(r: MapRaster): Promise<LoadedRaster | undefined> {
	const image = new Image();
	image.src = r.url;
	try {
		await image.decode();
		return { bounds: r.bounds, blend: r.blend, image };
	} catch {
		return undefined;
	}
}

export interface MapCardInput {
	clauses: readonly Clause[];
	fills: Readonly<Record<string, StateFill>>;
	quakes: readonly Quake[];
	layerLabel: string;
	feeds: readonly string[];
	note?: string;
	/** "Viendo: 23 sept 18:00 · datos de ese momento" for a replay. */
	pastLabel?: string;
	raster?: MapRaster;
	now: number;
	lang: Lang;
}

/** What the map shows now: the Ahora sentence as headline, the shaded map, the layer and its sources. */
export async function mapCard(input: MapCardInput): Promise<Blob> {
	const es = input.lang === "es";
	const raster = input.raster ? await loadRaster(input.raster) : undefined;
	const lead = input.clauses[0];
	return render({
		eyebrow: input.pastLabel ?? (es ? "Venezuela ahora" : "Venezuela now"),
		headline: lead?.text ?? (es ? "Venezuela ahora" : "Venezuela now"),
		...(input.clauses.length > 1
			? {
					sub: input.clauses
						.slice(1, 4)
						.map((c) => c.text)
						.join(" · "),
				}
			: {}),
		now: input.now,
		lang: input.lang,
		feeds: input.feeds,
		note: `${input.layerLabel}${input.note ? `. ${input.note}` : ""}`,
		body: (ctx, p, top, bottom) =>
			drawMap(
				ctx,
				p,
				{ x: PAD, y: top, w: W - 2 * PAD, h: bottom - top },
				input.fills,
				input.quakes,
				undefined,
				raster,
			),
	});
}

/** Mirrors the pieces of src/panels/money.ts the card needs. */
export interface DollarCardInput {
	official: {
		usd: { current: { vesPerUnit: number; valueDate: string } | null; change24h: { pct: number } | null };
		eur: { current: { vesPerUnit: number } | null };
	};
	yadio: {
		figure: { vesPerUsd: number; gap: { pct: number } | null; change24h: { pct: number } | null } | null;
	};
	series90d: {
		official: { vesPerUsd: number; observedAt: number }[];
		yadio: { vesPerUsd: number; observedAt: number }[];
	};
}

export function dollarCard(v: DollarCardInput, now: number, lang: Lang): Promise<Blob> {
	const es = lang === "es";
	const usd = v.official.usd.current;
	const y = v.yadio.figure;
	return render({
		eyebrow: es ? "Dólar en Venezuela" : "Dollar in Venezuela",
		headline: usd
			? es
				? `Dólar oficial BCV: ${num(usd.vesPerUnit, 2, lang)} Bs`
				: `Official BCV dollar: ${num(usd.vesPerUnit, 2, lang)} Bs`
			: es
				? "Dólar oficial: sin dato del BCV"
				: "Official dollar: no BCV figure",
		...(y?.gap
			? {
					sub: es
						? `Mercado (Yadio) ${pct(y.gap.pct, 1, lang)} sobre la tasa oficial`
						: `Market (Yadio) ${pct(y.gap.pct, 1, lang)} over the official rate`,
				}
			: {}),
		now,
		lang,
		feeds: ["bcv-official", "bcv-api", "yadio"],
		note: es
			? "Brecha calculada por Vigía frente a la tasa oficial vigente."
			: "Gap computed by Vigía against the official rate in force.",
		body: (ctx, p, top, bottom) => {
			const eur = v.official.eur.current;
			const cols = eur ? 3 : 2;
			const colW = (W - 2 * PAD) / cols;
			figure(
				ctx,
				p,
				PAD,
				top,
				es ? "BCV · dólar" : "BCV · dollar",
				usd ? num(usd.vesPerUnit, 2, lang) : "—",
				v.official.usd.change24h ? `${pct(v.official.usd.change24h.pct, 2, lang)} 24 h` : "Bs",
			);
			figure(
				ctx,
				p,
				PAD + colW,
				top,
				es ? "Yadio · mercado" : "Yadio · market",
				y ? num(y.vesPerUsd, 2, lang) : "—",
				y?.change24h ? `${pct(y.change24h.pct, 2, lang)} 24 h` : "Bs",
				p.info,
			);
			if (eur)
				figure(
					ctx,
					p,
					PAD + 2 * colW,
					top,
					es ? "BCV · euro" : "BCV · euro",
					num(eur.vesPerUnit, 2, lang),
					"Bs",
				);
			// 90 days of both series on one time axis and one scale, points as served (no smoothing, no fill-in).
			const chartTop = top + 180;
			const chartH = bottom - chartTop - 44;
			const series = [
				{ pts: v.series90d.official, color: p.text, label: "BCV" },
				{ pts: v.series90d.yadio, color: p.info, label: "Yadio" },
			];
			const all = series.flatMap((x) => x.pts);
			if (chartH < 120 || all.length < 2) return;
			const lo = Math.min(...all.map((d) => d.vesPerUsd));
			const hi = Math.max(...all.map((d) => d.vesPerUsd));
			const t1 = Math.max(...all.map((d) => d.observedAt));
			const t0 = t1 - 90 * 86_400_000;
			const plotW = W - 2 * PAD - 70;
			const xOf = (t: number) => PAD + ((t - t0) / (t1 - t0)) * plotW;
			const yOf = (x: number) => chartTop + chartH - ((x - lo) / Math.max(1e-9, hi - lo)) * chartH;
			ctx.lineWidth = 1;
			for (const g of [lo, (lo + hi) / 2, hi]) {
				ctx.strokeStyle = p.line;
				ctx.beginPath();
				ctx.moveTo(PAD, yOf(g));
				ctx.lineTo(W - PAD, yOf(g));
				ctx.stroke();
				ctx.fillStyle = p.text3;
				ctx.font = `400 18px ${MONO}`;
				ctx.textAlign = "right";
				ctx.fillText(num(g, 0, lang), W - PAD, yOf(g) - 6);
				ctx.textAlign = "left";
			}
			for (const s of series) {
				const pts = [...s.pts].sort((a, b) => a.observedAt - b.observedAt);
				ctx.strokeStyle = s.color;
				ctx.fillStyle = s.color;
				ctx.lineWidth = 4;
				ctx.lineJoin = "round";
				ctx.beginPath();
				pts.forEach((d, i) => {
					if (i) ctx.lineTo(xOf(d.observedAt), yOf(d.vesPerUsd));
					else ctx.moveTo(xOf(d.observedAt), yOf(d.vesPerUsd));
				});
				ctx.stroke();
				const last = pts.at(-1);
				if (last) {
					ctx.beginPath();
					ctx.arc(xOf(last.observedAt), yOf(last.vesPerUsd), 6, 0, Math.PI * 2);
					ctx.fill();
				}
			}
			// Legend with the series colours, and the span actually covered.
			let lx = PAD;
			ctx.font = `600 20px ${UI}`;
			ctx.fillStyle = p.text2;
			const lead = es ? "Últimos 90 días" : "Last 90 days";
			ctx.fillText(lead, lx, bottom);
			lx += ctx.measureText(lead).width + 28;
			for (const s of series) {
				if (!s.pts.length) continue;
				ctx.fillStyle = s.color;
				ctx.fillRect(lx, bottom - 9, 26, 4);
				lx += 34;
				ctx.fillStyle = p.text2;
				const label =
					s.pts.length < 30
						? `${s.label} (${s.pts.length} ${es ? (s.pts.length === 1 ? "día" : "días") : s.pts.length === 1 ? "day" : "days"})`
						: s.label;
				ctx.fillText(label, lx, bottom);
				lx += ctx.measureText(label).width + 28;
			}
		},
	});
}

export interface InternetCardInput {
	summary: { text: string };
	states: {
		id: string;
		name: string;
		level: "normal" | "drop" | "severe" | "no-data";
		headline: string;
		signals: { pctOfBaseline: number | null }[];
		spark: { values: (number | null)[] } | null;
	}[];
	asOf: number | null;
}

const LEVEL: Record<string, { es: string; en: string }> = {
	normal: { es: "Normal", en: "Normal" },
	drop: { es: "Caída de señal", en: "Signal drop" },
	severe: { es: "Caída fuerte", en: "Severe drop" },
	"no-data": { es: "Sin datos", en: "No data" },
};

export function internetCard(v: InternetCardInput, now: number, lang: Lang): Promise<Blob> {
	const es = lang === "es";
	const affected = v.states.filter((s) => s.level === "drop" || s.level === "severe");
	const others = v.states.filter((s) => s.level === "normal");
	const rows = [...affected, ...others].slice(0, 12);
	const fills: Record<string, StateFill> = {};
	for (const s of v.states)
		fills[s.id] = { tone: s.level === "drop" ? "drop" : s.level === "severe" ? "severe" : "ok" };
	return render({
		eyebrow: es ? "Internet por estado" : "Internet by state",
		headline: v.summary.text,
		...(affected.length ? { headlineColor: palette().warn } : {}),
		now,
		lang,
		feeds: ["ioda-states"],
		note: es
			? "Cada señal comparada con la misma franja horaria de los 7 días anteriores. Caída de señal no es lo mismo que apagón."
			: "Each signal against the same time slot over the previous 7 days. A signal drop is not the same as a blackout.",
		body: (ctx, p, top, bottom) => {
			const mapW = 400;
			drawMap(ctx, p, { x: W - PAD - mapW, y: top, w: mapW, h: Math.min(360, bottom - top) }, fills, []);
			const rowH = Math.min(56, (bottom - top) / Math.max(1, rows.length));
			const listW = W - 2 * PAD - mapW - 32;
			rows.forEach((s, i) => {
				const y = top + i * rowH + rowH * 0.62;
				const color = s.level === "severe" ? p.alert : s.level === "drop" ? p.warn : p.text2;
				ctx.fillStyle = color;
				ctx.beginPath();
				ctx.arc(PAD + 8, y - 8, 7, 0, Math.PI * 2);
				ctx.fill();
				ctx.fillStyle = p.text;
				ctx.font = `700 28px ${UI}`;
				ctx.fillText(s.name, PAD + 28, y);
				const worst = s.signals
					.map((x) => x.pctOfBaseline)
					.filter((x): x is number => x !== null)
					.sort((a, b) => a - b)[0];
				ctx.textAlign = "right";
				ctx.fillStyle = color;
				ctx.font = `600 24px ${UI}`;
				ctx.fillText(
					`${worst !== undefined ? `${num(worst, 0, lang)} % · ` : ""}${LEVEL[s.level]?.[lang] ?? ""}`,
					PAD + listW,
					y,
				);
				ctx.textAlign = "left";
				// 48 h strip under the name: % of normal per hour.
				const values = s.spark?.values ?? [];
				const sx = PAD + 28;
				const sw = listW - 28;
				const bw = sw / Math.max(1, values.length);
				values.forEach((val, j) => {
					if (val === null) return;
					const bh = (Math.max(0, Math.min(140, val)) / 140) * 14;
					ctx.fillStyle = val < 60 ? p.alert : val < 85 ? p.warn : p.border;
					ctx.fillRect(sx + j * bw, y + 22 - bh, Math.max(1, bw - 1), bh);
				});
			});
			ctx.fillStyle = p.text3;
			ctx.font = `400 19px ${UI}`;
			ctx.fillText(
				es ? "Barras: últimas 48 h, % de lo normal a esa hora" : "Bars: last 48 h, % of normal for the hour",
				W - PAD - mapW,
				top + Math.min(360, bottom - top) + 34,
			);
		},
	});
}

export interface QuakesCardInput {
	counts: { day: number; week: number; month: number };
	items: {
		at: number;
		lat: number;
		lon: number;
		maxMag: number;
		placeEs: string;
		zone: string;
	}[];
}

export function quakesCard(v: QuakesCardInput, now: number, lang: Lang): Promise<Blob> {
	const es = lang === "es";
	const near = v.items.filter((q) => q.zone !== "far");
	const strongest = [...near].sort((a, b) => b.maxMag - a.maxMag)[0];
	return render({
		eyebrow: es ? "Sismos en Venezuela y cerca" : "Earthquakes in and near Venezuela",
		headline: es
			? `${v.counts.day} ${v.counts.day === 1 ? "sismo" : "sismos"} en 24 h, ${v.counts.week} en 7 días`
			: `${v.counts.day} ${v.counts.day === 1 ? "quake" : "quakes"} in 24 h, ${v.counts.week} in 7 days`,
		...(strongest
			? {
					sub: es
						? `El mayor en 30 días: M${num(strongest.maxMag, 1, lang)} ${strongest.placeEs}`
						: `Strongest in 30 days: M${num(strongest.maxMag, 1, lang)} ${strongest.placeEs}`,
				}
			: {}),
		now,
		lang,
		feeds: ["usgs-quakes", "funvisis-quakes"],
		note: es
			? "Magnitud mayor entre USGS y FUNVISIS; cada fuente publica la suya."
			: "Larger magnitude of USGS and FUNVISIS; each source publishes its own.",
		body: (ctx, p, top, bottom) => {
			const listH = 5 * 44 + 10;
			drawMap(
				ctx,
				p,
				{ x: PAD, y: top, w: W - 2 * PAD, h: bottom - top - listH },
				{},
				near.map((q) => ({ lat: q.lat, lon: q.lon, mag: q.maxMag })),
			);
			let y = bottom - listH + 40;
			for (const q of [...near].sort((a, b) => b.at - a.at).slice(0, 5)) {
				ctx.fillStyle = p.signal;
				ctx.font = `800 26px ${UI}`;
				ctx.fillText(`M${num(q.maxMag, 1, lang)}`, PAD, y);
				ctx.fillStyle = p.text;
				ctx.font = `500 24px ${UI}`;
				const place = wrap(ctx, q.placeEs, W - 2 * PAD - 330)[0] ?? "";
				ctx.fillText(place, PAD + 90, y);
				ctx.textAlign = "right";
				ctx.fillStyle = p.text3;
				ctx.font = `400 22px ${MONO}`;
				ctx.fillText(stamp(q.at, lang), W - PAD, y);
				ctx.textAlign = "left";
				y += 44;
			}
		},
	});
}

export interface StateCardInput {
	iso: string;
	name: string;
	connectivity: { level: string; headline: string } | null;
	weather: { capital: string; temperatureC: number; labelEs: string } | null;
	fires: { likelyFires24h: number } | null;
	news: { items: number; stories: number } | null;
	quakes: { maxMag: number; placeEs: string; at: number; lat: number; lon: number }[];
	fill: StateFill | undefined;
}

const STATE_HEADLINE: Record<string, { es: string; en: string }> = {
	normal: { es: "internet normal", en: "internet normal" },
	drop: { es: "caída de señal de internet", en: "internet signal drop" },
	severe: { es: "caída fuerte de internet", en: "severe internet drop" },
	"no-data": { es: "sin datos de internet", en: "no internet data" },
};

export function stateCard(v: StateCardInput, now: number, lang: Lang): Promise<Blob> {
	const es = lang === "es";
	const level = v.connectivity?.level;
	const p0 = palette();
	const feeds = ["ioda-states", "open-meteo-weather", "usgs-quakes"];
	if (v.fires) feeds.push("firms-fires");
	return render({
		eyebrow: es ? `Estado ${v.name}` : `${v.name} state`,
		headline: v.connectivity
			? `${v.name}: ${STATE_HEADLINE[level ?? ""]?.[lang] ?? ""}`
			: `${v.name} ${es ? "ahora" : "now"}`,
		...(level === "severe"
			? { headlineColor: p0.alert }
			: level === "drop"
				? { headlineColor: p0.warn }
				: {}),
		...(v.connectivity ? { sub: v.connectivity.headline } : {}),
		now,
		lang,
		feeds,
		note: es
			? "Noticias ubicadas por palabra clave; clima: modelo Open-Meteo."
			: "News located by keyword; weather: Open-Meteo model.",
		body: (ctx, p, top, bottom) => {
			const mapW = 440;
			drawMap(
				ctx,
				p,
				{ x: W - PAD - mapW, y: top, w: mapW, h: bottom - top },
				v.fill ? { [v.iso]: v.fill } : {},
				v.quakes.map((q) => ({ lat: q.lat, lon: q.lon, mag: q.maxMag })),
				v.iso,
			);
			const x = PAD;
			let y = top;
			const block = (label: string, value: string, detail: string) => {
				ctx.fillStyle = p.text3;
				ctx.font = `700 20px ${UI}`;
				ctx.fillText(label.toUpperCase(), x, y + 20);
				ctx.fillStyle = p.text;
				ctx.font = `800 40px ${UI}`;
				ctx.fillText(value, x, y + 66);
				ctx.fillStyle = p.text2;
				ctx.font = `500 22px ${UI}`;
				ctx.fillText(wrap(ctx, detail, W - 2 * PAD - mapW - 40)[0] ?? "", x, y + 98);
				y += 128;
			};
			if (v.weather)
				block(
					es ? `Clima en ${v.weather.capital}` : `Weather in ${v.weather.capital}`,
					`${num(v.weather.temperatureC, 0, lang)}°`,
					v.weather.labelEs,
				);
			if (v.fires)
				block(
					es ? "Focos de calor, 24 h" : "Heat spots, 24 h",
					String(v.fires.likelyFires24h),
					es ? "probables incendios (NASA FIRMS)" : "likely fires (NASA FIRMS)",
				);
			block(
				es ? "Noticias, 24 h" : "News, 24 h",
				String(v.news?.items ?? 0),
				es ? `titulares · ${v.news?.stories ?? 0} historias` : `headlines · ${v.news?.stories ?? 0} stories`,
			);
			const q = v.quakes[0];
			block(
				es ? "Sismos, 30 días" : "Earthquakes, 30 days",
				String(v.quakes.length),
				q
					? `${es ? "último" : "latest"}: M${num(q.maxMag, 1, lang)} · ${ago(now - q.at, lang)}`
					: es
						? "ninguno con epicentro aquí"
						: "none with an epicentre here",
			);
		},
	});
}

/** Share through the phone's share sheet when available, otherwise download. */
export async function shareOrDownload(blob: Blob, name: string, title: string): Promise<void> {
	const file = new File([blob], name, { type: "image/png" });
	const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
	if (nav.canShare?.({ files: [file] })) {
		try {
			await navigator.share({ files: [file], title });
			return;
		} catch {
			// cancelled: fall through to download
		}
	}
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** File name with the time it shows: vigia-internet-2026-09-24-20-18.png. */
export function cardFileName(kind: string, now: number): string {
	return `vigia-${kind}-${new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.png`;
}
