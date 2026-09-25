import { useEffect, useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { now, panels } from "../lib/data.ts";
import { ago, int } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { lookupDomain as current, openLookup } from "../lib/lookup.ts";
import {
	Cell,
	dayLabel,
	layerLabel,
	type MatrixCell,
	type NetwatchView,
	outcomeLabel,
} from "../panels/Netwatch.tsx";
import netwatchCss from "../styles/netwatch.css?inline";
import pagesCss from "../styles/pages.css?inline";
import panelsCss from "../styles/panels.css?inline";

addStyles(panelsCss);
addStyles(pagesCss);

addStyles(netwatchCss);

/** Mirrors src/panels/netwatch-lookup.ts. */
interface DayCell {
	isp: string;
	n: number;
	state: "blocked" | "unclear" | "ok";
	outcome: string | null;
}
interface LookupView {
	domain: string;
	origin: "stored" | "live" | "none" | "not-queried";
	notQueried: "offline" | "busy" | "cross-site" | "failed" | null;
	liveAt: number | null;
	days: { day: number; cells: DayCell[] }[];
	matrix: MatrixCell[] | null;
	vsf: {
		updated: string;
		site: string;
		isps: { isp: string; status: string; methods: string[] }[];
		url: string;
	} | null;
	ooni7d: {
		fetchedAt: number;
		isps: { isp: string; measurements: number; anomalyRatePct: number; flagged: boolean }[];
		url: string;
	} | null;
	isps: { id: string; name: string }[];
	explorerUrl: string;
	error: string | null;
}

const DAY = 86_400_000;

function vsfLabel(status: string, methods: string[]): string {
	switch (status) {
		case "blocked":
			return `${t("bloqueado", "blocked")}${methods.length ? ` · ${methods.join(" + ")}` : ""}`;
		case "ok":
			return t("accesible", "accessible");
		case "unblocked":
			return t("desbloqueado", "unblocked");
		case "no-data":
			return t("sin dato", "no data");
		default:
			return status;
	}
}

function Verdict({ v }: { v: LookupView }) {
	const l = lang.value;
	const m = v.matrix;
	if (m) {
		const blocked = m.filter((c) => c.state === "blocked");
		const measured = m.filter((c) => c.state !== "few");
		const layers = [
			...new Set(blocked.map((c) => c.layers[0]).filter((x): x is NonNullable<typeof x> => !!x)),
		];
		if (blocked.length)
			return (
				<p class="lk-verdict lk-verdict--blocked">
					{t(
						`Bloqueado en ${blocked.length} de ${measured.length} proveedores medidos`,
						`Blocked on ${blocked.length} of ${measured.length} measured ISPs`,
					)}
					{layers.length ? ` · ${layers.map(layerLabel).join(", ")}` : ""}
					<span class="note">{t(" (OONI, últimos 7 días completos)", " (OONI, last 7 complete days)")}</span>
				</p>
			);
		if (measured.length)
			return (
				<p class="lk-verdict lk-verdict--ok">
					{t(
						`Sin bloqueo en los ${measured.length} proveedores con mediciones suficientes (OONI, 7 días)`,
						`No block on the ${measured.length} ISPs with enough measurements (OONI, 7 days)`,
					)}
				</p>
			);
	}
	const liveBlocked = new Set(
		v.days.flatMap((d) => d.cells.filter((c) => c.state === "blocked").map((c) => c.isp)),
	);
	if (v.origin === "live")
		return (
			<p class={`lk-verdict ${liveBlocked.size ? "lk-verdict--blocked" : "lk-verdict--ok"}`}>
				{liveBlocked.size
					? t(
							`Señales de bloqueo en ${liveBlocked.size} proveedores en 30 días`,
							`Blocking signals on ${liveBlocked.size} ISPs in 30 days`,
						)
					: t(
							"Sin señales de bloqueo en 30 días de mediciones de OONI",
							"No blocking signals in 30 days of OONI measurements",
						)}
				<span class="note">
					{t(
						` (consulta directa a OONI ${ago(now.value - (v.liveAt ?? now.value), l)})`,
						` (live OONI query ${ago(now.value - (v.liveAt ?? now.value), l)})`,
					)}
				</span>
			</p>
		);
	// Nothing stored and OONI not asked: say why, never "OONI has no measurements".
	if (v.origin === "not-queried")
		return (
			<p class="lk-verdict">
				{t(
					"Vigía no tiene mediciones de OONI guardadas de este dominio y no consultó a OONI ahora. No se sabe si está bloqueado",
					"Vigía has no stored OONI measurements of this domain and did not query OONI now. Whether it is blocked is unknown",
				)}
				<span class="note">
					{" "}
					{v.notQueried === "offline"
						? t(
								"(funciona sin conectarse a las fuentes). Consúltalo en OONI Explorer.",
								"(it runs without reaching the sources). Check OONI Explorer.",
							)
						: v.notQueried === "busy"
							? t(
									"(se alcanzó el límite de consultas nuevas). Intenta en un minuto.",
									"(the limit of new queries was reached). Try again in a minute.",
								)
							: v.notQueried === "failed"
								? t(
										"(OONI no respondió). Vigía reintentará en unos minutos.",
										"(OONI did not answer). Vigía will retry in a few minutes.",
									)
								: t(
										"(la consulta directa solo se hace desde esta página). Búscalo de nuevo aquí.",
										"(a live query is only made from this page). Search for it again here.",
									)}
				</span>
			</p>
		);
	return (
		<p class="lk-verdict">
			{t(
				"OONI no tiene mediciones recientes de este dominio desde Venezuela. Que no aparezca no prueba que esté accesible.",
				"OONI has no recent measurements of this domain from Venezuela. Absence does not prove it is reachable.",
			)}
		</p>
	);
}

/** One row of day tiles per ISP: what OONI said each day Vigía stored (or the live query returned). */
function History({ v }: { v: LookupView }) {
	const l = lang.value;
	if (!v.days.length) return null;
	const first = v.days[0]?.day ?? 0;
	const last = v.days.at(-1)?.day ?? first;
	const span = Math.round((last - first) / DAY) + 1;
	const byDay = new Map(v.days.map((d) => [d.day, new Map(d.cells.map((c) => [c.isp, c]))]));
	const days = Array.from({ length: span }, (_, i) => first + i * DAY);
	return (
		<section class="lk-section">
			<h2 class="caps">{t("Día a día", "Day by day")}</h2>
			<div class="lk-history" style={{ "--days": String(span) }}>
				{v.isps.map((isp) => (
					<div class="lk-history__row" key={isp.id}>
						<span class="lk-history__isp">{isp.name}</span>
						<span class="lk-history__tiles">
							{days.map((d) => {
								const c = byDay.get(d)?.get(isp.id);
								const label = `${dayLabel(d, l)} · ${isp.name}: ${
									!c
										? t("sin dato guardado", "nothing stored")
										: c.state === "blocked"
											? `${t("bloqueo", "block")}, ${outcomeLabel(c.outcome)} (${c.n})`
											: c.state === "unclear"
												? `${t("dudoso", "unclear")} (${c.n})`
												: `${t("sin bloqueo", "no block")} (${c.n})`
								}`;
								return <i key={d} class={`lk-tile lk-tile--${c ? c.state : "none"}`} title={label} />;
							})}
						</span>
					</div>
				))}
			</div>
			<p class="lk-axis note data">
				<span>{dayLabel(first, l)}</span>
				<span>{dayLabel(last, l)}</span>
			</p>
			<p class="note">
				<i class="lk-tile lk-tile--blocked" /> {t("bloqueo con firma", "block with a signature")}{" "}
				<i class="lk-tile lk-tile--unclear" /> {t("dudoso", "unclear")} <i class="lk-tile lk-tile--ok" />{" "}
				{t("sin bloqueo", "no block")} <i class="lk-tile lk-tile--none" />{" "}
				{v.origin === "stored"
					? t(
							"sin dato guardado (Vigía guarda un día solo si el dominio tuvo indicios en algún proveedor)",
							"nothing stored (Vigía stores a day only when the domain showed signs on some ISP)",
						)
					: t("sin mediciones ese día", "no measurements that day")}
			</p>
		</section>
	);
}

function Result({ v }: { v: LookupView }) {
	const l = lang.value;
	const vsfBy = new Map(v.vsf?.isps.map((c) => [c.isp, c]) ?? []);
	const o7 = new Map(v.ooni7d?.isps.map((c) => [c.isp, c]) ?? []);
	return (
		<>
			<h2 class="lk-domain">{v.domain}</h2>
			<Verdict v={v} />
			{v.error ? <p class="band band--warn">{v.error}</p> : null}
			<section class="lk-section">
				<h2 class="caps">{t("Por proveedor", "By ISP")}</h2>
				<div class="lk-table-wrap">
					<table class="lk-table">
						<thead>
							<tr>
								<th scope="col">{t("Proveedor", "ISP")}</th>
								<th scope="col">{t("OONI, 7 días", "OONI, 7 days")}</th>
								<th scope="col">{t("Visto", "Seen")}</th>
								<th scope="col">VE sin Filtro</th>
							</tr>
						</thead>
						<tbody>
							{v.isps.map((isp) => {
								const c = v.matrix?.find((m) => m.isp === isp.id);
								const s = vsfBy.get(isp.id);
								const a = o7.get(isp.id);
								return (
									<tr key={isp.id}>
										<th scope="row">{isp.name}</th>
										<td>
											{c ? (
												<span class="lk-cell">
													<Cell domain={v.domain} isp={isp.name} c={c} />
													<span>
														{c.state === "blocked"
															? outcomeLabel(c.outcome)
															: c.state === "unclear"
																? t("dudoso: solo tiempos agotados", "unclear: timeouts only")
																: c.state === "ok"
																	? t("sin bloqueo", "no block")
																	: t("pocas mediciones", "few measurements")}
														<span class="note data">
															{" "}
															{int(c.n, l)} {t("med.", "meas.")}
															{a ? ` · ${t("anomalías", "anomalies")} ${a.anomalyRatePct} %` : ""}
														</span>
													</span>
												</span>
											) : (
												<span class="note">—</span>
											)}
										</td>
										<td class="data note">
											{c?.firstSeen && c.lastSeen
												? `${dayLabel(c.firstSeen, l)} → ${dayLabel(c.lastSeen, l)}`
												: "—"}
										</td>
										<td>{s ? vsfLabel(s.status, s.methods) : <span class="note">—</span>}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
				<p class="note">
					{t(
						"«Visto»: primer y último día con bloqueo en lo que Vigía guardó. VE sin Filtro es una lista verificada a mano, con su propia fecha; OONI son mediciones de voluntarios. No se mezclan.",
						"“Seen”: first and last day with a block in what Vigía stored. VE sin Filtro is a hand-checked list with its own date; OONI is volunteers' measurements. They are never blended.",
					)}
					{v.vsf
						? t(` VE sin Filtro: lista del ${v.vsf.updated}.`, ` VE sin Filtro: list of ${v.vsf.updated}.`)
						: ""}
				</p>
			</section>
			<History v={v} />
			<p class="lk-links">
				<a class="link" href={v.explorerUrl} target="_blank" rel="noopener noreferrer">
					{t("Mediciones en OONI Explorer", "Measurements in OONI Explorer")} ↗
				</a>
				{v.vsf ? (
					<a class="link" href={v.vsf.url} target="_blank" rel="noopener noreferrer">
						VE sin Filtro ↗
					</a>
				) : null}
			</p>
		</>
	);
}

/** /bloqueos?dominio=…: is a site blocked in Venezuela, on which ISP, how, and since when. */
export function BlockLookupPage() {
	const domain = current.value;
	const [input, setInput] = useState(domain);
	const [state, setState] = useState<{ loading: boolean; view: LookupView | null; error: string | null }>({
		loading: false,
		view: null,
		error: null,
	});
	useEffect(() => {
		setInput(domain);
		if (!domain) {
			setState({ loading: false, view: null, error: null });
			return;
		}
		let alive = true;
		setState((s) => ({ ...s, loading: true, error: null }));
		fetch(`/api/bloqueos?dominio=${encodeURIComponent(domain)}`, { headers: { accept: "application/json" } })
			.then(async (res) => {
				// 400 carries the reason (a malformed domain) in the same shape.
				if (!res.ok && res.status !== 400) throw new Error(String(res.status));
				const body = (await res.json()) as { lookup: LookupView | { error: string } };
				if (!alive) return;
				if ("domain" in body.lookup) setState({ loading: false, view: body.lookup, error: null });
				else setState({ loading: false, view: null, error: body.lookup.error });
			})
			.catch(() => {
				if (alive)
					setState({
						loading: false,
						view: null,
						error: t("No se pudo consultar ahora. Intenta de nuevo.", "Could not look it up now. Try again."),
					});
			});
		return () => {
			alive = false;
		};
	}, [domain]);
	const suggestions = (panels.value.netwatch as NetwatchView | undefined)?.methods.rows.slice(0, 8) ?? [];
	return (
		<main class="page lk">
			<header class="page__head">
				<p class="caps page__kicker">{t("Censura en Venezuela", "Censorship in Venezuela")}</p>
				<h1 class="page__title">{t("¿Está bloqueado?", "Is it blocked?")}</h1>
				<p class="page__lede">
					{t(
						"Escribe un sitio para ver en qué proveedores de internet está bloqueado, de qué forma y desde cuándo, según las mediciones de OONI y la lista de VE sin Filtro.",
						"Type a site to see on which internet providers it is blocked, how, and since when, from OONI's measurements and VE sin Filtro's list.",
					)}
				</p>
			</header>
			<form
				class="lk-form"
				onSubmit={(e) => {
					e.preventDefault();
					const d = input.trim();
					if (d) openLookup(d);
				}}
			>
				<label class="sr-only" for="lk-q">
					{t("Dominio", "Domain")}
				</label>
				<input
					id="lk-q"
					type="text"
					inputMode="url"
					autoComplete="off"
					spellcheck={false}
					placeholder="infobae.com"
					value={input}
					onInput={(e) => setInput((e.target as HTMLInputElement).value)}
				/>
				<button type="submit" class="button button--primary" disabled={state.loading}>
					{state.loading ? t("Consultando…", "Looking up…") : t("Consultar", "Look up")}
				</button>
			</form>
			{state.error ? <p class="band band--warn">{state.error}</p> : null}
			{state.view ? (
				<Result v={state.view} />
			) : !domain && suggestions.length ? (
				<section class="lk-section">
					<h2 class="caps">{t("Bloqueados en más proveedores", "Blocked on the most ISPs")}</h2>
					<ul class="lk-suggest">
						{suggestions.map((r) => (
							<li key={r.domain}>
								<button type="button" class="chip" onClick={() => openLookup(r.domain)}>
									{r.domain}
								</button>
							</li>
						))}
					</ul>
				</section>
			) : null}
		</main>
	);
}
