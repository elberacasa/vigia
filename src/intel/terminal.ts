/**
 * The terminal report (wttr.in style): `curl localhost:7722` or GET /ahora.txt. Plain text, 80 columns, Spanish
 * first (?lang=en), ANSI colour only when asked (?color=1). Every line carries its source and the age of its data;
 * it is built only from the panels' computed views (the same numbers and the same "Ahora" rules as the web page).
 */

import { ago, clock, type Lang, num, pct, stamp, TZ } from "../../web/src/lib/format.ts";
import { clauseText, currentClauses, type HeadlineInput } from "../../web/src/lib/headline.ts";
import type { FeedHealth } from "../core/health.ts";
import type { Json } from "../core/types.ts";
import type { ConnectivityView, PlaceStatus } from "../panels/connectivity.ts";
import type { IncidentsView } from "../panels/incidents.ts";
import type { MoneyView } from "../panels/money.ts";
import type { QuakesView } from "../panels/quakes.ts";
import { clean } from "./text.ts";

export const WIDTH = 80;
const DAY = 86_400_000;

/** The panels the report reads. */
export const TERMINAL_PANELS = [
	"money",
	"connectivity",
	"quakes",
	"incidents",
	"nightlights",
	"hazards",
	"weather",
	"fires",
] as const;

type Tone = "normal" | "warn" | "alert" | "dim" | "head";

const ANSI: Record<Tone, string> = {
	normal: "",
	warn: "\x1b[33m",
	alert: "\x1b[31m",
	dim: "\x1b[2m",
	head: "\x1b[1m",
};
const RESET = "\x1b[0m";

export interface ReportInput {
	panels: Record<string, Json>;
	health: readonly Pick<FeedHealth, "id" | "state" | "lastSuccessAt">[];
	now: number;
	lang: Lang;
	color: boolean;
	/** Where the full page is, for the last line. */
	origin: string;
}

/** Wraps plain text to `width`, continuation lines indented by `indent` spaces. */
export function wrap(text: string, width: number, indent = 0): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const next = line ? `${line} ${word}` : word;
		const limit = lines.length === 0 ? width : width - indent;
		if (next.length > limit && line) {
			lines.push(line);
			line = word;
		} else line = next;
	}
	if (line) lines.push(line);
	return lines.map((l, i) => (i === 0 ? l : `${" ".repeat(indent)}${l}`));
}

