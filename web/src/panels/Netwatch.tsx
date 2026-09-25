import { useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { healthById, now, panels } from "../lib/data.ts";
import { ago, int, num, pct, stamp } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { openLookup } from "../lib/lookup.ts";
import { PANEL_META } from "../lib/panel-meta.ts";
import { link } from "../lib/router.ts";
import netwatchCss from "../styles/netwatch.css?inline";
import panelsCss from "../styles/panels.css?inline";
import { Panel } from "../ui/Panel.tsx";
import { SourceTag } from "../ui/Source.tsx";

addStyles(panelsCss);

addStyles(netwatchCss);

/** Mirrors src/panels/netwatch.ts. The server computes every figure; this file only lays them out. */
export type Layer = "dns" | "tcp" | "tls";
export interface TorPoint {
	day: number;
	users: number;
	lower: number | null;
	upper: number | null;
	flag: "up" | "down" | null;
}
export interface MatrixCell {
	isp: string;
	state: "blocked" | "unclear" | "ok" | "few";
	layers: Layer[];
	likelihoodPct: number;
	outcome: string | null;
	n: number;
	firstSeen: number | null;
	lastSeen: number | null;
}
interface RouteEvent {
	isp: string;
	asn: string;
	kind: "withdrawal" | "announcement" | "move";
	after: number;
	by: number;
	at: number | null;
	prefixes: number;
	addresses: number;
	sharePct: number;
	other: { asn: string; isp: string | null } | null;
	url: string;
}
interface PortalReading {
	state: "ok" | "odd-response" | "refuses" | "server-error" | "no-answer" | "no-dns";
	httpStatus: number | null;
	redirectHost: string | null;
	latencyMs: number | null;
	error: string | null;
	tlsAuthorized: boolean | null;
	tlsError: string | null;
}
export interface NetwatchView {
	tor: {
		relay: TorPoint[];
		bridge: TorPoint[];
		latest: { day: number; relay: number | null; bridge: number | null; relayFrac: number | null } | null;
		relayChangePct: number | null;
		recentFlags: { day: number; series: "relay" | "bridge"; flag: "up" | "down"; users: number }[];
		fetchedAt: number | null;
		sourceUrl: string;
		ruleEs: string;
		ruleEn: string;
	};
	routing: {
		isps: {
			isp: string;
			name: string;
			asns: string[];
			at: number | null;
			v4Prefixes: number;
			v6Prefixes: number;
			v4Addresses: number;
			events: number;
			minorChanges: number;
		}[];
		events: RouteEvent[];
		watchingSince: number | null;
		newestAt: number | null;
		ruleEs: string;
		ruleEn: string;
	};
	methods: {
		days: number[];
		skippedDays: number[];
		rows: { domain: string; cells: MatrixCell[]; blockedOn: number }[];
		totalBlocked: number;
		byIsp: {
			isp: string;
			name: string;
			dns: number;
			tcp: number;
			tls: number;
			blocked: number;
			tested: number;
		}[];
		watchingSince: number | null;
		fetchedAt: number | null;
		ruleEs: string;
		ruleEn: string;
	};
	portals: {
		hasData: boolean;
		rows: {
			id: string;
			name: string;
			what: string;
			url: string;
			reading: PortalReading | null;
			at: number | null;
			readings24h: number;
			answered24h: number;
			certDays: number | null;
			dnsChangedAt: number | null;
			dnsChanges7d: number;
		}[];
		newestAt: number | null;
		vantageEs: string;
		vantageEn: string;
	};
}

type Tab = "blocks" | "tor" | "routes" | "portals";

/** A UTC day (Tor, OONI and RIS days are UTC) as "24 sept", never shifted into Caracas time. */
export function dayLabel(day: number, l: "es" | "en"): string {
	return new Intl.DateTimeFormat(l === "es" ? "es-VE" : "en-US", {
		timeZone: "UTC",
		day: "numeric",
		month: "short",
	})
		.format(day)
		.replace(".", "");
}

/** "DNS" / "TLS" / "TCP": the step a block works on. */
export function layerLabel(l: Layer): string {
	return l.toUpperCase();
}

/** OONI's outcome in words: "dns.nxdomain" → "DNS responde «no existe»". */
export function outcomeLabel(outcome: string | null): string {
	switch (outcome) {
		case "dns.nxdomain":
			return t("DNS responde «no existe»", "DNS answers “does not exist”");
		case "dns.dns_no_answer":
			return t("DNS no devuelve dirección", "DNS returns no address");
		case "dns.got_answer":
			return t("DNS devuelve una dirección falsa", "DNS returns a false address");
		case "dns.dns_servfail_error":
			return t("DNS falla a propósito (SERVFAIL)", "DNS fails on purpose (SERVFAIL)");
		case "tls.connection_reset":
			return t("conexión TLS cortada (filtro por nombre, SNI)", "TLS connection cut (name filter, SNI)");
		case null:
			return "";
		default:
			return outcome.includes("timeout")
				? t("solo tiempo agotado (puede ser el sitio caído)", "timeouts only (the site may be down)")
				: outcome;
	}
}

/** Short, readable abbreviations for the matrix columns. */
const SHORT: Record<string, string> = {
	cantv: "CNTV",
	movilnet: "Mnet",
	movistar: "Mstr",
	digitel: "Digi",
	inter: "Intr",
	airtek: "Airt",
	netuno: "NetU",
	thundernet: "Thdr",
	"g-network": "GNet",
};

function cellTitle(domain: string, isp: string, c: MatrixCell): string {
	const l = lang.value;
	const seen =
		c.firstSeen !== null && c.lastSeen !== null
			? t(
					` · visto ${dayLabel(c.firstSeen, l)} → ${dayLabel(c.lastSeen, l)}`,
					` · seen ${dayLabel(c.firstSeen, l)} → ${dayLabel(c.lastSeen, l)}`,
				)
			: "";
	switch (c.state) {
		case "blocked":
			return `${domain} · ${isp}: ${t("bloqueado", "blocked")}, ${outcomeLabel(c.outcome)} (${c.likelihoodPct} %, ${int(c.n, l)} ${t("mediciones", "measurements")})${seen}`;
		case "unclear":
			return `${domain} · ${isp}: ${t("dudoso", "unclear")}, ${outcomeLabel(c.outcome)} (${int(c.n, l)} ${t("mediciones", "measurements")})`;
		case "ok":
			return `${domain} · ${isp}: ${t("sin bloqueo en", "no block in")} ${int(c.n, l)} ${t("mediciones", "measurements")}`;
		case "few":
			return `${domain} · ${isp}: ${c.n ? t(`solo ${c.n} mediciones`, `only ${c.n} measurements`) : t("sin mediciones", "no measurements")}`;
	}
}

export function Cell({ domain, isp, c }: { domain: string; isp: string; c: MatrixCell }) {
	const title = cellTitle(domain, isp, c);
	const lead = c.layers[0];
	return (
		<span
			class={`nw-cell nw-cell--${c.state}${lead ? ` nw-cell--${lead}` : ""}`}
			title={title}
			role="img"
			aria-label={title}
		>
			{c.state === "blocked" && lead
				? layerLabel(lead).slice(0, 1)
				: c.state === "unclear"
					? "?"
					: c.state === "ok"
						? "·"
						: ""}
		</span>
	);
}

function Blocks({ v }: { v: NetwatchView["methods"] }) {
	const l = lang.value;
	const [more, setMore] = useState(false);
	const [q, setQ] = useState("");
	const [emptyAsk, setEmptyAsk] = useState(false);
	const names = new Map(v.byIsp.map((b) => [b.isp, b.name]));
	const maxBlocked = Math.max(1, ...v.byIsp.map((b) => b.blocked));
	const last = v.days.at(-1);
	if (!v.days.length)
		return (
			<p class="empty">
				{t(
					"Aún no hay días completos de OONI guardados. La primera lectura llega en la próxima consulta diaria.",
					"No complete OONI days stored yet. The first reading arrives with the next daily fetch.",
				)}
			</p>
		);
	return (
		<>
			<div class="nw-lead">
				<div class="figure">
					<span class="figure__label">
						{t("Sitios bloqueados en al menos un proveedor", "Sites blocked on at least one ISP")}
					</span>
					<span class="figure__value">{int(v.totalBlocked, l)}</span>
					<span class="note">
						{t(
							`OONI, ${v.days.length} días completos hasta el ${last ? dayLabel(last, l) : "—"}`,
							`OONI, ${v.days.length} complete days to ${last ? dayLabel(last, l) : "—"}`,
						)}
					</span>
				</div>
			</div>
			<h3 class="caps nw-h">{t("Cómo bloquea cada proveedor", "How each ISP blocks")}</h3>
			<ul
				class="nw-bars"
				aria-label={t("Sitios bloqueados por proveedor y método", "Blocked sites by ISP and method")}
			>
				{v.byIsp.map((b) => (
					<li key={b.isp}>
						<span class="nw-bars__name">{b.name}</span>
						{b.tested === 0 ? (
							<span class="nw-bars__none note">
								{t("sin mediciones suficientes", "not enough measurements")}
							</span>
						) : (
							<>
								<span class="nw-bars__track" aria-hidden="true">
									<i class="nw-bars__dns" style={{ width: `${(b.dns / maxBlocked) * 100}%` }} />
									<i class="nw-bars__tls" style={{ width: `${(b.tls / maxBlocked) * 100}%` }} />
									<i class="nw-bars__tcp" style={{ width: `${(b.tcp / maxBlocked) * 100}%` }} />
								</span>
								<span class="nw-bars__n data">
									{int(b.blocked, l)}
									<span class="sr-only">
										{t(
											`: ${b.dns} por DNS, ${b.tls} por TLS, de ${b.tested} sitios medidos`,
											`: ${b.dns} by DNS, ${b.tls} by TLS, of ${b.tested} sites measured`,
										)}
									</span>
								</span>
							</>
						)}
					</li>
				))}
			</ul>
			<p class="nw-legend note">
				<span class="nw-key nw-key--dns">D</span> DNS
				<span class="nw-key nw-key--tls">T</span> {t("TLS (SNI)", "TLS (SNI)")}
				<span class="nw-key nw-key--ok">·</span> {t("sin bloqueo", "no block")}
				<span class="nw-key nw-key--unclear">?</span> {t("dudoso", "unclear")}
				<span class="nw-key nw-key--few" /> {t("pocas mediciones", "few measurements")}
			</p>
			<div class="nw-matrix-wrap">
				<table class="nw-matrix">
					<caption class="sr-only">
						{t("Sitios bloqueados por proveedor, con el método", "Blocked sites by ISP, with the method")}
					</caption>
					<thead>
						<tr>
							<th scope="col" class="nw-matrix__domain">
								{t("Sitio", "Site")}
							</th>
							{v.byIsp.map((b) => (
								<th scope="col" key={b.isp} title={b.name}>
									<abbr title={b.name}>{SHORT[b.isp] ?? b.name}</abbr>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{v.rows.slice(0, more ? 40 : 10).map((r) => (
							<tr key={r.domain}>
								<th scope="row" class="nw-matrix__domain">
									<a
										href={`/bloqueos?dominio=${encodeURIComponent(r.domain)}`}
										onClick={(e) => {
											if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
											e.preventDefault();
											openLookup(r.domain);
										}}
									>
										{r.domain}
									</a>
								</th>
								{r.cells.map((c) => (
									<td key={c.isp}>
										<Cell domain={r.domain} isp={names.get(c.isp) ?? c.isp} c={c} />
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{v.rows.length > 10 ? (
				<button type="button" class="link-button" onClick={() => setMore(!more)}>
					{more
						? t("Ver menos", "Show fewer")
						: t(
								`Ver ${Math.min(40, v.rows.length)} de ${int(v.totalBlocked, l)}`,
								`Show ${Math.min(40, v.rows.length)} of ${int(v.totalBlocked, l)}`,
							)}
				</button>
			) : null}
			<form
				class="nw-search"
				action="/bloqueos"
				method="get"
				onSubmit={(e) => {
					e.preventDefault();
					const d = q.trim();
					if (d) openLookup(d);
					else {
						// An empty ask gets a clear answer, never silence.
						setEmptyAsk(true);
						(e.currentTarget.elements.namedItem("dominio") as HTMLInputElement | null)?.focus();
					}
				}}
			>
				<label for="nw-q">{t("¿Está bloqueado?", "Is it blocked?")}</label>
				<input
					id="nw-q"
					name="dominio"
					type="text"
					inputMode="url"
					autoComplete="off"
					spellcheck={false}
					placeholder="infobae.com"
					value={q}
					aria-describedby="nw-q-hint"
					onInput={(e) => {
						setQ((e.target as HTMLInputElement).value);
						setEmptyAsk(false);
					}}
				/>
				<button type="submit" class="button">
					{t("Consultar", "Look up")}
				</button>
				<p id="nw-q-hint" class="nw-search__hint" role="status">
					{emptyAsk
						? t(
								"Escribe un sitio, por ejemplo infobae.com, y pulsa Consultar.",
								"Type a site, for example infobae.com, then press Look up.",
							)
						: ""}
				</p>
			</form>
			{v.skippedDays.length ? (
				<p class="note">
					{t(
						`${v.skippedDays.length} día(s) omitidos: OONI tuvo menos de la mitad de su volumen habitual.`,
						`${v.skippedDays.length} day(s) skipped: OONI had under half its usual volume.`,
					)}
				</p>
			) : null}
			{v.fetchedAt && last ? (
				<div class="sources-row">
					<SourceTag
						source={{
							feed: "ooni-methods",
							observedAt: last,
							url: "https://explorer.ooni.org/country/VE",
							detail: l === "es" ? v.ruleEs : v.ruleEn,
						}}
						label="OONI"
					/>
				</div>
			) : null}
		</>
	);
}

/** 90-day line of Tor users with Tor Metrics' expected range as a band and flagged days as dots. */
export function TorChart({ points, summary }: { points: TorPoint[]; summary: string }) {
	const w = 320;
	const h = 96;
	const pad = { l: 2, r: 2, t: 6, b: 6 };
	if (points.length < 2) return <p class="note">{summary}</p>;
	const values = points.flatMap((p) => [p.users, p.lower ?? p.users, p.upper ?? p.users]);
	const max = Math.max(...values);
	const min = Math.min(0, ...values);
	const x0 = points[0]?.day ?? 0;
	const span = (points.at(-1)?.day ?? x0 + 1) - x0 || 1;
	const x = (d: number) => pad.l + ((d - x0) / span) * (w - pad.l - pad.r);
	const y = (v: number) => pad.t + (1 - (v - min) / (max - min || 1)) * (h - pad.t - pad.b);
	const banded = points.filter((p) => p.lower !== null && p.upper !== null);
	const band = banded.length
		? `${banded.map((p, i) => `${i ? "L" : "M"}${x(p.day).toFixed(1)} ${y(p.upper as number).toFixed(1)}`).join("")}${[
				...banded,
			]
				.reverse()
				.map((p) => `L${x(p.day).toFixed(1)} ${y(p.lower as number).toFixed(1)}`)
				.join("")}Z`
		: "";
	const line = points
		.map((p, i) => `${i ? "L" : "M"}${x(p.day).toFixed(1)} ${y(p.users).toFixed(1)}`)
		.join("");
	return (
		<figure class="nw-chart">
			<svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
				{band ? <path d={band} class="nw-chart__band" /> : null}
				<path d={line} class="nw-chart__line" vector-effect="non-scaling-stroke" />
			</svg>
			{/* Dots in HTML so they stay round when the SVG stretches. */}
			{points
				.filter((p) => p.flag)
				.map((p) => (
					<i
						key={p.day}
						class={`nw-chart__dot nw-chart__dot--${p.flag}`}
						style={{ left: `${(x(p.day) / w) * 100}%`, top: `${(y(p.users) / h) * 100}%` }}
						aria-hidden="true"
					/>
				))}
			<figcaption class="sr-only">{summary}</figcaption>
		</figure>
	);
}

function Tor({ v }: { v: NetwatchView["tor"] }) {
	const l = lang.value;
	if (!v.latest) return <p class="empty">{t("Aún sin datos de Tor Metrics.", "No Tor Metrics data yet.")}</p>;
	const first = v.relay[0];
	const lastDay = v.latest.day;
	const flags = v.relay.filter((p) => p.flag);
	const summary = t(
		`Usuarios de Tor desde Venezuela, ${v.relay.length} días. ${flags.length} días fuera del rango esperado.`,
		`Tor users from Venezuela, ${v.relay.length} days. ${flags.length} days outside the expected range.`,
	);
	return (
		<>
			<div class="stat-row">
				<div class="figure">
					<span class="figure__label">{t("Conexiones directas", "Direct users")}</span>
					<span class="figure__value">{v.latest.relay !== null ? int(v.latest.relay, l) : "—"}</span>
					<span class="note">
						{t("usuarios/día", "users/day")}
						{v.relayChangePct !== null ? (
							<span class="nw-change">
								{t(
									`${pct(v.relayChangePct, 1, l)} vs. mediana 28 d`,
									`${pct(v.relayChangePct, 1, l)} vs. 28-d median`,
								)}
							</span>
						) : null}
					</span>
				</div>
				<div class="figure">
					<span class="figure__label">{t("Por puentes", "Via bridges")}</span>
					<span class="figure__value">{v.latest.bridge !== null ? int(v.latest.bridge, l) : "—"}</span>
					<span class="note">{t("usuarios/día", "users/day")}</span>
				</div>
			</div>
			<TorChart points={v.relay} summary={summary} />
			<p class="nw-axis note data">
				<span>{first ? dayLabel(first.day, l) : ""}</span>
				<span>
					<i class="nw-key nw-key--band" /> {t("rango esperado (Tor)", "expected range (Tor)")}
				</span>
				<span>{dayLabel(lastDay, l)}</span>
			</p>
			{v.recentFlags.length ? (
				<ul class="nw-events">
					{v.recentFlags.slice(0, 5).map((f) => (
						<li
							key={`${f.series}-${f.day}`}
							class={`nw-event nw-event--${f.flag === "up" ? "warn" : "info"}`}
						>
							<span class="data">{dayLabel(f.day, l)}</span>{" "}
							{f.series === "relay"
								? f.flag === "up"
									? t(
											`${int(f.users, l)} usuarios directos, sobre el rango esperado`,
											`${int(f.users, l)} direct users, above the expected range`,
										)
									: t(
											`${int(f.users, l)} usuarios directos, bajo el rango esperado`,
											`${int(f.users, l)} direct users, below the expected range`,
										)
								: f.flag === "up"
									? t(
											`${int(f.users, l)} usuarios por puentes, subida inusual`,
											`${int(f.users, l)} bridge users, unusual rise`,
										)
									: t(
											`${int(f.users, l)} usuarios por puentes, bajada inusual`,
											`${int(f.users, l)} bridge users, unusual drop`,
										)}
						</li>
					))}
				</ul>
			) : (
				<p class="note">
					{t(
						`Ningún día fuera de lo esperado en los últimos 30 días (hasta el ${dayLabel(lastDay, l)}; Tor publica con ~2 días de retraso).`,
						`No day outside the expected range in the last 30 days (to ${dayLabel(lastDay, l)}; Tor publishes ~2 days late).`,
					)}
				</p>
			)}
			<div class="sources-row">
				<SourceTag
					source={{
						feed: "tor-metrics",
						observedAt: lastDay,
						url: v.sourceUrl,
						detail: l === "es" ? v.ruleEs : v.ruleEn,
					}}
					label="Tor Metrics"
				/>
			</div>
		</>
	);
}

function addresses(n: number, l: "es" | "en"): string {
	if (n >= 1_000_000) return `${num(n / 1_000_000, 2, l)} M`;
	if (n >= 10_000) return `${int(Math.round(n / 1_000), l)} k`;
	return int(n, l);
}

function Routes({ v }: { v: NetwatchView["routing"] }) {
	const l = lang.value;
	const name = (isp: string | null, asn: string) => v.isps.find((i) => i.isp === isp)?.name ?? `AS${asn}`;
	if (!v.isps.length)
		return <p class="empty">{t("Aún sin lecturas de RIPE RIS.", "No RIPE RIS readings yet.")}</p>;
	return (
		<>
			<div class="nw-routes-wrap">
				<table class="nw-routes">
					<caption class="sr-only">
						{t("Prefijos anunciados por proveedor", "Announced prefixes per ISP")}
					</caption>
					<thead>
						<tr>
							<th scope="col">{t("Proveedor", "ISP")}</th>
							<th scope="col" class="num">
								{t("Prefijos IPv4", "IPv4 prefixes")}
							</th>
							<th scope="col" class="num">
								{t("Direcciones", "Addresses")}
							</th>
							<th scope="col" class="num">
								IPv6
							</th>
							<th scope="col" class="num">
								{t("Eventos 30 d", "Events 30 d")}
							</th>
						</tr>
					</thead>
					<tbody>
						{v.isps.map((i) => (
							<tr key={i.isp}>
								<th scope="row">
									{i.name} <span class="note data">{i.asns.map((a) => `AS${a}`).join(" ")}</span>
								</th>
								<td class="num data">{int(i.v4Prefixes, l)}</td>
								<td class="num data">{addresses(i.v4Addresses, l)}</td>
								<td class="num data">{int(i.v6Prefixes, l)}</td>
								<td class={`num data${i.events ? " nw-hot" : ""}`}>{int(i.events, l)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{v.events.length ? (
				<ul class="nw-events">
					{v.events.slice(0, 8).map((e) => (
						<li
							key={`${e.asn}-${e.by}-${e.kind}-${e.other?.asn ?? ""}`}
							class={`nw-event nw-event--${e.kind === "withdrawal" ? "alert" : "info"}`}
						>
							<a href={e.url} target="_blank" rel="noopener noreferrer">
								{e.kind === "withdrawal"
									? t(
											`${name(e.isp, e.asn)} dejó de anunciar ${int(e.prefixes, l)} prefijos (${num(e.sharePct, 1, l)} % de su espacio IPv4)`,
											`${name(e.isp, e.asn)} withdrew ${int(e.prefixes, l)} prefixes (${num(e.sharePct, 1, l)} % of its IPv4 space)`,
										)
									: e.kind === "announcement"
										? t(
												`${name(e.isp, e.asn)} empezó a anunciar ${int(e.prefixes, l)} prefijos (+${num(e.sharePct, 1, l)} % de espacio)`,
												`${name(e.isp, e.asn)} began announcing ${int(e.prefixes, l)} prefixes (+${num(e.sharePct, 1, l)} % space)`,
											)
										: t(
												`${int(e.prefixes, l)} prefijos pasaron de ${name(e.isp, e.asn)} a ${name(e.other?.isp ?? null, e.other?.asn ?? "")}`,
												`${int(e.prefixes, l)} prefixes moved from ${name(e.isp, e.asn)} to ${name(e.other?.isp ?? null, e.other?.asn ?? "")}`,
											)}
							</a>
							<span class="note data">
								{e.at !== null
									? t(`hacia las ${stamp(e.at, l)} (RIS)`, `around ${stamp(e.at, l)} (RIS)`)
									: t(
											`entre ${stamp(e.after, l)} y ${stamp(e.by, l)}`,
											`between ${stamp(e.after, l)} and ${stamp(e.by, l)}`,
										)}
							</span>
						</li>
					))}
				</ul>
			) : (
				<p class="note">
					{v.watchingSince
						? t(
								`Sin retiros ni movimientos de rutas por encima del umbral en 30 días (Vigía compara desde el ${stamp(v.watchingSince, l)}).`,
								`No route withdrawals or moves above the threshold in 30 days (Vigía has compared since ${stamp(v.watchingSince, l)}).`,
							)
						: t("Aún sin dos fotos de RIS para comparar.", "Not yet two RIS snapshots to compare.")}
				</p>
			)}
			{v.newestAt ? (
				<div class="sources-row">
					<SourceTag
						source={{
							feed: "ripestat-prefixes",
							observedAt: v.newestAt,
							url: "https://stat.ripe.net/app/launchpad/AS8048",
							detail: l === "es" ? v.ruleEs : v.ruleEn,
						}}
						label="RIPE RIS"
					/>
				</div>
			) : null}
		</>
	);
}

function portalState(r: PortalReading): { tone: "ok" | "warn" | "alert" | "muted"; text: string } {
	switch (r.state) {
		case "ok":
			return { tone: "ok", text: t(`responde (${r.httpStatus})`, `answers (${r.httpStatus})`) };
		case "odd-response":
			return { tone: "ok", text: t("responde (HTTP no estándar)", "answers (non-standard HTTP)") };
		case "refuses":
			return { tone: "warn", text: t(`rechaza (${r.httpStatus})`, `refuses (${r.httpStatus})`) };
		case "server-error":
			return {
				tone: "alert",
				text: t(`error del servidor (${r.httpStatus})`, `server error (${r.httpStatus})`),
			};
		case "no-answer":
			return {
				tone: "muted",
				text:
					r.tlsError === "reset" || r.error === "reset"
						? t("no responde desde aquí (conexión cortada)", "no answer from here (connection cut)")
						: r.error === "tls"
							? t("no responde desde aquí (error TLS)", "no answer from here (TLS error)")
							: r.error === "timeout"
								? t("no responde desde aquí (tiempo agotado)", "no answer from here (timeout)")
								: t("no responde desde aquí", "no answer from here"),
			};
		case "no-dns":
			return { tone: "muted", text: t("su DNS no responde desde aquí", "its DNS gives no answer from here") };
	}
}

function Portals({ v }: { v: NetwatchView["portals"] }) {
	const l = lang.value;
	const state = healthById.value.get("portal-probe")?.state;
	if (!v.hasData)
		return (
			<div class="nw-optin">
				<p>
					{state === "off"
						? t(
								"Este sondeo está apagado: visitaría desde tu conexión la portada de 13 portales públicos (BCV, CNE, SENIAT, SAIME, Patria…) cada 15 minutos, identificándose como Vigía. Sus operadores verían tu dirección IP.",
								"This probe is off: from your connection it would visit the home page of 13 public portals (BCV, CNE, SENIAT, SAIME, Patria…) every 15 minutes, identifying as Vigía. Their operators would see your IP address.",
							)
						: t("Aún sin mediciones.", "No measurements yet.")}
				</p>
				{state === "off" ? (
					<a class="button" {...link("guide")}>
						{t("Activarlo en la guía", "Turn it on in the guide")} →
					</a>
				) : null}
			</div>
		);
	return (
		<>
			<p class="nw-vantage">{l === "es" ? v.vantageEs : v.vantageEn}</p>
			<ul class="nw-portals">
				{v.rows.map((p) => {
					const s = p.reading
						? portalState(p.reading)
						: { tone: "muted" as const, text: t("sin lectura", "no reading") };
					return (
						<li key={p.id}>
							<span
								class={`dot dot--${s.tone === "ok" ? "ok" : s.tone === "alert" ? "failing" : s.tone === "warn" ? "stale" : "off"}`}
								aria-hidden="true"
							/>
							<span class="nw-portals__name">
								<a href={p.url} target="_blank" rel="noopener noreferrer">
									{p.name}
								</a>
								<span class="note">{p.what}</span>
							</span>
							<span class="nw-portals__state">
								{s.text}
								<span class="note data">
									{p.reading?.latencyMs !== null && p.reading?.latencyMs !== undefined
										? `${int(p.reading.latencyMs, l)} ms · `
										: ""}
									{p.readings24h
										? t(
												`${p.answered24h}/${p.readings24h} en 24 h`,
												`${p.answered24h}/${p.readings24h} in 24 h`,
											)
										: ""}
									{p.certDays !== null
										? p.certDays < 0
											? t(" · certificado vencido", " · certificate expired")
											: p.certDays <= 14
												? t(
														` · certificado vence en ${p.certDays} d`,
														` · certificate expires in ${p.certDays} d`,
													)
												: ""
										: ""}
									{p.reading?.tlsAuthorized === false
										? t(" · cadena TLS incompleta", " · incomplete TLS chain")
										: ""}
									{p.dnsChangedAt !== null
										? t(
												` · DNS cambió ${ago(now.value - p.dnsChangedAt, l)}`,
												` · DNS changed ${ago(now.value - p.dnsChangedAt, l)}`,
											)
										: ""}
								</span>
							</span>
						</li>
					);
				})}
			</ul>
			{v.newestAt ? (
				<div class="sources-row">
					<SourceTag
						source={{
							feed: "portal-probe",
							observedAt: v.newestAt,
							detail: l === "es" ? v.vantageEs : v.vantageEn,
						}}
						label={t("Sondeo propio", "Own probe")}
					/>
				</div>
			) : null}
		</>
	);
}

export function NetwatchPanel() {
	const view = panels.value.netwatch as NetwatchView | undefined;
	const [tab, setTab] = useState<Tab>("blocks");
	const l = lang.value;
	const tabs: { id: Tab; es: string; en: string; count?: number }[] = [
		{ id: "blocks", es: "Bloqueos", en: "Blocks" },
		{ id: "tor", es: "Evasión", en: "Circumvention" },
		{
			id: "routes",
			es: "Rutas",
			en: "Routes",
			...(view?.routing.events.length ? { count: view.routing.events.length } : {}),
		},
		{ id: "portals", es: "Portales", en: "Portals" },
	];
	return (
		<Panel
			id="red"
			title={PANEL_META.red.title()}
			question={PANEL_META.red.question()}
			feeds={PANEL_META.red.feeds()}
			method={
				view ? (
					<>
						<p>
							<strong>{t("Bloqueos. ", "Blocks. ")}</strong>
							{l === "es" ? view.methods.ruleEs : view.methods.ruleEn}
						</p>
						<p>
							<strong>{t("Evasión. ", "Circumvention. ")}</strong>
							{l === "es" ? view.tor.ruleEs : view.tor.ruleEn}
						</p>
						<p>
							<strong>{t("Rutas. ", "Routes. ")}</strong>
							{l === "es" ? view.routing.ruleEs : view.routing.ruleEn}{" "}
							{t(
								"Los términos de RIPEstat no permiten redistribuir sus datos: se muestran solo conteos y horas derivados, nunca las listas de prefijos.",
								"RIPEstat's terms forbid redistributing its data: only derived counts and times are shown, never the prefix lists.",
							)}
						</p>
						<p>
							<strong>{t("Portales. ", "Portals. ")}</strong>
							{l === "es" ? view.portals.vantageEs : view.portals.vantageEn}{" "}
							{t(
								"Una consulta DNS, una conexión TLS para leer el certificado y una sola petición a la portada, cada 15 minutos; nada más.",
								"One DNS lookup, one TLS connection to read the certificate and a single request for the home page, every 15 minutes; nothing else.",
							)}
						</p>
					</>
				) : null
			}
		>
			{view ? (
				<>
					<div
						class="segmented segmented--wide nw-tabs"
						role="tablist"
						aria-label={t("Vistas de la red", "Network views")}
					>
						{tabs.map((x) => (
							<button
								type="button"
								role="tab"
								key={x.id}
								id={`nw-tab-${x.id}`}
								aria-selected={tab === x.id}
								aria-controls="nw-tabpanel"
								onClick={() => setTab(x.id)}
							>
								{l === "es" ? x.es : x.en}
								{x.count ? <span class="data note"> {x.count}</span> : null}
							</button>
						))}
					</div>
					<div class="nw-body" role="tabpanel" id="nw-tabpanel" aria-labelledby={`nw-tab-${tab}`}>
						{tab === "blocks" ? (
							<Blocks v={view.methods} />
						) : tab === "tor" ? (
							<Tor v={view.tor} />
						) : tab === "routes" ? (
							<Routes v={view.routing} />
						) : (
							<Portals v={view.portals} />
						)}
					</div>
				</>
			) : null}
		</Panel>
	);
}
