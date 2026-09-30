import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { PowAsk, PowReply } from "../../crowd/pow.worker.ts";
import {
	type CrowdAnswer,
	type CrowdConfig,
	type CrowdService,
	crowdConfig,
	isMunicipalityId,
	loadCrowdConfig,
	reportSheet,
} from "../../lib/crowd.ts";
import { locateMunicipality } from "../../lib/crowd-geo.ts";
import { fold, type MuniChoice, muniChoices, searchMunis } from "../../lib/crowd-places.ts";
import {
	deviceToken,
	dropToken,
	publishedText,
	type Refusal,
	refusalText,
	workShare,
} from "../../lib/crowd-view.ts";
import { addStyles } from "../../lib/css.ts";
import { now, skew } from "../../lib/data.ts";
import { lang, t } from "../../lib/i18n.ts";
import { entityLink } from "../../lib/router.ts";
import { stateName } from "../../lib/states.ts";
import crowdCss from "../../styles/crowd.css?inline";

addStyles(crowdCss);

/*
 * "¿Tienes luz, agua, internet, gasolina?": the report sheet. One calm sheet on a phone and a desk: the municipality
 * (from a list, or placed on this device from its position, coordinates never sent), one answer per service the
 * person wants to answer, and a send button. The proof of work starts in a same-origin Web Worker the moment the
 * sheet opens, so it is usually done before the first tap; only if it is still running at "send" does the sheet say
 * "Preparando envío…". Nothing about the answers is kept on the phone (a seized phone must not say what its owner
 * reported); the municipality only if the person asks. Contract: LOG 2026-09-28 "crowd" and "crowd-token".
 */

const REMEMBER_KEY = "vigia:crowd-municipality";
/** A challenge this close to its expiry is not used: a new one is fetched. */
const EXPIRY_MARGIN_MS = 30_000;

type Challenge = { challenge: string; difficulty: number; expiresAt: number };
type Work =
	| { state: "idle" }
	| { state: "fetching" }
	| { state: "solving"; c: Challenge; attempts: number }
	| { state: "ready"; c: Challenge; nonce: string; ms: number }
	| { state: "failed"; refusal: Refusal };

type Answers = Partial<Record<CrowdService["id"], CrowdAnswer["id"]>>;
type Sent = {
	municipality: { id: string; name: string; state: string };
	results: { service: string; answer: string }[];
	publishedFrom: number;
};

function readRemembered(): string | null {
	try {
		return localStorage.getItem(REMEMBER_KEY);
	} catch {
		return null;
	}
}
function writeRemembered(code: string | null): void {
	try {
		if (code) localStorage.setItem(REMEMBER_KEY, code);
		else localStorage.removeItem(REMEMBER_KEY);
	} catch {
		// Storage off: nothing is remembered, as if unchecked.
	}
}
function session(): Storage | null {
	try {
		return sessionStorage;
	} catch {
		return null;
	}
}

async function refusalOf(res: Response): Promise<Refusal> {
	let body: { code?: unknown; error?: unknown } = {};
	try {
		body = (await res.json()) as typeof body;
	} catch {
		// Not JSON (a proxy's page): the status says enough.
	}
	const retry = Number(res.headers.get("retry-after"));
	return {
		code: typeof body.code === "string" ? body.code : `http-${res.status}`,
		error: typeof body.error === "string" ? body.error : null,
		retryAfterS: Number.isFinite(retry) && retry > 0 ? retry : null,
		status: res.status,
	};
}

const NETWORK: Refusal = { code: "network", error: null, retryAfterS: null, status: 0 };

/**
 * The proof of work: a challenge from the server, solved in the worker; a fresh one when it nears expiry or when the
 * server refuses the answer. `take()` waits for an answer and hands it over once (each challenge is single-use).
 */
