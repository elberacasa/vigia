import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { health, meta, metaById, refreshHealth } from "../lib/data.ts";
import { lang, t } from "../lib/i18n.ts";
import pagesCss from "../styles/pages.css?inline";
import panelsCss from "../styles/panels.css?inline";
import { send } from "../ui/custom/api.ts";
import { StateBadge } from "../ui/Source.tsx";

addStyles(panelsCss);
addStyles(pagesCss);

interface KeyInfo {
	id: string;
	set: boolean;
	origin: "file" | "env" | null;
	provider: string;
	name: { es: string; en: string };
	cost: "free-no-card" | "free-card" | "paid";
	signupUrl: string;
	minutes: number;
	steps: { es: string[]; en: string[] };
	unlocks: { es: string; en: string };
	feeds: string[];
}

const keys = signal<KeyInfo[] | null>(null);

async function loadKeys(): Promise<void> {
	const res = await fetch("/api/keys");
	if (res.ok) keys.value = ((await res.json()) as { keys: KeyInfo[] }).keys;
}

function costLabel(cost: KeyInfo["cost"]): string {
	if (cost === "free-no-card") return t("Gratis, sin tarjeta", "Free, no card");
	if (cost === "free-card") return t("Gratis, pide tarjeta", "Free, asks for a card");
	return t("De pago", "Paid");
}

