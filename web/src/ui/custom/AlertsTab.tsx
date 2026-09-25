import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { type AlertItem, ruleCount } from "../../lib/alerts.ts";
import { now } from "../../lib/data.ts";
import { ago, num, stamp } from "../../lib/format.ts";
import { lang, t } from "../../lib/i18n.ts";
import { isPanelId, reveal } from "../../lib/layout.ts";
import { stateName } from "../../lib/states.ts";
import { STATES } from "../../map/geometry.gen.ts";
import { getJson, send } from "./api.ts";
import { safeHref } from "./Entry.tsx";
import { notifications, setNotifications } from "./notify.ts";
import { closeCustomize } from "./open.ts";

/* ---------- Rules: the same shapes the server validates (src/alerts/schema.ts) ---------- */

interface Base {
	id: string;
	name?: string;
	enabled: boolean;
	createdAt: number;
}
type Rule = Base &
	(
		| { kind: "connectivity"; place: string; level: "drop" | "severe" }
		| { kind: "gap"; minPct: number }
		| { kind: "rate"; minVes: number }
		| { kind: "quake"; minMag: number; state: string; radiusKm: number }
		| { kind: "blocked"; domain: string }
		| { kind: "incident"; state: string; incident: "any" | "corte" | "sismo" }
		| { kind: "news"; terms: string; state: string }
	);
type Kind = Rule["kind"];

interface Status {
	state: "matching" | "clear" | "stale" | "off";
	matching: number;
	note: { es: string; en: string } | null;
}
interface AlertsView {
	now: number;
	rules: Rule[];
	status: Record<string, Status>;
	log: AlertItem[];
	evaluatedAt: number | null;
}

const view = signal<AlertsView | null>(null);

async function load(): Promise<void> {
	const v = await getJson<AlertsView>("/api/alerts");
	if (v) {
		view.value = v;
		ruleCount.value = v.rules.length;
	}
}

function newRuleId(): string {
	const bytes = new Uint8Array(6);
	crypto.getRandomValues(bytes);
	return `r-${[...bytes]
		.map((b) => b.toString(36).padStart(2, "0"))
		.join("")
		.slice(0, 10)}`;
}

const sortedStates = () => [...STATES].sort((a, b) => a.name.localeCompare(b.name, "es"));

function placeName(place: string, anyEs = "cualquier estado", anyEn = "any state"): string {
	if (place === "*") return t(anyEs, anyEn);
	if (place === "VE") return t("todo el país", "the whole country");
	return stateName(place);
}

/** One plain sentence per rule, in the reader's language. */
export function describeRule(r: Rule): string {
	const l = lang.value;
	switch (r.kind) {
		case "connectivity":
			return t(
				`Internet en ${placeName(r.place)}: ${r.level === "severe" ? "caída fuerte" : "caída o peor"}`,
				`Internet in ${placeName(r.place)}: ${r.level === "severe" ? "severe drop" : "drop or worse"}`,
			);
		case "gap":
			return t(
				`Brecha Yadio–BCV de ${num(r.minPct, 1, l)} % o más`,
				`Yadio–BCV gap of ${num(r.minPct, 1, l)}% or more`,
			);
		case "rate":
			return t(
				`Dólar BCV en ${num(r.minVes, 2, l)} Bs o más`,
				`BCV dollar at ${num(r.minVes, 2, l)} Bs or more`,
			);
		case "quake":
			return r.state === "*"
				? t(
						`Sismo de M${num(r.minMag, 1, l)} o más, en Venezuela o cerca`,
						`M${num(r.minMag, 1, l)}+ earthquake in or near Venezuela`,
					)
				: t(
						`Sismo de M${num(r.minMag, 1, l)} o más en ${stateName(r.state)} o a ${r.radiusKm} km o menos`,
						`M${num(r.minMag, 1, l)}+ earthquake in ${stateName(r.state)} or within ${r.radiusKm} km`,
					);
		case "blocked":
			return r.domain === "*"
				? t("Un sitio nuevo bloqueado (cualquiera)", "Any newly blocked site")
				: t(
						`${r.domain} bloqueado o marcado como posible bloqueo`,
						`${r.domain} blocked or flagged as possibly blocked`,
					);
		case "incident":
			return t(
				`Se abre un incidente${r.incident === "corte" ? " de corte" : r.incident === "sismo" ? " de sismo" : ""} en ${placeName(r.state)}`,
				`An${r.incident === "corte" ? " outage" : r.incident === "sismo" ? " earthquake" : ""} incident opens in ${placeName(r.state)}`,
			);
		case "news":
			return t(
				`Titular con «${r.terms}»${r.state === "*" ? "" : ` en ${stateName(r.state)}`}`,
				`Headline with “${r.terms}”${r.state === "*" ? "" : ` in ${stateName(r.state)}`}`,
			);
	}
}