function usePow(on: boolean) {
	const [work, setWork] = useState<Work>({ state: "idle" });
	const worker = useRef<Worker | null>(null);
	const seq = useRef(0);
	const waiters = useRef<((w: Work) => void)[]>([]);
	const current = useRef<Work>(work);
	const set = (w: Work) => {
		current.current = w;
		setWork(w);
		if (w.state === "ready" || w.state === "failed") {
			const ws = waiters.current;
			waiters.current = [];
			for (const f of ws) f(w);
		}
	};
	const start = async () => {
		const id = ++seq.current;
		const wasSolving = current.current.state === "solving";
		set({ state: "fetching" });
		let c: Challenge;
		try {
			const res = await fetch("/api/crowd/challenge", {
				headers: { accept: "application/json" },
				cache: "no-store",
			});
			if (id !== seq.current) return;
			if (!res.ok) {
				set({ state: "failed", refusal: await refusalOf(res) });
				return;
			}
			const body = (await res.json()) as Partial<Challenge>;
			// Only a challenge of the documented shape reaches the worker (a proxy's page or an odd body does not).
			if (
				typeof body.challenge !== "string" ||
				!/^[\x20-\x7e]{8,300}$/.test(body.challenge) ||
				typeof body.difficulty !== "number" ||
				body.difficulty < 8 ||
				body.difficulty > 28 ||
				typeof body.expiresAt !== "number"
			)
				throw new Error("challenge");
			c = { challenge: body.challenge, difficulty: body.difficulty, expiresAt: body.expiresAt };
		} catch {
			if (id === seq.current) set({ state: "failed", refusal: NETWORK });
			return;
		}
		if (id !== seq.current) return;
		if (typeof __POW_WORKER__ === "undefined") {
			set({ state: "failed", refusal: { code: "worker", error: null, retryAfterS: null, status: 0 } });
			return;
		}
		// A worker still solving an older challenge is replaced (a solve cannot be interrupted from outside).
		if (wasSolving) {
			worker.current?.terminate();
			worker.current = null;
		}
		worker.current ??= new Worker(__POW_WORKER__);
		const w = worker.current;
		set({ state: "solving", c, attempts: 0 });
		w.onmessage = (e: MessageEvent<PowReply>) => {
			const r = e.data;
			if (r.id !== id || id !== seq.current) return;
			if (r.type === "progress") setWork({ state: "solving", c, attempts: r.attempts });
			else if (r.type === "done") set({ state: "ready", c, nonce: r.nonce, ms: r.ms });
			else set({ state: "failed", refusal: { code: "pow", error: null, retryAfterS: null, status: 0 } });
		};
		w.onerror = () => {
			if (id === seq.current)
				set({ state: "failed", refusal: { code: "worker", error: null, retryAfterS: null, status: 0 } });
		};
		const ask: PowAsk = { id, challenge: c.challenge, difficulty: c.difficulty };
		w.postMessage(ask);
	};
	useEffect(() => {
		if (!on) return;
		void start();
		return () => {
			seq.current++;
			worker.current?.terminate();
			worker.current = null;
			// A send still waiting for the work ends with the sheet (its promise must settle).
			const ws = waiters.current;
			waiters.current = [];
			for (const f of ws)
				f({ state: "failed", refusal: { code: "closed", error: null, retryAfterS: null, status: 0 } });
		};
	}, [on]);
	/** The answer to send: waits for the work, refreshes an expiring challenge, and spends it. */
	const take = async (): Promise<{ challenge: string; nonce: string } | Refusal> => {
		// The challenge's expiry is the server's clock: compare it with the server's time, not the phone's (skew).
		const serverNow = () => Date.now() + skew.peek();
		for (let round = 0; round < 3; round++) {
			let w = current.current;
			if (w.state === "ready" && w.c.expiresAt - serverNow() < EXPIRY_MARGIN_MS) {
				void start();
				w = current.current;
			}
			// A press on "Enviar" asks again after a failure (a limit's Retry-After may have passed; if not, the server
			// says so again).
			if (w.state === "idle" || (w.state === "failed" && round === 0)) {
				void start();
				w = current.current;
			}
			if (w.state === "fetching" || w.state === "solving")
				w = await new Promise<Work>((resolve) => waiters.current.push(resolve));
			if (w.state === "failed") return w.refusal;
			if (w.state === "ready" && w.c.expiresAt - serverNow() >= EXPIRY_MARGIN_MS) {
				// Spent (single-use): a retry or another report asks for a new challenge then, not before.
				set({ state: "idle" });
				return { challenge: w.c.challenge, nonce: w.nonce };
			}
		}
		return { code: "pow", error: null, retryAfterS: null, status: 0 };
	};
	return { work, take, restart: () => void start() };
}

