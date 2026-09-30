import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { TimelineItem } from "../../../../src/ontology/view.ts";
import { now } from "../../lib/data.ts";
import { fetchTimeline } from "../../lib/entity-api.ts";
import { clock, int, num, stamp, TZ } from "../../lib/format.ts";
import { lang, t } from "../../lib/i18n.ts";
import { openEntity } from "../../lib/router.ts";

/**
 * An entity's timeline (`/api/v1/entities/{id}/timeline`): what the archive links to it, newest first. A range
 * (48 h to a year), a density strip that is also the time slider (a press on a bar narrows the list to that hour or
 * day), filters by kind (asked of the server, so counts are exact), and older pages on demand until the archive
 * runs out. Each row says how it is linked (keyword, name, distance) and where it comes from.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type RangeId = "48h" | "7d" | "30d" | "90d" | "1y";
const RANGES: Record<RangeId, { ms: number; bin: number; es: string; en: string }> = {
	"48h": { ms: 48 * HOUR, bin: HOUR, es: "48 h", en: "48 h" },
	"7d": { ms: 7 * DAY, bin: 6 * HOUR, es: "7 días", en: "7 days" },
	"30d": { ms: 30 * DAY, bin: DAY, es: "30 días", en: "30 days" },
	"90d": { ms: 90 * DAY, bin: DAY, es: "90 días", en: "90 days" },
	"1y": { ms: 365 * DAY, bin: 7 * DAY, es: "1 año", en: "1 year" },
};
const PAGE = 150;

export const KIND: Record<string, { es: string; en: string; shape: "solid" | "hollow" | "dashed" }> = {
	quake: { es: "Sismo", en: "Quake", shape: "solid" },
	fire: { es: "Foco de calor", en: "Heat spot", shape: "solid" },
	flare: { es: "Quema de gas", en: "Gas flare", shape: "solid" },
	outage: { es: "Caída (IODA)", en: "Outage (IODA)", shape: "solid" },
	routing: { es: "Rutas (BGP)", en: "Routing (BGP)", shape: "solid" },
	block: { es: "Bloqueo", en: "Block", shape: "solid" },
	hazard: { es: "Alerta GDACS", en: "GDACS alert", shape: "dashed" },
	incident: { es: "Incidente", en: "Incident", shape: "dashed" },
	headline: { es: "Titular", en: "Headline", shape: "hollow" },
	gazette: { es: "Gaceta Oficial", en: "Official Gazette", shape: "hollow" },
	crowd: { es: "Reportes de usuarios", en: "User reports", shape: "hollow" },
	sanction: { es: "Sanción (OFAC)", en: "Sanction (OFAC)", shape: "hollow" },
	licence: { es: "Licencia (OFAC)", en: "Licence (OFAC)", shape: "hollow" },
	intervention: { es: "Intervención cambiaria", en: "FX intervention", shape: "hollow" },
	plume: { es: "Metano", en: "Methane", shape: "solid" },
	flood: { es: "Inundación", en: "Flood", shape: "solid" },
	forest: { es: "Bosque", en: "Forest", shape: "solid" },
	ships: { es: "Buques", en: "Ships", shape: "solid" },
	radar: { es: "Cloudflare", en: "Cloudflare", shape: "hollow" },
	flight: { es: "Vuelos", en: "Flights", shape: "solid" },
};

const RULE: Record<string, { es: string; en: string }> = {
	"text-place": { es: "palabra clave", en: "keyword" },
	"text-name": { es: "por su nombre", en: "by name" },
	outlet: { es: "del medio", en: "the outlet's" },
	near: { es: "cerca", en: "near" },
	located: { es: "ubicado aquí", en: "located here" },
	"state-code": { es: "código del estado", en: "state code" },
	organ: { es: "órgano que publica", en: "publishing body" },
	incident: { es: "incidente de Vigía", en: "Vigía incident" },
	threshold: { es: "umbral de Vigía", en: "Vigía's threshold" },
	area: { es: "zona vigilada", en: "watched area" },
	route: { es: "ruta publicada del vuelo", en: "the flight's published route" },
};

const dayKey = new Intl.DateTimeFormat("en-CA", {
	timeZone: TZ,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});
const dayTitle = {
	es: new Intl.DateTimeFormat("es-VE", {
		timeZone: TZ,
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
	}),
	en: new Intl.DateTimeFormat("en-US", {
		timeZone: TZ,
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
	}),
};

/** Figures worth a word, when the source allows passing them on. */
function figureWords(it: TimelineItem): string[] {
	const f = it.figures;
	const l = lang.value;
	const out: string[] = [];
	if (it.km !== null) out.push(t(`a ${num(it.km, 1, l)} km`, `${num(it.km, 1, l)} km away`));
	if (!f) return out;
	if (typeof f.mag === "number") out.push(`M${num(f.mag, 1, l)}`);
	if (typeof f.depthKm === "number")
		out.push(t(`${num(f.depthKm, 0, l)} km de profundidad`, `${num(f.depthKm, 0, l)} km deep`));
	if (typeof f.frpMW === "number") out.push(`${num(f.frpMW, 1, l)} MW`);
	if (typeof f.corroboration === "number")
		out.push(
			t(
				`${f.corroboration} ${f.corroboration === 1 ? "familia" : "familias"}`,
				`${f.corroboration} ${f.corroboration === 1 ? "family" : "families"}`,
			),
		);
	return out;
}