function StatusPill({ s }: { s: Status | undefined }) {
	if (!s) return <span class="rule-status">{t("sin evaluar", "not evaluated")}</span>;
	const label =
		s.state === "matching"
			? s.matching > 1
				? t(`se cumple ahora (${s.matching})`, `true now (${s.matching})`)
				: t("se cumple ahora", "true now")
			: s.state === "clear"
				? t("sin novedad", "nothing new")
				: s.state === "stale"
					? t("sin datos frescos", "no fresh data")
					: t("apagada", "off");
	return (
		<span class={`rule-status rule-status--${s.state}`} title={s.note ? t(s.note.es, s.note.en) : undefined}>
			{label}
		</span>
	);
}

async function saveRules(rules: Rule[]): Promise<string | null> {
	const r = await send<AlertsView>("PUT", "/api/alerts/rules", { rules });
	if (!r.ok) return r.error;
	view.value = r.data;
	ruleCount.value = r.data.rules.length;
	return null;
}

/* ---------- The rule builder ---------- */

const KINDS: { id: Kind; es: string; en: string }[] = [
	{ id: "connectivity", es: "Caída de internet", en: "Internet drop" },
	{ id: "quake", es: "Sismo", en: "Earthquake" },
	{ id: "incident", es: "Incidente", en: "Incident" },
	{ id: "gap", es: "Brecha del dólar", en: "Dollar gap" },
	{ id: "rate", es: "Dólar BCV", en: "BCV dollar" },
	{ id: "blocked", es: "Sitio bloqueado", en: "Blocked site" },
	{ id: "news", es: "Palabras en titulares", en: "Words in headlines" },
];

function StateOptions({ any, country }: { any: string; country?: boolean }) {
	return (
		<>
			<option value="*">{any}</option>
			{country ? <option value="VE">{t("Todo el país", "The whole country")}</option> : null}
			{sortedStates().map((s) => (
				<option key={s.iso} value={s.iso}>
					{s.name}
				</option>
			))}
		</>
	);
}