/** The municipality index, loaded with the sheet (≈ 8 KB). */
function useMunis(): MuniChoice[] | null {
	const [all, setAll] = useState<MuniChoice[] | null>(null);
	useEffect(() => {
		let alive = true;
		void import("../../lib/places.gen.ts").then(({ PLACES }) => {
			if (alive) setAll(muniChoices(PLACES));
		});
		return () => {
			alive = false;
		};
	}, []);
	return all;
}

function MuniPicker({
	all,
	chosen,
	onChoose,
}: {
	all: MuniChoice[] | null;
	chosen: MuniChoice | null;
	onChoose: (m: MuniChoice | null) => void;
}) {
	const [q, setQ] = useState("");
	const [geo, setGeo] = useState<
		| { state: "idle" | "asking" }
		| { state: "said"; text: string }
		| { state: "placed"; accuracyM: number }
		| { state: "choose"; options: MuniChoice[]; accuracyM: number }
	>({ state: "idle" });
	const hits = useMemo(() => (all ? searchMunis(all, q) : []), [all, q]);
	const input = useRef<HTMLInputElement>(null);
	if (chosen)
		return (
			<div class="rep-muni rep-muni--chosen">
				<p class="rep-muni__name">
					<strong>{chosen.name}</strong> <span>· {chosen.stateName}</span>
					{geo.state === "placed" ? (
						<span class="rep-muni__how">
							{t(
								`según la ubicación de este teléfono (±${geo.accuracyM} m): revísalo`,
								`from this phone's position (±${geo.accuracyM} m): check it`,
							)}
						</span>
					) : null}
				</p>
				<button
					type="button"
					class="btn"
					onClick={() => {
						onChoose(null);
						setGeo({ state: "idle" });
						requestAnimationFrame(() => input.current?.focus());
					}}
				>
					{t("Cambiar", "Change")}
				</button>
			</div>
		);
	const useLocation = () => {
		setGeo({ state: "asking" });
		void locateMunicipality().then((r) => {
			if (r.ok) {
				const options = r.candidates
					.map((c) => all?.find((x) => x.code === c.code))
					.filter((m): m is MuniChoice => m !== undefined);
				const [first] = options;
				if (options.length === 1 && first) {
					onChoose(first);
					setGeo({ state: "placed", accuracyM: r.accuracyM });
					return;
				}
				if (options.length > 1) {
					setGeo({ state: "choose", options, accuracyM: r.accuracyM });
					return;
				}
			}
			const why = r.ok ? "outside" : r.why;
			const text =
				why === "insecure"
					? t(
							"Esta página se abrió sin https, y el navegador no da la ubicación así. Elige tu municipio en la lista.",
							"This page was opened without https, and the browser gives no position like that. Pick your municipality from the list.",
						)
					: why === "denied"
						? t(
								"Este navegador no dio permiso para la ubicación. Elige tu municipio en la lista.",
								"This browser did not allow location. Pick your municipality from the list.",
							)
						: why === "coarse"
							? t(
									`La ubicación de este teléfono es aproximada (±${r.ok ? 0 : (r.km ?? 0)} km): elige tu municipio en la lista.`,
									`This phone's position is approximate (±${r.ok ? 0 : (r.km ?? 0)} km): pick your municipality from the list.`,
								)
							: why === "outside"
								? t(
										"La ubicación no cae dentro de ningún municipio de Venezuela. Elige tu municipio en la lista.",
										"The position is not inside any Venezuelan municipality. Pick your municipality from the list.",
									)
								: t(
										"No se pudo obtener la ubicación. Elige tu municipio en la lista.",
										"The position could not be found. Pick your municipality from the list.",
									);
			setGeo({ state: "said", text });
		});
	};
	return (
		<div class="rep-muni">
			<label class="rep-label" for="rep-muni-q">
				{t("Busca tu municipio o tu ciudad", "Search your municipality or city")}
			</label>
			<div class="rep-muni__row">
				<input
					ref={input}
					id="rep-muni-q"
					class="rep-input"
					type="search"
					autocomplete="off"
					placeholder={t("p. ej. Maracaibo, Chacao, Barquisimeto", "e.g. Maracaibo, Chacao, Barquisimeto")}
					value={q}
					onInput={(e) => setQ((e.target as HTMLInputElement).value)}
					aria-describedby="rep-muni-hint"
				/>
				{"geolocation" in navigator ? (
					<button
						type="button"
						class="btn rep-locate"
						onClick={useLocation}
						disabled={geo.state === "asking"}
					>
						<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" class="ico">
							<circle cx="8" cy="8" r="4.5" />
							<path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15" />
						</svg>
						{geo.state === "asking" ? t("Ubicando…", "Locating…") : t("Usar mi ubicación", "Use my location")}
					</button>
				) : null}
			</div>
			<p class="rep-hint" id="rep-muni-hint">
				{t(
					"Con «Usar mi ubicación», este teléfono busca el municipio que contiene su posición y la olvida: las coordenadas no se envían ni se guardan.",
					"With “Use my location”, this phone finds the municipality that contains its position and forgets it: the coordinates are never sent or kept.",
				)}
			</p>
			{geo.state === "choose" ? (
				<fieldset class="rep-choose">
					<legend class="rep-hint rep-hint--note">
						{t(
							`Según la ubicación de este teléfono (±${geo.accuracyM} m) puedes estar en cualquiera de estos. ¿Cuál es el tuyo?`,
							`From this phone's position (±${geo.accuracyM} m) you may be in any of these. Which is yours?`,
						)}
					</legend>
					<ul class="rep-hits">
						{geo.options.map((m) => (
							<li key={m.code}>
								<button
									type="button"
									class="rep-hit"
									onClick={() => {
										onChoose(m);
										setGeo({ state: "idle" });
									}}
								>
									<span class="rep-hit__name">{m.name}</span>
									<span class="rep-hit__state">{m.stateName}</span>
								</button>
							</li>
						))}
					</ul>
				</fieldset>
			) : null}
			{geo.state === "said" ? (
				<p class="rep-hint rep-hint--note" role="status">
					{geo.text}
				</p>
			) : null}
			{q.trim().length >= 2 ? (
				<>
					<p class="sr-only" aria-live="polite">
						{t(`${hits.length} municipios`, `${hits.length} municipalities`)}
					</p>
					{hits.length ? (
						<ul class="rep-hits" aria-label={t("Municipios que coinciden", "Matching municipalities")}>
							{hits.map((m) => {
								const city = m.cities.find((c) => fold(c).startsWith(fold(q.trim())));
								return (
									<li key={m.code}>
										<button type="button" class="rep-hit" onClick={() => onChoose(m)}>
											<span class="rep-hit__name">{m.name}</span>
											<span class="rep-hit__state">
												{city ? `${city} · ` : ""}
												{m.stateName}
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					) : (
						<p class="rep-hint">
							{all
								? t("Ningún municipio con ese nombre.", "No municipality by that name.")
								: t("Cargando la lista…", "Loading the list…")}
						</p>
					)}
				</>
			) : null}
		</div>
	);
}

function ServiceQuestion({
	s,
	answers,
	value,
	onChange,
}: {
	s: CrowdService;
	answers: CrowdAnswer[];
	value: CrowdAnswer["id"] | undefined;
	onChange: (a: CrowdAnswer["id"] | undefined) => void;
}) {
	const l = lang.value;
	return (
		<fieldset class="rep-q">
			<legend class="rep-q__legend">{s.question[l]}</legend>
			<div class="rep-q__answers">
				{answers.map((a) => (
					<label key={a.id} class={`rep-a rep-a--${a.id}${value === a.id ? " is-on" : ""}`}>
						<input
							type="radio"
							name={`rep-${s.id}`}
							value={a.id}
							checked={value === a.id}
							onChange={() => onChange(a.id)}
						/>
						<span>{a[l]}</span>
					</label>
				))}
			</div>
			{value ? (
				<button type="button" class="link-button rep-q__clear" onClick={() => onChange(undefined)}>
					{t(`No responder sobre ${s.es}`, `Do not answer about ${s.en}`)}
				</button>
			) : null}
		</fieldset>
	);
}

function Disclosures({ c }: { c: CrowdConfig }) {
	const l = lang.value;
	return (
		<div class="rep-more">
			<details class="rep-details">
				<summary>{t("Qué guarda Vigía", "What Vigía keeps")}</summary>
				<ul>
					{c.stored[l].map((x) => (
						<li key={x}>{x}</li>
					))}
				</ul>
				<p class="rep-hint">
					{t(
						"En este teléfono: nada de tus respuestas. Un identificador aleatorio de esta pestaña (se borra al cerrarla, se renueva cada día), para que varios teléfonos detrás de una misma conexión cuenten por separado; y tu municipio solo si marcas «recordar».",
						"On this phone: nothing of your answers. A random identifier for this tab (gone when it closes, renewed daily), so several phones behind one connection count separately; and your municipality only if you tick “remember”.",
					)}
				</p>
			</details>
			<details class="rep-details">
				<summary>{t("Cómo se cuentan", "How they are counted")}</summary>
				<ul>
					{c.rules[l].map((x) => (
						<li key={x}>{x}</li>
					))}
				</ul>
				<p class="rep-hint">
					{c.source.attribution} ·{" "}
					<a href={c.source.licenceUrl} target="_blank" rel="noopener noreferrer">
						{c.source.licenceName}
					</a>
				</p>
			</details>
		</div>
	);
}

function Done({ sent, c, onClose }: { sent: Sent; c: CrowdConfig; onClose: () => void }) {
	const l = lang.value;
	const svc = new Map(c.services.map((s) => [s.id, s]));
	const ans = new Map(c.answers.map((a) => [a.id, a]));
	const close = useRef<HTMLButtonElement>(null);
	useEffect(() => close.current?.focus(), []);
	return (
		<div class="rep-done">
			<p class="rep-done__mark" role="status">
				<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" class="ico">
					<path d="M3 8.5 6.5 12 13 4.5" />
				</svg>
				{t("Recibido", "Received")}
			</p>
			<p class="rep-done__where">
				{sent.municipality.name} · {stateName(sent.municipality.state) || sent.municipality.state}
			</p>
			<ul class="rep-done__list">
				{sent.results.map((r) => (
					<li key={r.service}>
						<span>{svc.get(r.service as CrowdService["id"])?.[l] ?? r.service}</span>
						<strong>{ans.get(r.answer as CrowdAnswer["id"])?.[l] ?? r.answer}</strong>
					</li>
				))}
			</ul>
			<p class="rep-hint">
				{publishedText(sent.publishedFrom, now.value, l, c.mode === "public" ? c.minReporters : null)}{" "}
				{t(
					"Se muestra como «reportes de usuarios» con su cantidad y su hora, nunca como una medición. Si respondes de nuevo desde este teléfono (esta pestaña), la respuesta nueva reemplaza a la anterior.",
					"It shows as “user reports” with their count and time, never as a measurement. If you answer again from this phone (this tab), the new answer replaces the earlier one.",
				)}
			</p>
			<p class="rep-hint">
				{t("Este teléfono no guarda lo que respondiste.", "This phone does not keep what you answered.")}
			</p>
			<div class="rep-actions">
				<button type="button" class="btn btn--primary" ref={close} onClick={onClose}>
					{t("Cerrar", "Close")}
				</button>
				{isMunicipalityId(sent.municipality.id) ? (
					<a
						class="btn"
						href={entityLink(sent.municipality.id).href}
						onClick={(e) => {
							entityLink(sent.municipality.id).onClick(e);
							onClose();
						}}
					>
						{t("Ver tu municipio", "See your municipality")}
					</a>
				) : null}
			</div>
		</div>
	);
}

function Form({ c, start, onClose }: { c: CrowdConfig; start: string | null; onClose: () => void }) {
	const all = useMunis();
	const pow = usePow(c.enabled);
	const [chosen, setChosen] = useState<MuniChoice | null>(null);
	const [remember, setRemember] = useState(() => readRemembered() !== null);
	const [answers, setAnswers] = useState<Answers>({});
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState<Sent | null>(null);
	const l = lang.value;

	// Start from the municipality the reader is looking at, else the remembered one.
	useEffect(() => {
		if (!all || chosen) return;
		const remembered = readRemembered();
		const m =
			(start ? all.find((x) => x.id === start || x.code === start) : undefined) ??
			(remembered ? all.find((x) => x.code === remembered) : undefined);
		if (m) setChosen(m);
	}, [all]);

	const answered = Object.entries(answers).filter(([, v]) => v) as [string, string][];
	const canSend = Boolean(chosen) && answered.length > 0 && !sending;

	const submit = async (e: Event) => {
		e.preventDefault();
		if (!chosen || !answered.length) return;
		setSending(true);
		setError(null);
		writeRemembered(remember ? chosen.code : null);
		let retriedPow = false;
		let retriedToken = false;
		try {
			for (;;) {
				const proof = await pow.take();
				if ("code" in proof) {
					setError(refusalText(proof, l));
					return;
				}
				const token = deviceToken(session(), Date.now());
				let res: Response;
				try {
					res = await fetch(c.submit, {
						method: "POST",
						headers: { "content-type": "application/json", accept: "application/json" },
						cache: "no-store",
						body: JSON.stringify({
							municipality: chosen.code,
							answers: Object.fromEntries(answered),
							challenge: proof.challenge,
							nonce: proof.nonce,
							token,
						}),
					});
				} catch {
					setError(refusalText(NETWORK, l));
					return;
				}
				if (res.ok) {
					const body = (await res.json()) as Sent;
					setSent(body);
					setAnswers({});
					return;
				}
				const r = await refusalOf(res);
				// The work was not accepted (expired, spent): a new challenge and once more, silently.
				if (r.code === "pow" && !retriedPow) {
					retriedPow = true;
					continue;
				}
				// A token the server cannot read (a stale format): a new one and once more.
				if (r.code === "invalid" && !retriedToken) {
					retriedToken = true;
					dropToken(session());
					continue;
				}
				setError(refusalText(r, l));
				return;
			}
		} finally {
			setSending(false);
		}
	};

	if (sent) return <Done sent={sent} c={c} onClose={onClose} />;
	const work = pow.work;
	const preparing = sending && (work.state === "solving" || work.state === "fetching");
	return (
		<form
			class="rep-form"
			onSubmit={submit}
			data-pow-ms={work.state === "ready" ? Math.round(work.ms) : undefined}
		>
			<section class="rep-step" aria-labelledby="rep-where">
				<h3 class="rep-step__title" id="rep-where">
					{t("¿Dónde?", "Where?")}
				</h3>
				<MuniPicker all={all} chosen={chosen} onChoose={setChosen} />
				{chosen ? (
					<label class="rep-check">
						<input
							type="checkbox"
							checked={remember}
							onChange={(e) => {
								const on = (e.target as HTMLInputElement).checked;
								setRemember(on);
								if (!on) writeRemembered(null);
							}}
						/>
						<span>
							{t("Recordar mi municipio en este teléfono", "Remember my municipality on this phone")}
						</span>
					</label>
				) : null}
			</section>
			<section class="rep-step" aria-labelledby="rep-what">
				<h3 class="rep-step__title" id="rep-what">
					{t("¿Qué tienes ahora?", "What do you have now?")}
				</h3>
				<p class="rep-hint">
					{t(
						"Responde solo lo que sepas; lo que no marques no se envía.",
						"Answer only what you know; what you leave blank is not sent.",
					)}
				</p>
				{c.services.map((s) => (
					<ServiceQuestion
						key={s.id}
						s={s}
						answers={c.answers}
						value={answers[s.id]}
						onChange={(a) => setAnswers((prev) => ({ ...prev, [s.id]: a }))}
					/>
				))}
			</section>
			{error ? (
				<p class="rep-error" role="alert">
					{error}
				</p>
			) : null}
			<div class="rep-actions">
				<button type="submit" class="btn btn--primary rep-send" disabled={!canSend}>
					{sending ? t("Enviando…", "Sending…") : t("Enviar reporte", "Send report")}
				</button>
				<span class="rep-status" role="status">
					{preparing && work.state === "solving"
						? t(
								`Preparando envío… ${Math.round(workShare(work.attempts, work.c.difficulty) * 100)} %`,
								`Preparing to send… ${Math.round(workShare(work.attempts, work.c.difficulty) * 100)} %`,
							)
						: preparing
							? t("Preparando envío…", "Preparing to send…")
							: !chosen
								? t("Falta el municipio", "Choose a municipality")
								: !answered.length
									? t("Falta al menos una respuesta", "Answer at least one question")
									: ""}
				</span>
			</div>
			<Disclosures c={c} />
		</form>
	);
}

/** The sheet itself: a modal dialog, a bottom sheet on a phone. */
export function ReportSheet() {
	const ref = useRef<HTMLDialogElement>(null);
	const open = reportSheet.value;
	const [config, setConfig] = useState<CrowdConfig | null | "failed">(crowdConfig.value);
	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (open && !d.open) d.showModal();
		if (!open && d.open) d.close();
	}, [open]);
	useEffect(() => {
		if (!open || (config && config !== "failed")) return;
		void loadCrowdConfig().then((c) => setConfig(c ?? "failed"));
	}, [open, config]);
	const close = () => {
		reportSheet.value = null;
	};
	const c = config && config !== "failed" ? config : null;
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Escape closes the dialog natively.
		<dialog
			ref={ref}
			class="sheet sheet--report"
			aria-labelledby="rep-title"
			onClose={close}
			onClick={(e) => {
				if (e.target === ref.current) close();
			}}
		>
			{open ? (
				<div class="sheet__inner">
					<header class="sheet__head">
						<div>
							<p class="caps sheet__kicker">{t("Reporte anónimo de usuario", "Anonymous user report")}</p>
							<h2 id="rep-title" class="sheet__title">
								{t("¿Tienes luz, agua, internet, gasolina?", "Do you have power, water, internet, fuel?")}
							</h2>
							<p class="sheet__sub">
								{t(
									"Tu respuesta se suma a las de otras personas de tu municipio y se muestra como «reportes de usuarios», con su cantidad y su hora: nunca como una medición. Sin cuenta, sin nombre.",
									"Your answer joins those of other people in your municipality and shows as “user reports”, with their count and time: never as a measurement. No account, no name.",
								)}
							</p>
						</div>
						<button type="button" class="sheet__close" onClick={close}>
							<span aria-hidden="true">✕</span>
							<span class="sr-only">{t("Cerrar", "Close")}</span>
						</button>
					</header>
					{c ? (
						c.enabled ? (
							<Form key={JSON.stringify(open)} c={c} start={open.municipality} onClose={close} />
						) : (
							<p class="rep-off" role="status">
								{t(
									"Este Vigía no recibe reportes de usuarios: quien lo administra los apagó.",
									"This Vigía does not take user reports: whoever runs it turned them off.",
								)}
							</p>
						)
					) : config === "failed" ? (
						<p class="rep-error" role="alert">
							{t(
								"No se pudo hablar con Vigía para preparar el reporte. Revisa la conexión e inténtalo de nuevo.",
								"Could not reach Vigía to prepare the report. Check the connection and try again.",
							)}{" "}
							<button type="button" class="link-button" onClick={() => setConfig(null)}>
								{t("Reintentar", "Retry")}
							</button>
						</p>
					) : (
						<p class="rep-hint" role="status">
							{t("Preparando…", "Preparing…")}
						</p>
					)}
				</div>
			) : null}
		</dialog>
	);
}