function cut(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function renderReport(input: ReportInput): string {
	const { now, lang: l, color } = input;
	const es = l === "es";
	const t = (a: string, b: string) => (es ? a : b);
	const paint = (text: string, tone: Tone) =>
		color && tone !== "normal" ? `${ANSI[tone]}${text}${RESET}` : text;
	const health = new Map(input.health.map((h) => [h.id, h]));
	const late = (feed: string) => {
		const s = health.get(feed)?.state;
		return s === "stale" || s === "failing";
	};
	const out: string[] = [];

	/** A row: text on the left (may be cut), source and age right-aligned, both inside 80 columns. */
	const row = (rawLeft: string, rawRight: string, tone: Tone = "normal") => {
		const right = cut(clean(rawRight), 40);
		const room = WIDTH - right.length - 2;
		const l2 = cut(clean(rawLeft), room);
		out.push(`${paint(l2, tone)}${" ".repeat(WIDTH - l2.length - right.length)}${paint(right, "dim")}`);
	};
	const source = (name: string, at: number | null, feed?: string) =>
		`${name} · ${at === null ? t("sin datos", "no data") : ago(now - at, l)}${feed && late(feed) ? t(" (retraso)", " (late)") : ""}`;
	const heading = (text: string) => {
		out.push("");
		out.push(paint(text.toUpperCase(), "head"));
	};

	const title = t("VIGÍA · Venezuela ahora", "VIGÍA · Venezuela now");
	const when = `${stamp(now, l)} · ${t("hora de Caracas", "Caracas time")}`;
	out.push(`${paint(title, "head")}${" ".repeat(Math.max(1, WIDTH - title.length - when.length))}${when}`);
	out.push("─".repeat(WIDTH));

	// Ahora: the same clauses as the page, with the same freshness rule.
	const clauses = currentClauses(input.panels as HeadlineInput, health, now, l);
	if (clauses.length) {
		const label = t("AHORA  ", "NOW    ");
		const text = clean(clauses.map((c) => clauseText(c, now, l)).join(" · "));
		const lines = wrap(text, WIDTH - label.length, 0).map((line) => cut(line, WIDTH - label.length));
		const worst = clauses.some((c) => c.tone === "alert")
			? "alert"
			: clauses.some((c) => c.tone === "warn")
				? "warn"
				: "normal";
		lines.forEach((line, i) => {
			out.push(`${i === 0 ? paint(label, "head") : " ".repeat(label.length)}${paint(line, worst)}`);
		});
	}

	// Dollar.
	const money = input.panels.money as unknown as MoneyView | undefined;
	heading(t("Dólar", "Dollar"));
	const usd = money?.official.usd.current;
	if (usd) {
		const change = money?.official.usd.change24h;
		row(
			`  ${t("BCV oficial", "BCV official")}`.padEnd(18) +
				`${num(usd.vesPerUnit, 2, l)} Bs`.padStart(13) +
				(change ? `  ${pct(change.pct, 2, l)} ${t("en 24 h", "in 24 h")}` : ""),
			usd.route
				? source(usd.route.label, usd.validFrom, "bcv-api")
				: source("BCV", usd.validFrom, "bcv-official"),
		);
	} else row(`  ${t("BCV oficial", "BCV official")}`, t("sin datos", "no data"));
	const y = money?.yadio.figure;
	if (y) {
		row(
			"  Yadio (P2P)".padEnd(18) +
				`${num(y.vesPerUsd, 2, l)} Bs`.padStart(13) +
				(y.gap ? `  ${t("brecha", "gap")} ${pct(y.gap.pct, 1, l)}` : ""),
			source("Yadio", y.observedAt, "yadio"),
			y.gap && y.gap.pct >= 20 ? "warn" : "normal",
		);
	}
	for (const p of money?.p2p ?? []) {
		const buy = p.buy.medianVesPerUsdt;
		if (buy === null) continue;
		row(
			`  ${p.label}`.padEnd(18) +
				`${num(buy, 2, l)} Bs`.padStart(13) +
				(p.buy.gap ? `  ${t("brecha", "gap")} ${pct(p.buy.gap.pct, 1, l)}` : ""),
			source(p.label.split(" ")[0] ?? p.feed, p.observedAt, p.feed),
		);
	}

	// Internet by state, worst first.
	const conn = input.panels.connectivity as unknown as ConnectivityView | undefined;
	heading(t("Internet por estado (IODA, peor primero)", "Internet by state (IODA, worst first)"));
	if (!conn || conn.asOf === null) out.push(t("  Sin datos de IODA.", "  No IODA data."));
	else {
		const worstPct = (p: PlaceStatus) =>
			Math.min(...p.signals.map((s) => s.pctOfBaseline ?? Number.POSITIVE_INFINITY));
		const levelName: Record<string, string> = es
			? { severe: "caída fuerte", drop: "caída", normal: "normal", "no-data": "sin datos" }
			: { severe: "severe drop", drop: "drop", normal: "normal", "no-data": "no data" };
		const bad = conn.states.filter((s) => s.level === "severe" || s.level === "drop");
		for (const s of bad) {
			const w = worstPct(s);
			row(
				`  ${s.name.padEnd(20)} ${levelName[s.level]?.padEnd(13) ?? ""}${Number.isFinite(w) ? `${num(w, 1, l)}${es ? " %" : "%"} ${t("de lo normal", "of normal")}` : ""}`,
				source("IODA", s.lastBinAt, "ioda-states"),
				s.level === "severe" ? "alert" : "warn",
			);
		}
		const normal = conn.states.filter((s) => s.level === "normal").sort((a, b) => worstPct(a) - worstPct(b));
		if (normal.length) {
			out.push(
				paint(
					`  ${t("Normales", "Normal")} (${normal.length}), ${t("% de lo normal a esta hora", "% of normal for this hour")}:`,
					"dim",
				),
			);
			const cells = normal.map((s) => {
				const w = worstPct(s);
				return `${cut(s.name, 17)} ${Number.isFinite(w) ? `${num(w, 0, l)}%` : "—"}`.padEnd(25);
			});
			for (let i = 0; i < cells.length; i += 3)
				out.push(
					`  ${cells
						.slice(i, i + 3)
						.join(" ")
						.trimEnd()}`,
				);
		}
		const noData = conn.states.filter((s) => s.level === "no-data");
		if (noData.length)
			for (const line of wrap(
				`${t("Sin datos", "No data")} (${noData.length}): ${noData.map((s) => s.name).join(", ")}`,
				WIDTH - 2,
				2,
			))
				out.push(paint(`  ${line}`, "dim"));
		out.push(paint(`  ${source("IODA, Georgia Tech", conn.asOf, "ioda-states")}`, "dim"));
	}

	// Quakes.
	const quakes = input.panels.quakes as unknown as QuakesView | undefined;
	heading(t("Sismos, 24 h, Venezuela y cerca", "Earthquakes, 24 h, Venezuela and nearby"));
	const day = (quakes?.items ?? []).filter((q) => q.zone !== "far" && now - q.at < DAY && q.at <= now);
	const quakeFeeds = ["usgs-quakes", "funvisis-quakes"].map((id) => health.get(id));
	const checked = Math.max(0, ...quakeFeeds.map((h) => h?.lastSuccessAt ?? 0));
	// "None" is a claim about the last 24 h: only when at least one quake feed is on time (as the brief does).
	const quakesFresh = quakeFeeds.some((h) => h?.state === "ok");
	if (!quakes) out.push(t("  Sin datos.", "  No data."));
	else if (day.length === 0) {
		row(
			quakesFresh
				? `  ${t("Ninguno en 24 h", "None in 24 h")}`
				: `  ${t("Sin datos recientes de sismos", "No recent earthquake data")}`,
			checked ? `USGS, FUNVISIS · ${t("revisado", "checked")} ${ago(now - checked, l)}` : "USGS, FUNVISIS",
			quakesFresh ? "normal" : "warn",
		);
	} else {
		for (const q of [...day].sort((a, b) => b.maxMag - a.maxMag).slice(0, 5)) {
			const who = [q.usgs ? "USGS" : null, q.funvisis ? "FUNVISIS" : null].filter(Boolean).join("+");
			row(
				`  M${num(q.maxMag, 1, l)}  ${q.placeEs}`,
				`${who} · ${ago(now - q.at, l)}`,
				q.feltSize ? "warn" : "normal",
			);
		}
		if (day.length > 5)
			out.push(paint(`  ${t(`y ${day.length - 5} más`, `and ${day.length - 5} more`)}`, "dim"));
		if (!quakesFresh)
			out.push(
				paint(
					`  ${t("Fuentes con retraso: puede haber sismos más recientes.", "Sources late: there may be newer quakes.")}`,
					"dim",
				),
			);
	}

	// Incidents: those where independent sources agree, then (apart) those only the press reports.
	const incidents = input.panels.incidents as unknown as IncidentsView | undefined;
	heading(
		t("Incidentes (fuentes independientes que coinciden)", "Incidents (independent sources that agree)"),
	);
	if (!incidents) out.push(t("  Sin datos.", "  No data."));
	else {
		const active = incidents.incidents.filter((i) => i.status === "active");
		const agreed = active.filter((i) => !i.reportsOnly);
		const pressOnly = active.filter((i) => i.reportsOnly);
		const names: Record<string, string> = {
			ioda: "IODA",
			"ripe-atlas": "RIPE Atlas",
			viirs: "NASA",
			usgs: "USGS",
			funvisis: "FUNVISIS",
			prensa: t("prensa", "press"),
			gdacs: "GDACS",
		};
		const caracasDate = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(at);
		// The start time alone is ambiguous for an incident that started before today (Caracas time).
		const since = (at: number) =>
			`${t("desde", "since")} ${caracasDate(at) === caracasDate(now) ? clock(at, l) : stamp(at, l)}`;
		const list = (items: typeof active, max: number) => {
			for (const i of items.slice(0, max)) {
				row(
					`  ${i.reportsOnly ? "○" : "●"} ${i.title[l]}`,
					since(i.startAt),
					i.reportsOnly ? "normal" : "warn",
				);
				const detail = i.reportsOnly
					? t(
							`solo reportes de ${i.outlets} medios, sin medición`,
							`reports only, ${i.outlets} outlets, no measurement`,
						)
					: `${i.strength[l]} · ${i.families.map((f) => names[f] ?? f).join(", ")}`;
				row(`    ${detail}`, `${t("última", "last")} ${ago(now - i.lastEvidenceAt, l)}`, "dim");
				for (const note of i.lateNotes ?? []) row(`    ${note[l]}`, "", "dim");
			}
			if (items.length > max)
				out.push(paint(`  ${t(`y ${items.length - max} más`, `and ${items.length - max} more`)}`, "dim"));
		};
		if (agreed.length === 0)
			out.push(
				t(
					"  Ninguna coincidencia ahora (no significa que no pase nada).",
					"  Nothing agrees right now (it does not mean nothing is happening).",
				),
			);
		list(agreed, 8);
		if (pressOnly.length) {
			heading(t("Solo reportes de prensa (sin medición)", "Press reports only (no measurement)"));
			list(pressOnly, 5);
		}
		// One measured family alone: shown apart, never counted as an incident.
		const watches = incidents.watches ?? [];
		if (watches.length) {
			heading(
				t("Señales sin corroborar (una sola fuente medida)", "Uncorroborated signals (one measured source)"),
			);
			for (const w of watches.slice(0, 6))
				row(
					`  · ${w.title[l]} · ${w.families.map((f) => names[f] ?? f).join(", ")}`,
					`${t("última", "last")} ${ago(now - w.lastEvidenceAt, l)}`,
					"dim",
				);
			if (watches.length > 6)
				out.push(paint(`  ${t(`y ${watches.length - 6} más`, `and ${watches.length - 6} more`)}`, "dim"));
		}
		const ended = incidents.incidents.length - active.length;
		if (ended)
			out.push(
				paint(
					`  ${t(`${ended} ${ended === 1 ? "terminado" : "terminados"} en 48 h`, `${ended} ended in the last 48 h`)}`,
					"dim",
				),
			);
	}

	out.push("");
	out.push("─".repeat(WIDTH));
	for (const line of wrap(
		t(
			`Cada línea: fuente · edad del dato. Números calculados por código, sin IA. Todo, con enlaces y reglas: ${input.origin}/  ·  ?lang=en  ?color=1`,
			`Each line: source · age of the data. Numbers computed by code, no AI. Everything, with links and rules: ${input.origin}/  ·  ?lang=es  ?color=1`,
		),
		WIDTH,
	))
		out.push(paint(cut(clean(line), WIDTH), "dim"));
	return `${out.join("\n")}\n`;
}