function Builder({ onDone }: { onDone: () => void }) {
	const [kind, setKind] = useState<Kind>("connectivity");
	const [place, setPlace] = useState("*");
	const [level, setLevel] = useState<"drop" | "severe">("drop");
	const [minPct, setMinPct] = useState("50");
	const [minVes, setMinVes] = useState("");
	const [minMag, setMinMag] = useState("4");
	const [radiusKm, setRadiusKm] = useState("50");
	const [domain, setDomain] = useState("");
	const [incident, setIncident] = useState<"any" | "corte" | "sismo">("any");
	const [terms, setTerms] = useState("");
	const [name, setName] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const build = (): Rule | string => {
		const base: Base = {
			id: newRuleId(),
			enabled: true,
			createdAt: Date.now(),
			...(name.trim() ? { name: name.trim().slice(0, 60) } : {}),
		};
		const n = (s: string) => Number(s.replace(",", "."));
		switch (kind) {
			case "connectivity":
				return { ...base, kind, place, level };
			case "gap":
				return Number.isFinite(n(minPct)) && n(minPct) >= 0
					? { ...base, kind, minPct: n(minPct) }
					: t("Escribe un porcentaje.", "Enter a percentage.");
			case "rate":
				return n(minVes) > 0
					? { ...base, kind, minVes: n(minVes) }
					: t("Escribe una tasa en bolívares.", "Enter a rate in bolívares.");
			case "quake": {
				const mag = n(minMag);
				const km = Math.round(n(radiusKm));
				if (!(mag >= 2 && mag <= 9)) return t("La magnitud va de 2 a 9.", "Magnitude goes from 2 to 9.");
				if (!(km >= 0 && km <= 300))
					return t("La distancia va de 0 a 300 km.", "Distance goes from 0 to 300 km.");
				return { ...base, kind, minMag: mag, state: place === "VE" ? "*" : place, radiusKm: km };
			}
			case "blocked": {
				const d =
					domain
						.trim()
						.toLowerCase()
						.replace(/^https?:\/\//, "")
						.replace(/^www\./, "")
						.replace(/\/.*$/, "") || "*";
				return d === "*" || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)
					? { ...base, kind, domain: d }
					: t("Escribe un dominio, p. ej. ejemplo.com", "Enter a domain, e.g. example.com");
			}
			case "incident":
				return { ...base, kind, state: place === "VE" ? "*" : place, incident };
			case "news":
				return terms.trim().length >= 2
					? { ...base, kind, terms: terms.trim().slice(0, 200), state: place === "VE" ? "*" : place }
					: t("Escribe al menos una palabra.", "Enter at least one word.");
		}
	};

	const submit = async (e: Event) => {
		e.preventDefault();
		const rule = build();
		if (typeof rule === "string") return setError(rule);
		setBusy(true);
		const failed = await saveRules([...(view.value?.rules ?? []), rule]);
		setBusy(false);
		if (failed) return setError(failed);
		setError("");
		onDone();
	};

	return (
		<form class="rule-builder" onSubmit={submit}>
			<label for="rule-kind">{t("Avísame cuando…", "Tell me when…")}</label>
			<select
				id="rule-kind"
				class="input"
				value={kind}
				onChange={(e) => setKind((e.target as HTMLSelectElement).value as Kind)}
			>
				{KINDS.map((k) => (
					<option key={k.id} value={k.id}>
						{t(k.es, k.en)}
					</option>
				))}
			</select>
			{kind === "connectivity" ? (
				<div class="rule-builder__row">
					<div>
						<label for="rule-place">{t("Dónde", "Where")}</label>
						<select
							id="rule-place"
							class="input"
							value={place}
							onChange={(e) => setPlace((e.target as HTMLSelectElement).value)}
						>
							<StateOptions any={t("Cualquier estado", "Any state")} country={true} />
						</select>
					</div>
					<div>
						<label for="rule-level">{t("Nivel", "Level")}</label>
						<select
							id="rule-level"
							class="input"
							value={level}
							onChange={(e) => setLevel((e.target as HTMLSelectElement).value as "drop" | "severe")}
						>
							<option value="drop">{t("Caída o peor", "Drop or worse")}</option>
							<option value="severe">{t("Solo caída fuerte", "Severe drop only")}</option>
						</select>
					</div>
				</div>
			) : null}
			{kind === "gap" ? (
				<div>
					<label for="rule-pct">{t("Brecha mínima (%)", "Minimum gap (%)")}</label>
					<input
						id="rule-pct"
						class="input"
						inputMode="decimal"
						value={minPct}
						onInput={(e) => setMinPct((e.target as HTMLInputElement).value)}
					/>
				</div>
			) : null}
			{kind === "rate" ? (
				<div>
					<label for="rule-ves">{t("Tasa mínima (Bs por dólar)", "Minimum rate (Bs per dollar)")}</label>
					<input
						id="rule-ves"
						class="input"
						inputMode="decimal"
						value={minVes}
						placeholder="200"
						onInput={(e) => setMinVes((e.target as HTMLInputElement).value)}
					/>
				</div>
			) : null}
			{kind === "quake" ? (
				<div class="rule-builder__row">
					<div>
						<label for="rule-mag">{t("Magnitud mínima", "Minimum magnitude")}</label>
						<input
							id="rule-mag"
							class="input"
							inputMode="decimal"
							value={minMag}
							onInput={(e) => setMinMag((e.target as HTMLInputElement).value)}
						/>
					</div>
					<div>
						<label for="rule-place">{t("Dónde", "Where")}</label>
						<select
							id="rule-place"
							class="input"
							value={place}
							onChange={(e) => setPlace((e.target as HTMLSelectElement).value)}
						>
							<StateOptions any={t("Venezuela o cerca", "In or near Venezuela")} />
						</select>
					</div>
					{place !== "*" && place !== "VE" ? (
						<div>
							<label for="rule-km">{t("Hasta (km del estado)", "Up to (km from the state)")}</label>
							<input
								id="rule-km"
								class="input"
								inputMode="numeric"
								value={radiusKm}
								onInput={(e) => setRadiusKm((e.target as HTMLInputElement).value)}
							/>
						</div>
					) : null}
				</div>
			) : null}
			{kind === "blocked" ? (
				<div>
					<label for="rule-domain">{t("Dominio (vacío: cualquiera)", "Domain (empty: any)")}</label>
					<input
						id="rule-domain"
						class="input"
						value={domain}
						placeholder="ejemplo.com"
						onInput={(e) => setDomain((e.target as HTMLInputElement).value)}
					/>
				</div>
			) : null}
			{kind === "incident" ? (
				<div class="rule-builder__row">
					<div>
						<label for="rule-inc">{t("Tipo", "Type")}</label>
						<select
							id="rule-inc"
							class="input"
							value={incident}
							onChange={(e) =>
								setIncident((e.target as HTMLSelectElement).value as "any" | "corte" | "sismo")
							}
						>
							<option value="any">{t("Cualquiera", "Any")}</option>
							<option value="corte">{t("Corte (luz o internet)", "Outage (power or internet)")}</option>
							<option value="sismo">{t("Sismo", "Earthquake")}</option>
						</select>
					</div>
					<div>
						<label for="rule-place">{t("Dónde", "Where")}</label>
						<select
							id="rule-place"
							class="input"
							value={place}
							onChange={(e) => setPlace((e.target as HTMLSelectElement).value)}
						>
							<StateOptions any={t("Cualquier estado", "Any state")} />
						</select>
					</div>
				</div>
			) : null}
			{kind === "news" ? (
				<div class="rule-builder__row">
					<div>
						<label for="rule-terms">
							{t("Palabras (separa frases con comas)", "Words (separate phrases with commas)")}
						</label>
						<input
							id="rule-terms"
							class="input"
							value={terms}
							maxLength={200}
							placeholder={t("apagón maracaibo, gasolina", "blackout maracaibo, fuel")}
							onInput={(e) => setTerms((e.target as HTMLInputElement).value)}
						/>
					</div>
					<div>
						<label for="rule-place">{t("Estado nombrado", "State named")}</label>
						<select
							id="rule-place"
							class="input"
							value={place}
							onChange={(e) => setPlace((e.target as HTMLSelectElement).value)}
						>
							<StateOptions any={t("Cualquiera", "Any")} />
						</select>
					</div>
				</div>
			) : null}
			<label for="rule-name">
				{t("Nombre", "Name")} <span class="note">{t("(opcional)", "(optional)")}</span>
			</label>
			<input
				id="rule-name"
				class="input"
				value={name}
				maxLength={60}
				onInput={(e) => setName((e.target as HTMLInputElement).value)}
			/>
			{error ? (
				<p class="custom-msg custom-msg--error" role="alert">
					{error}
				</p>
			) : null}
			<div class="custom-actions">
				<button type="submit" class="button button--primary" disabled={busy}>
					{t("Crear alerta", "Create alert")}
				</button>
				<button type="button" class="button" onClick={onDone}>
					{t("Cancelar", "Cancel")}
				</button>
			</div>
			<p class="note">
				{t(
					"Una alerta nueva no avisa por lo que ya está pasando (lo muestra como «se cumple ahora»): avisa cuando algo empieza o llega.",
					"A new alert does not fire for what is already happening (it shows “true now”): it fires when something starts or arrives.",
				)}
			</p>
		</form>
	);
}