async function post(path: string, body: unknown): Promise<Response> {
	return fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function KeyCard({ info }: { info: KeyInfo }) {
	const l = lang.value;
	const [value, setValue] = useState("");
	const [state, setState] = useState<"idle" | "checking" | "ok" | "error">(info.set ? "ok" : "idle");
	const [message, setMessage] = useState("");
	const feedNames = info.feeds.map((id) => metaById.value.get(id)?.name[l] ?? id);

	const submit = async (e: Event) => {
		e.preventDefault();
		setState("checking");
		setMessage("");
		try {
			const res = await post(`/api/keys/${info.id}`, { value });
			const data = (await res.json()) as { ok?: boolean; reason?: string; error?: string };
			if (res.ok && data.ok) {
				setState("ok");
				setValue("");
				await Promise.all([loadKeys(), refreshHealth()]);
			} else {
				setState("error");
				setMessage(data.reason ?? data.error ?? t("No se pudo guardar.", "Could not save."));
			}
		} catch {
			setState("error");
			setMessage(t("Vigía no responde. ¿Sigue abierto?", "Vigía is not answering. Is it still running?"));
		}
	};

	return (
		<article class={`key-card key-card--${state}`}>
			<header class="key-card__head">
				<div>
					<h3 class="key-card__title">{info.name[l]}</h3>
					<p class="note">
						{info.provider} · {t(`unos ${info.minutes} min`, `about ${info.minutes} min`)}
					</p>
				</div>
				<span class={`cost cost--${info.cost}`}>{costLabel(info.cost)}</span>
			</header>
			<p class="key-card__unlocks">
				<span class="caps">{t("Desbloquea", "Unlocks")}</span> {info.unlocks[l]}
				{feedNames.length ? <span class="note"> ({feedNames.join(", ")})</span> : null}
			</p>
			{state === "ok" ? (
				<div class="key-card__done" role="status">
					<span class="key-card__check" aria-hidden="true" />
					{info.origin === "env"
						? t("Activa (desde una variable de entorno).", "Active (from an environment variable).")
						: t("Activa. Los datos ya están llegando.", "Active. Data is already flowing in.")}
					{info.origin === "file" ? (
						<button
							type="button"
							class="link-button"
							onClick={async () => {
								const res = await fetch(`/api/keys/${info.id}`, {
									method: "DELETE",
									headers: { "content-type": "application/json" },
								}).catch(() => null);
								if (!res?.ok) {
									const data = ((await res?.json().catch(() => null)) ?? {}) as { error?: string };
									setState("error");
									setMessage(data.error ?? t("No se pudo quitar la clave.", "Could not remove the key."));
									return;
								}
								setState("idle");
								await Promise.all([loadKeys(), refreshHealth()]);
							}}
						>
							{t("Quitar clave", "Remove key")}
						</button>
					) : null}
				</div>
			) : (
				<>
					<ol class="key-card__steps">
						{info.steps[l].map((step) => (
							<li>{step}</li>
						))}
					</ol>
					<a class="button" href={info.signupUrl} target="_blank" rel="noopener noreferrer">
						{t("Abrir la página de registro", "Open the sign-up page")} ↗
					</a>
					<form class="key-form" onSubmit={submit}>
						<label class="sr-only" for={`key-${info.id}`}>
							{t("Pega tu clave", "Paste your key")}
						</label>
						<input
							id={`key-${info.id}`}
							class="key-form__input data"
							type="password"
							autoComplete="off"
							spellcheck={false}
							placeholder={t("Pega tu clave aquí", "Paste your key here")}
							value={value}
							onInput={(e) => setValue((e.target as HTMLInputElement).value)}
						/>
						<button
							type="submit"
							class="button button--primary"
							disabled={value.trim().length < 4 || state === "checking"}
						>
							{state === "checking"
								? t("Verificando…", "Checking…")
								: t("Verificar y activar", "Check and enable")}
						</button>
					</form>
					{message ? (
						<p class="key-form__error" role="alert">
							{message}
						</p>
					) : null}
					<p class="note">
						{t(
							"La clave se guarda solo en este equipo y solo se envía a su proveedor.",
							"The key is stored only on this machine and only sent to its provider.",
						)}
					</p>
				</>
			)}
		</article>
	);
}

function OptInRow({ id }: { id: string }) {
	const l = lang.value;
	const m = metaById.value.get(id);
	const h = health.value.find((x) => x.id === id);
	const why = m?.optIn ?? m?.note;
	if (!m || !why) return null;
	// Opt-in feeds start off; noted feeds start on (until the health list says otherwise).
	const on = h ? h.state !== "off" : !m.optIn;
	const [error, setError] = useState<string | null>(null);
	return (
		<article class="optin">
			<div>
				<h3 class="key-card__title">{m.name[l]}</h3>
				<p class="note">{why[l]}</p>
				{error ? (
					<p class="key-form__error" role="alert">
						{error}
					</p>
				) : null}
			</div>
			<button
				type="button"
				role="switch"
				aria-checked={on}
				class={`switch${on ? " is-on" : ""}`}
				onClick={async () => {
					// A refused write (no session from the terminal link) used to change nothing and say nothing.
					const sent = await send("POST", `/api/feeds/${id}/enabled`, { on: !on });
					setError(sent.ok ? null : sent.error);
					await refreshHealth();
				}}
			>
				<span class="sr-only">{m.name[l]}</span>
			</button>
		</article>
	);
}

/** Whether this browser may change keys and settings (GET /api/session); null until known. */
const session = signal<{ canChange: boolean; why: string | null } | null>(null);

/** Says, before any click is refused, what this browser needs to change settings. */
function SessionNotice() {
	useEffect(() => {
		void fetch("/api/session", { cache: "no-store" })
			.then((r) => (r.ok ? r.json() : null))
			.then((v) => {
				session.value = v as { canChange: boolean; why: string | null } | null;
			})
			.catch(() => {});
	}, []);
	const s = session.value;
	if (!s || s.canChange) return null;
	return (
		<div class="notice notice--warn guide__session" role="status">
			{s.why === "session" ? (
				<>
					<strong>
						{t("Este navegador aún no puede cambiar ajustes.", "This browser can't change settings yet.")}
					</strong>{" "}
					{t(
						"Por seguridad, solo el enlace que muestra la terminal da ese permiso. Escribe en la terminal:",
						"For safety, only the link the terminal shows grants it. Type in the terminal:",
					)}{" "}
					<code>vigia enlace</code>{" "}
					{t(
						"y abre el enlace que aparece (solo hace falta una vez).",
						"and open the link it shows (only needed once).",
					)}
				</>
			) : s.why === "remote" ? (
				t(
					"Las claves y fuentes solo se cambian desde el equipo donde corre Vigía.",
					"Keys and sources can only be changed from the computer running Vigía.",
				)
			) : (
				t("Este es un espejo público de solo lectura.", "This is a read-only public mirror.")
			)}
		</div>
	);
}

export function GuidePage() {
	useEffect(() => {
		void loadKeys();
	}, []);
	const feeds = health.value;
	const active = feeds.filter((f) => f.state !== "locked" && f.state !== "off").length;
	const total = feeds.length;
	const pct = total ? active / total : 0;
	const open = meta.value.filter((m) => m.keys.length === 0 && !m.optIn);
	const optIns = meta.value.filter((m) => m.optIn);
	const noted = meta.value.filter((m) => m.note && !m.optIn);
	const free = (keys.value ?? []).filter((k) => k.cost !== "paid");
	const paid = (keys.value ?? []).filter((k) => k.cost === "paid");
	const sorted = [...free].sort(
		(a, b) => Number(a.set) - Number(b.set) || a.cost.localeCompare(b.cost) || a.minutes - b.minutes,
	);
	const l = lang.value;
	return (
		<main class="page guide">
			<SessionNotice />
			<header class="page__head guide__head">
				<div>
					<p class="caps page__kicker">{t("Guía de configuración", "Setup guide")}</p>
					<h1 class="page__title">{t("Enciende tu sala de situación", "Light up your situation room")}</h1>
					<p class="page__lede">
						{t(
							"Casi todo funciona sin claves ni tarjeta. Algunas fuentes piden una clave gratuita que se obtiene en minutos con un correo. Todo se guarda en tu equipo.",
							"Almost everything works with no key and no card. A few sources ask for a free key you get in minutes with an email. Everything stays on your machine.",
						)}
					</p>
				</div>
				<div
					class="progress-ring"
					style={{ "--p": pct }}
					role="img"
					aria-label={t(`${active} de ${total} fuentes activas`, `${active} of ${total} feeds active`)}
				>
					<svg viewBox="0 0 120 120" aria-hidden="true">
						<circle cx="60" cy="60" r="52" class="progress-ring__track" />
						<circle cx="60" cy="60" r="52" class="progress-ring__bar" pathLength={1} />
					</svg>
					<span class="progress-ring__label">
						<strong class="data">
							{active}/{total}
						</strong>
						<span>{t("fuentes activas", "feeds active")}</span>
					</span>
				</div>
			</header>

			<section class="guide__step">
				<h2 class="guide__step-title">
					<span class="guide__num">1</span>
					{t("Ya funcionando, sin clave", "Already running, no key")}
				</h2>
				<ul class="chips">
					{open
						.filter((m) => m.layer !== "news")
						.map((m) => {
							const h = feeds.find((f) => f.id === m.id);
							return (
								<li class="chip-feed" key={m.id}>
									{h ? <span class={`dot dot--${h.state}`} /> : null}
									{m.name[l]}
								</li>
							);
						})}
				</ul>
				<details class="guide__outlets">
					<summary>
						{t(
							`Y ${open.filter((m) => m.layer === "news").length} medios de noticias (nacionales, regionales, internacionales)`,
							`And ${open.filter((m) => m.layer === "news").length} news outlets (national, regional, international)`,
						)}
					</summary>
					<ul class="chips">
						{open
							.filter((m) => m.layer === "news")
							.map((m) => {
								const h = feeds.find((f) => f.id === m.id);
								return (
									<li class="chip-feed" key={m.id}>
										{h ? <span class={`dot dot--${h.state}`} /> : null}
										{m.name[l]}
									</li>
								);
							})}
					</ul>
				</details>
			</section>

			<section class="guide__step">
				<h2 class="guide__step-title">
					<span class="guide__num">2</span>
					{t("Claves gratuitas (recomendado, en este orden)", "Free keys (recommended, in this order)")}
				</h2>
				{keys.value === null ? (
					<p class="skeleton">…</p>
				) : sorted.length === 0 ? (
					<p class="empty">{t("Esta versión no necesita claves.", "This version needs no keys.")}</p>
				) : (
					<div class="key-grid">
						{sorted.map((k) => (
							<KeyCard info={k} key={k.id} />
						))}
					</div>
				)}
			</section>

			{paid.length ? (
				<section class="guide__step">
					<h2 class="guide__step-title">
						<span class="guide__num">+</span>
						{t(
							"Mejoras de pago (opcionales, para la Capa IA)",
							"Paid upgrades (optional, for the AI section)",
						)}
					</h2>
					<p class="note">
						{t(
							"Nada de Vigía las necesita. Solo gastan dentro del presupuesto que fijes en la Capa IA.",
							"Nothing in Vigía needs them. They only spend within the budget you set in the AI section.",
						)}
					</p>
					<div class="key-grid">
						{paid.map((k) => (
							<KeyCard info={k} key={k.id} />
						))}
					</div>
				</section>
			) : null}

			{optIns.length ? (
				<section class="guide__step">
					<h2 class="guide__step-title">
						<span class="guide__num">3</span>
						{t("Fuentes opcionales (decides tú)", "Optional sources (your call)")}
					</h2>
					<div class="key-grid">
						{optIns.map((m) => (
							<OptInRow id={m.id} key={m.id} />
						))}
					</div>
				</section>
			) : null}

			{noted.length ? (
				<section class="guide__step">
					<h2 class="guide__step-title">
						<span class="guide__num">+</span>
						{t("Encendidas, con una nota (puedes apagarlas)", "On, with a note (you can turn them off)")}
					</h2>
					<details class="guide__outlets">
						<summary>
							{t(
								`${noted.length} fuentes que Vigía lee a ritmo bajo por decisión del proyecto`,
								`${noted.length} sources Vigía reads at a low rate by the project's decision`,
							)}
						</summary>
						<div class="key-grid">
							{noted.map((m) => (
								<OptInRow id={m.id} key={m.id} />
							))}
						</div>
					</details>
				</section>
			) : null}

			<section class="guide__step">
				<h2 class="guide__step-title">
					<span class="guide__num">{optIns.length ? 4 : 3}</span>
					{t("Revisa el estado", "Check the health")}
				</h2>
				<p class="note">
					{t(
						"La página de estado muestra si alguna fuente falla, se retrasa o cambió de formato.",
						"The status page shows whether a feed is failing, delayed or changed its format.",
					)}{" "}
					<StateBadge state="ok" />
				</p>
			</section>
		</main>
	);
}