interface Window {
	from: number;
	to: number;
}

const CARACAS_MS = 4 * HOUR;
/** Rows drawn at first; more on a press (phones) or as the list's end comes into view (desks). */
const FIRST_ROWS = 25;
const MORE_ROWS = 50;
/** Windows further back that come back empty before the list stops offering to look further. */
const EMPTY_STOP = 3;

export function Timeline({
	path,
	backlog,
	rules,
	kinds: available = [],
}: {
	path: string;
	backlog: number;
	rules: readonly string[];
	/** The kinds the archive can link to this entity's type, offered as filters even before any is loaded. */
	kinds?: readonly string[];
}) {
	const l = lang.value;
	const [range, setRange] = useState<RangeId>("7d");
	const [kinds, setKinds] = useState<string[]>([]);
	/** The loaded window: its newest end is the moment of loading, its oldest moves back as older pages arrive. */
	const [win, setWin] = useState<Window>(() => ({ from: now.peek() - RANGES["7d"].ms, to: now.peek() }));
	const [items, setItems] = useState<TimelineItem[]>([]);
	const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
	const [more, setMore] = useState<"idle" | "loading">("idle");
	/** More items remain inside the loaded window (the server said `truncated`). */
	const [truncated, setTruncated] = useState(false);
	/** Consecutive older windows that came back empty. */
	const [empties, setEmpties] = useState(0);
	const [rows, setRows] = useState(FIRST_ROWS);
	/** A press on a bar narrows the list to that bin. */
	const [focus, setFocus] = useState<Window | null>(null);
	const [seenKinds, setSeenKinds] = useState<Set<string>>(new Set());
	const tail = useRef<HTMLLIElement>(null);
	const [nonce, setNonce] = useState(0);
	/** Which list an older page belongs to: a page for a previous range or filter is dropped, never appended. */
	const gen = useRef(0);
	const older = useRef<AbortController | null>(null);
	/** A page of items all at the same millisecond as the cut: step past it next time. */
	const stepPast = useRef(false);

	// A new entity, range or filter starts over from now.
	useEffect(() => {
		const g = ++gen.current;
		older.current?.abort();
		const ctrl = new AbortController();
		const to = now.peek();
		const from = to - RANGES[range].ms;
		setStatus("loading");
		setFocus(null);
		setRows(FIRST_ROWS);
		setEmpties(0);
		setMore("idle");
		stepPast.current = false;
		fetchTimeline(path, { from, to, limit: PAGE, kinds }, ctrl.signal)
			.then((v) => {
				if (g !== gen.current) return;
				if (!v) {
					setStatus("error");
					return;
				}
				setItems(v.items);
				setWin({ from: v.from, to: v.to });
				setTruncated(v.truncated);
				if (!kinds.length) setSeenKinds(new Set(v.items.map((i) => i.kind)));
				setStatus("ok");
			})
			.catch((err: Error) => {
				if (err.name !== "AbortError" && g === gen.current) setStatus("error");
			});
		return () => ctrl.abort();
	}, [path, range, kinds.join(","), nonce]);
	useEffect(() => () => older.current?.abort(), []);

	/**
	 * Older: the rest of the window if it was cut (from the cut, inclusive: several items often share one
	 * millisecond), else the same span again further back.
	 */
	const loadOlder = () => {
		if (more === "loading") return;
		const g = gen.current;
		const oldest = items.at(-1)?.at;
		const span = RANGES[range].ms;
		const q =
			truncated && oldest !== undefined
				? { from: win.from, to: stepPast.current ? oldest - 1 : oldest }
				: { from: Math.max(0, win.from - span), to: win.from - 1 };
		const ctrl = new AbortController();
		older.current = ctrl;
		setMore("loading");
		fetchTimeline(path, { ...q, limit: PAGE, kinds }, ctrl.signal)
			.then((v) => {
				if (!v || g !== gen.current) return;
				const key = (i: TimelineItem) => `${i.kind}|${i.url}|${i.at}`;
				const seen = new Set(items.map(key));
				const fresh = v.items.filter((i) => !seen.has(key(i)));
				stepPast.current = v.truncated && !fresh.length;
				setItems((cur) => [...cur, ...fresh]);
				setWin((w) => ({ from: Math.min(w.from, v.from), to: w.to }));
				setEmpties((n) => (truncated ? n : v.items.length ? 0 : n + 1));
				setTruncated(v.truncated);
				setRows((r) => r + MORE_ROWS);
				if (!kinds.length) setSeenKinds((s) => new Set([...s, ...v.items.map((i) => i.kind)]));
			})
			.catch(() => {})
			.finally(() => {
				if (g === gen.current) setMore("idle");
			});
	};
	const exhausted = !truncated && empties >= EMPTY_STOP;
	/** Next rows: those already loaded first, then an older page. */
	const showMore = () => {
		if (rows < items.length) setRows((r) => r + MORE_ROWS);
		else if (!exhausted) loadOlder();
	};

	// Desks: the list's end coming into view shows more (the button stays for keyboards). Phones press the button,
	// so the page under the timeline stays reachable.
	useEffect(() => {
		const el = tail.current;
		if (!el || status !== "ok" || !("IntersectionObserver" in window)) return;
		if (!matchMedia("(min-width: 1000px)").matches) return;
		const io = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting) && (rows < items.length || truncated)) showMore();
		});
		io.observe(el);
		return () => io.disconnect();
	}, [status, items.length, truncated, rows]);

	// Bars stay between ~30 and 120 however far back older pages reach; day bins follow Caracas days.
	const bin =
		[RANGES[range].bin, 6 * HOUR, DAY, 7 * DAY, 30 * DAY].find((b) => (win.to - win.from) / b <= 120) ??
		30 * DAY;
	const bins = useMemo(() => {
		const shift = bin >= DAY ? CARACAS_MS : 0;
		const start = Math.floor((win.from - shift) / bin) * bin + shift;
		const count = Math.max(1, Math.ceil((win.to - start) / bin));
		const out = Array.from({ length: count }, (_, i) => ({ at: start + i * bin, n: 0 }));
		for (const it of items) {
			const b = out[Math.floor((it.at - start) / bin)];
			if (b) b.n++;
		}
		return out;
	}, [items, win.from, win.to, bin]);
	const max = Math.max(1, ...bins.map((b) => b.n));

	const inFocus = useMemo(
		() => (focus ? items.filter((i) => i.at >= focus.from && i.at < focus.to) : items),
		[items, focus],
	);
	const groups = useMemo(() => {
		const out: { day: string; at: number; items: TimelineItem[] }[] = [];
		for (const it of inFocus.slice(0, rows)) {
			const day = dayKey.format(it.at);
			const last = out.at(-1);
			if (last?.day === day) last.items.push(it);
			else out.push({ day, at: it.at, items: [it] });
		}
		return out;
	}, [inFocus, rows]);

	const kindList = [...new Set([...available, ...seenKinds, ...kinds])].sort(
		(a, b) => Object.keys(KIND).indexOf(a) - Object.keys(KIND).indexOf(b),
	);
	const barW = 100 / bins.length;
	const ref = now.peek();
	const left = inFocus.length - rows;
	return (
		<section class="esec tl" aria-labelledby="esec-timeline">
			<header class="esec__head tl__head">
				<h2 class="esec__title" id="esec-timeline">
					{t("Cronología", "Timeline")}
				</h2>
				{status === "ok" ? (
					<span class="esec__count mono">
						{int(items.length, l)}
						{truncated ? "+" : ""}
					</span>
				) : null}
				{/* biome-ignore lint/a11y/useSemanticElements: a segmented control of buttons, not a form group. */}
				<div class="tl__ranges" role="group" aria-label={t("Rango", "Range")}>
					{(Object.keys(RANGES) as RangeId[]).map((r) => (
						<button key={r} type="button" class="seg" aria-pressed={range === r} onClick={() => setRange(r)}>
							{RANGES[r][l]}
						</button>
					))}
				</div>
			</header>
			{kindList.length > 1 || kinds.length ? (
				// biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons.
				<div class="tl__kinds" role="group" aria-label={t("Tipo", "Kind")}>
					<button type="button" class="seg" aria-pressed={!kinds.length} onClick={() => setKinds([])}>
						{t("Todo", "All")}
					</button>
					{kindList.map((k) => (
						<button
							key={k}
							type="button"
							class="seg"
							aria-pressed={kinds.includes(k)}
							onClick={() => setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k])}
						>
							<span class={`tl-shape tl-shape--${KIND[k]?.shape ?? "solid"}`} aria-hidden="true" />
							{KIND[k]?.[l] ?? k}
						</button>
					))}
				</div>
			) : null}
			{status === "ok" && items.length ? (
				<div class="tl__strip">
					<svg
						class="tl__bars"
						viewBox="0 0 100 24"
						preserveAspectRatio="none"
						role="img"
						aria-label={t(
							`Hechos por ${bin >= DAY ? "día" : "intervalo"}, del ${stamp(win.from, l, ref)} al ${stamp(win.to, l, ref)}`,
							`Events per ${bin >= DAY ? "day" : "interval"}, ${stamp(win.from, l, ref)} to ${stamp(win.to, l, ref)}`,
						)}
					>
						{bins.map((b, i) =>
							b.n ? (
								// biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut; the list below carries every item and the range buttons are the keyboard path.
								<rect
									key={b.at}
									x={i * barW + barW * 0.12}
									width={barW * 0.76}
									y={24 - Math.max(1.5, (b.n / max) * 22)}
									height={Math.max(1.5, (b.n / max) * 22)}
									class={`tl__bar${focus && focus.from === b.at ? " is-on" : ""}`}
									onClick={() =>
										setFocus(focus && focus.from === b.at ? null : { from: b.at, to: b.at + bin })
									}
								>
									<title>{`${stamp(b.at, l, ref)} · ${int(b.n, l)}`}</title>
								</rect>
							) : null,
						)}
					</svg>
					<div class="tl__axis mono" aria-hidden="true">
						<span>{stamp(win.from, l, ref)}</span>
						<span>{t(`hasta ${stamp(win.to, l, ref)}`, `to ${stamp(win.to, l, ref)}`)}</span>
					</div>
				</div>
			) : null}
			{focus ? (
				<p class="tl__focus">
					{t("Solo", "Only")}{" "}
					{bin >= DAY ? dayTitle[l].format(focus.from) : `${stamp(focus.from, l, ref)}–${clock(focus.to, l)}`}
					<button type="button" class="link-button" onClick={() => setFocus(null)}>
						{t("ver todo el rango", "show the whole range")}
					</button>
				</p>
			) : null}
			{status === "loading" ? (
				<p class="esec__empty" aria-busy="true">
					{t("Cargando la cronología…", "Loading the timeline…")}
				</p>
			) : status === "error" ? (
				<p class="esec__empty">
					{t("No se pudo cargar la cronología.", "Could not load the timeline.")}{" "}
					<button type="button" class="link-button" onClick={() => setNonce((n) => n + 1)}>
						{t("Reintentar", "Retry")}
					</button>
				</p>
			) : !items.length && exhausted ? (
				<p class="esec__empty">
					{t("Nada vinculado en el archivo de este Vigía.", "Nothing linked in this Vigía's archive.")}
				</p>
			) : (
				<ol class="tl__days">
					{!items.length ? (
						<li class="esec__empty">
							{t(
								`Nada vinculado en ${RANGES[range].es} en el archivo de este Vigía.`,
								`Nothing linked in ${RANGES[range].en} in this Vigía's archive.`,
							)}
						</li>
					) : null}
					{groups.map((g) => (
						<li key={g.day} class="tl__day">
							<h3 class="tl__date">{dayTitle[l].format(g.at)}</h3>
							<ol class="tl__items">
								{g.items.map((it) => (
									<Row key={`${it.kind}|${it.url}|${it.at}`} it={it} />
								))}
							</ol>
						</li>
					))}
					<li ref={tail} class="tl__more">
						{exhausted && left <= 0 ? (
							<p class="esec__note">
								{t(
									`Nada más vinculado en el archivo antes del ${stamp(win.from, l, ref)}.`,
									`Nothing more linked in the archive before ${stamp(win.from, l, ref)}.`,
								)}
							</p>
						) : (
							<button type="button" class="btn btn--quiet" onClick={showMore} disabled={more === "loading"}>
								{more === "loading"
									? t("Cargando…", "Loading…")
									: left > 0
										? t(`Ver ${Math.min(MORE_ROWS, left)} más`, `Show ${Math.min(MORE_ROWS, left)} more`)
										: truncated
											? t("Cargar anteriores", "Load older")
											: t(
													`Buscar antes del ${stamp(win.from, l, ref)}`,
													`Look before ${stamp(win.from, l, ref)}`,
												)}
							</button>
						)}
					</li>
				</ol>
			)}
			{backlog > 0 ? (
				<p class="esec__note">
					{t(
						`El índice de vínculos todavía está leyendo ${int(backlog, l)} observaciones archivadas: la cronología puede estar incompleta.`,
						`The link index is still reading ${int(backlog, l)} archived observations: the timeline may be incomplete.`,
					)}
				</p>
			) : null}
			{rules.length ? (
				<details class="tl__rules">
					<summary>{t("Cómo se vincula cada hecho", "How each event is linked")}</summary>
					<ul>
						{rules.map((r) => (
							<li key={r}>{r}</li>
						))}
					</ul>
				</details>
			) : null}
		</section>
	);
}