/* ---------- The tab ---------- */

function LogRow({ a }: { a: AlertItem }) {
	const l = lang.value;
	const href = safeHref(a.sourceUrl);
	return (
		<li class="alert-log__row">
			<p class="alert-log__title">{l === "en" ? a.title.en : a.title.es}</p>
			<p class="alert-log__detail">{l === "en" ? a.detail.en : a.detail.es}</p>
			<p class="alert-log__meta note">
				{a.source} ·{" "}
				<span class="data">
					{t(`dato de ${stamp(a.observedAt, l)}`, `data from ${stamp(a.observedAt, l)}`)}
				</span>{" "}
				·{" "}
				<span class="data">
					{t(`avisó ${ago(now.value - a.at, l)}`, `fired ${ago(now.value - a.at, l)}`)}
				</span>
				{a.ruleName ? ` · ${a.ruleName}` : ""}
			</p>
			<p class="alert-log__links">
				{isPanelId(a.panel) ? (
					<button
						type="button"
						class="link-button"
						onClick={() => {
							closeCustomize();
							if (isPanelId(a.panel)) reveal(a.panel, true);
						}}
					>
						{t("Ver en el panel", "See in the panel")}
					</button>
				) : null}
				{href ? (
					<a class="link" href={href} target="_blank" rel="noopener noreferrer">
						{t("Evidencia", "Evidence")} ↗
					</a>
				) : null}
			</p>
		</li>
	);
}

export function AlertsTab() {
	const l = lang.value;
	const [building, setBuilding] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		void load();
		// While the tab is open, the rules' status follows the data.
		const timer = setInterval(() => void load(), 60_000);
		return () => clearInterval(timer);
	}, []);
	const v = view.value;
	const rules = v?.rules ?? [];
	const notify = notifications.value;

	const update = async (next: Rule[]) => {
		const failed = await saveRules(next);
		setError(failed ?? "");
	};

	return (
		<div class="custom-tab">
			<section aria-labelledby="notify-h" class="custom-card">
				<h3 id="notify-h" class="custom-h">
					{t("Avisos del navegador", "Browser notifications")}
				</h3>
				{notify === "unsupported" ? (
					<p class="note">
						{t(
							"Este navegador no muestra notificaciones; las alertas salen dentro de la página.",
							"This browser does not show notifications; alerts appear inside the page.",
						)}
					</p>
				) : notify === "denied" ? (
					<p class="note">
						{t(
							"Bloqueaste las notificaciones de este sitio: actívalas en los ajustes del navegador.",
							"You blocked this site's notifications: turn them on in the browser's settings.",
						)}
					</p>
				) : (
					<label class="toggle">
						<input
							type="checkbox"
							checked={notify === "on"}
							onChange={() => void setNotifications(notify !== "on")}
						/>{" "}
						{t(
							"Avisarme con una notificación cuando Vigía no está a la vista",
							"Notify me when Vigía is not in view",
						)}
					</label>
				)}
				<p class="note">
					{t(
						"Funciona mientras Vigía esté abierto en este navegador (aunque sea en otra pestaña). Las reglas corren en tu Vigía, en este equipo; nada sale a un servicio de avisos.",
						"Works while Vigía is open in this browser (even in another tab). The rules run on your Vigía, on this machine; nothing goes to a push service.",
					)}
				</p>
			</section>

			<section aria-labelledby="rules-h">
				<h3 id="rules-h" class="custom-h">
					{t("Tus reglas", "Your rules")} <span class="data note">{rules.length}/50</span>
				</h3>
				<p class="note custom-lead">
					{t(
						"Las evalúa el código de Vigía con las mismas cifras de los paneles, nunca un modelo. No avisan con datos viejos: si la fuente está atrasada, la regla dice «sin datos frescos».",
						"Vigía's code evaluates them with the panels' own figures, never a model. They never fire on old data: when the source is late, the rule says “no fresh data”.",
					)}
				</p>
				{v === null ? <p class="note">{t("Cargando…", "Loading…")}</p> : null}
				{rules.length ? (
					<ul class="rule-list">
						{rules.map((r) => (
							<li key={r.id} class={`rule-row${r.enabled ? "" : " is-off"}`}>
								<label class="rule-row__switch">
									<input
										type="checkbox"
										checked={r.enabled}
										aria-label={t(`Activa: ${describeRule(r)}`, `On: ${describeRule(r)}`)}
										onChange={() =>
											void update(rules.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)))
										}
									/>
								</label>
								<div class="rule-row__text">
									<p class="rule-row__name">
										{r.name ? <strong>{r.name}: </strong> : null}
										{describeRule(r)}
									</p>
									<StatusPill s={v?.status[r.id]} />
									{v?.status[r.id]?.note ? (
										<p class="rule-row__note">
											{l === "en" ? v.status[r.id]?.note?.en : v.status[r.id]?.note?.es}
										</p>
									) : null}
								</div>
								<button
									type="button"
									class="icon-button"
									aria-label={t(`Borrar: ${describeRule(r)}`, `Delete: ${describeRule(r)}`)}
									onClick={() => void update(rules.filter((x) => x.id !== r.id))}
								>
									✕
								</button>
							</li>
						))}
					</ul>
				) : v ? (
					<p class="empty">{t("Todavía no tienes alertas.", "You have no alerts yet.")}</p>
				) : null}
				{error ? (
					<p class="custom-msg custom-msg--error" role="alert">
						{error}
					</p>
				) : null}
				{building ? (
					<Builder onDone={() => setBuilding(false)} />
				) : (
					<button
						type="button"
						class="button button--primary"
						disabled={rules.length >= 50}
						onClick={() => setBuilding(true)}
					>
						{t("Nueva alerta", "New alert")}
					</button>
				)}
				{v?.evaluatedAt ? (
					<p class="note data">
						{t(
							`Evaluadas ${ago(now.value - v.evaluatedAt, l)}.`,
							`Evaluated ${ago(now.value - v.evaluatedAt, l)}.`,
						)}
					</p>
				) : null}
			</section>

			<section aria-labelledby="log-h">
				<h3 id="log-h" class="custom-h">
					{t("Lo que avisaron", "What they reported")}
				</h3>
				{v?.log.length ? (
					<>
						<ol class="alert-log">
							{v.log.slice(0, 60).map((a) => (
								<LogRow key={a.id} a={a} />
							))}
						</ol>
						<button
							type="button"
							class="button button--small"
							onClick={async () => {
								const r = await send("DELETE", "/api/alerts/log");
								if (!r.ok) return setError(r.error);
								await load();
							}}
						>
							{t("Vaciar el registro", "Clear the log")}
						</button>
					</>
				) : (
					<p class="empty">{t("Ninguna alerta todavía.", "No alerts yet.")}</p>
				)}
			</section>
		</div>
	);
}