function Row({ it }: { it: TimelineItem }) {
	const l = lang.value;
	const k = KIND[it.kind];
	const rule = RULE[it.rule]?.[l];
	const internal = it.url.startsWith("/api/v1/entities/") ? it.url.slice("/api/v1/entities/".length) : null;
	const external = /^https?:\/\//.test(it.url);
	const title = external ? (
		<a class="item__title" href={it.url} target="_blank" rel="noopener noreferrer">
			{it.title[l]}
		</a>
	) : internal ? (
		<button type="button" class="item__title item__title--button" onClick={() => openEntity(internal)}>
			{it.title[l]}
		</button>
	) : (
		<span class="item__title">{it.title[l]}</span>
	);
	return (
		<li class="item tl__item">
			<time class="item__time mono" dateTime={new Date(it.at).toISOString()} title={stamp(it.at, l)}>
				{clock(it.at, l)}
			</time>
			<span class="item__body">
				<span class="tl__kind">
					<span class={`tl-shape tl-shape--${k?.shape ?? "solid"}`} aria-hidden="true" />
					{k?.[l] ?? it.kind}
				</span>
				{title}
				<span class="item__meta">
					{it.rule === "text-place" ? <span class="keyword">{t("palabra clave", "keyword")}</span> : null}
					{[it.source.name, it.rule === "text-place" ? null : rule, ...figureWords(it)]
						.filter(Boolean)
						.join(" · ")}
				</span>
			</span>
		</li>
	);
}
