import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { healthById, meta, metaById, now, panels } from "../lib/data.ts";
import { ago, int, num } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import {
	cleanView,
	helpOpen,
	jumpTo,
	mapAction,
	PANEL_KEYS,
	paletteOpen,
	panelKeyOrder,
	setCleanView,
	takeTypedAhead,
	toggleLang,
	toggleTheme,
} from "../lib/keys.ts";
import { prepare, rank, type Searchable, score } from "../lib/match.ts";
import { PLACES } from "../lib/places.gen.ts";
import { reducedMotion, setReducedMotion, theme } from "../lib/prefs.ts";
import { go } from "../lib/router.ts";
import { levelLabel } from "../map/fills.ts";
import { STATES } from "../map/geometry.gen.ts";
import type { ConnectivityView, Level } from "../panels/Connectivity.tsx";
import type { FiresView } from "../panels/Earth.tsx";
import { type Shading, selectedState, shading, showQuakes } from "../panels/MapPanel.tsx";
import type { MoneyView } from "../panels/Money.tsx";
import type { NewsView } from "../panels/News.tsx";
import type { QuakesView } from "../panels/Quakes.tsx";
import paletteCss from "../styles/palette.css?inline";
import panelsCss from "../styles/panels.css?inline";
import { SearchIcon } from "./Palette.tsx";
import { openSource, stateLabel } from "./Source.tsx";

addStyles(panelsCss);
addStyles(paletteCss);

/**
 * The command palette's search (loaded on first use or when the page is idle; ui/Palette.tsx is the shell): states, municipalities and cities, panels, map
 * layers, sources and commands, searched on the device from data the page already has. Each result shows its live
 * figure and that figure's age, so "maracaibo" answers "Zulia · Normal · hace 18 min" before you press Enter.
 */

type Group = "states" | "places" | "panels" | "layers" | "sources" | "commands";
const GROUP_ORDER: readonly Group[] = ["states", "places", "panels", "layers", "commands", "sources"];
const GROUP_LABEL: Record<Group, { es: string; en: string }> = {
	states: { es: "Estados", en: "States" },
	places: { es: "Municipios y ciudades", en: "Municipalities and cities" },
	panels: { es: "Paneles", en: "Panels" },
	layers: { es: "Capas del mapa", en: "Map layers" },
	sources: { es: "Fuentes", en: "Sources" },
	commands: { es: "Comandos", en: "Commands" },
};
const LIMIT: Record<Group, number> = { states: 5, places: 6, panels: 4, layers: 3, sources: 5, commands: 4 };

interface Item extends Searchable {
	id: string;
	group: Group;
	sub?: string;
	/** Left marker class (a feed's health). */
	dot?: string;
	/** The state a state or place result belongs to: its marker shows that state's connectivity level. */
	iso?: string;
	/** Right side, computed at render so it is live: the figure and its age. */
	live?: () => { figure: string | null; age: string | null };
	/** Keyboard hint on the right for commands. */
	kbd?: string;
	run: () => void;
}

const isoByCode = new Map(STATES.map((s) => [s.code, s.iso]));
const nameByIso = new Map(STATES.map((s) => [s.iso, s.name]));

/** The age of a feed in the panel-badge sense: newest datum for data feeds, last check for event feeds. */
function feedAge(id: string | undefined): string | null {
	if (!id) return null;
	const h = healthById.value.get(id);
	const m = metaById.value.get(id);
	if (h?.state === "locked") return t("necesita clave", "needs a key");
	if (!h?.lastSuccessAt) return null;
	const future = h.newestObservedAt !== null && h.newestObservedAt > now.value;
	const eventFeed = m?.freshness.dataMs === null || future;
	const at = eventFeed ? h.lastSuccessAt : (h.newestObservedAt ?? h.lastSuccessAt);
	const age = ago(now.value - at, lang.value);
	return eventFeed ? t(`revisado ${age}`, `checked ${age}`) : age;
}

function stateLive(iso: string): { figure: string | null; age: string | null; level: Level | null } {
	const conn = panels.value.connectivity as ConnectivityView | undefined;
	const place = conn?.states.find((s) => s.id === iso);
	if (!place) return { figure: null, age: null, level: null };
	const worst = place.signals
		.map((s) => s.pctOfBaseline)
		.filter((p): p is number => p !== null)
		.sort((a, b) => a - b)[0];
	const pct = worst === undefined ? "" : ` · ${num(worst, 0, lang.value)} %`;
	return {
		figure: `Internet: ${levelLabel(place.level).toLowerCase()}${place.level === "no-data" ? "" : pct}`,
		age: place.lastBinAt ? ago(now.value - place.lastBinAt, lang.value) : null,
		level: place.level,
	};
}

const PANEL_FEED: Record<string, string> = {
	mapa: "ioda-states",
	dinero: "bcv-official",
	conectividad: "ioda-states",
	sismos: "usgs-quakes",
	clima: "open-meteo-weather",
	luces: "gibs-nightlights",
	incendios: "firms-fires",
	censura: "ooni-ve",
	alertas: "gdacs-events",
	satelite: "goes-nsa",
	petroleo: "fred-oil",
};
const PANEL_WORDS: Record<string, string[]> = {
	mapa: ["venezuela", "estados", "map"],
	dinero: ["dolar", "bcv", "yadio", "tasa", "euro", "inflacion", "p2p", "dollar", "rate"],
	conectividad: ["internet", "conexion", "caidas", "ioda", "cantv", "operadoras"],
	noticias: ["titulares", "medios", "prensa", "news"],
	sismos: ["temblor", "terremoto", "funvisis", "usgs", "earthquakes"],
	clima: ["tiempo", "lluvia", "tormentas", "weather"],
	luces: ["luz", "apagon", "noche", "nightlights", "lights"],
	incendios: ["fuego", "focos de calor", "firms", "fires"],
	censura: ["bloqueos", "ooni", "ve sin filtro", "censorship"],
	alertas: ["gdacs", "ciclones", "huracan", "alerts"],
	satelite: ["goes", "nubes", "imagen", "satellite"],
	petroleo: ["brent", "wti", "crudo", "oil"],
	bolsillo: ["convertir", "calculadora", "sueldo", "salario", "bolivares", "converter", "wage"],
	servicios: ["luz", "guri", "agua", "gas", "gasolina", "racionamiento", "corpoelec", "power", "water"],
	gaceta: ["gaceta oficial", "decreto", "ley", "resolucion", "gazette", "decree"],
};
const EXTRA_PANELS = [
	{ id: "alertas", es: "Alertas", en: "Alerts" },
	{ id: "satelite", es: "Satélite", en: "Satellite" },
	{ id: "petroleo", es: "Petróleo", en: "Oil" },
];

function panelFigure(id: string): string | null {
	const p = panels.value;
	const l = lang.value;
	switch (id) {
		case "dinero": {
			const usd = (p.money as MoneyView | undefined)?.official.usd.current;
			return usd ? `BCV ${num(usd.vesPerUnit, 2, l)} Bs` : null;
		}
		case "conectividad":
			return (p.connectivity as ConnectivityView | undefined)?.summary.text ?? null;
		case "noticias": {
			const n = p.news as NewsView | undefined;
			return n
				? t(`${int(n.items24h, l)} titulares en 24 h`, `${int(n.items24h, l)} headlines in 24 h`)
				: null;
		}
		case "sismos": {
			const q = p.quakes as QuakesView | undefined;
			return q ? t(`${int(q.counts.day, l)} en 24 h`, `${int(q.counts.day, l)} in 24 h`) : null;
		}
		case "incendios": {
			const f = p.fires as FiresView | undefined;
			return f
				? t(
						`${int(f.venezuela.last24h - f.venezuela.persistent24h, l)} focos en 24 h`,
						`${int(f.venezuela.last24h - f.venezuela.persistent24h, l)} heat spots in 24 h`,
					)
				: null;
		}
		case "censura": {
			const c = p.censorship as { vsf?: { sitesBlocked: number } | null } | undefined;
			return c?.vsf
				? t(`${int(c.vsf.sitesBlocked, l)} sitios bloqueados`, `${int(c.vsf.sitesBlocked, l)} sites blocked`)
				: null;
		}
		default:
			return null;
	}
}

const LAYER_ITEMS: readonly { id: Shading; es: string; en: string; feed: string; words: string[] }[] = [
	{
		id: "connectivity",
		es: "Internet por estado",
		en: "Internet by state",
		feed: "ioda-states",
		words: ["ioda", "conexion"],
	},
	{
		id: "nightlights",
		es: "Luces nocturnas",
		en: "Night lights",
		feed: "gibs-nightlights",
		words: ["luz", "apagon", "noche"],
	},
	{ id: "satellite", es: "Satélite", en: "Satellite", feed: "goes-nsa", words: ["goes", "nubes"] },
	{ id: "reports", es: "Titulares por estado", en: "Headlines by state", feed: "", words: ["noticias"] },
	{
		id: "fires",
		es: "Focos de calor",
		en: "Heat spots",
		feed: "firms-fires",
		words: ["incendios", "fuego", "firms"],
	},
];

let placeCache: { code: string; name: string; kind: "M" | "C" }[] | null = null;
function places() {
	placeCache ??= PLACES.split("|").map((r) => ({
		kind: r[0] === "C" ? ("C" as const) : ("M" as const),
		code: `VE${r.slice(1, 5)}`,
		name: r.slice(5),
	}));
	return placeCache;
}

/** The whole index, rebuilt when the palette opens (cheap: ~600 entries) so labels follow the language. */
function buildIndex(close: () => void): ReturnType<typeof prepare<Item>>[] {
	const l = lang.value;
	const items: Item[] = [];
	const then = (fn: () => void) => () => {
		close();
		fn();
	};

	for (const s of STATES) {
		items.push({
			id: `state:${s.iso}`,
			group: "states",
			label: s.name,
			keywords: [s.iso, "estado"],
			iso: s.iso,
			live: () => stateLive(s.iso),
			run: then(() => {
				selectedState.value = s.iso;
				jumpTo("mapa");
			}),
		});
	}
	for (const p of places()) {
		const iso = isoByCode.get(p.code.slice(0, 4));
		if (!iso) continue;
		const stateLabel = nameByIso.get(iso) ?? "";
		items.push({
			id: `place:${p.kind}:${p.code}:${p.name}`,
			group: "places",
			label: p.name,
			sub: `${p.kind === "M" ? t("municipio", "municipality") : t("ciudad", "city")} · ${stateLabel}`,
			keywords: [stateLabel],
			iso,
			live: () => stateLive(iso),
			run: then(() => {
				mapAction({ action: "municipality", code: p.code, state: iso });
				jumpTo("mapa");
			}),
		});
	}
	const keyOrder = panelKeyOrder();
	for (const p of [...PANEL_KEYS, ...EXTRA_PANELS]) {
		const i = keyOrder.indexOf(p.id);
		items.push({
			id: `panel:${p.id}`,
			group: "panels",
			label: p[l],
			keywords: [p.es, p.en, ...(PANEL_WORDS[p.id] ?? [])],
			live: () => ({ figure: panelFigure(p.id), age: feedAge(PANEL_FEED[p.id]) }),
			...(i >= 0 ? { kbd: String(i + 1) } : {}),
			run: then(() => jumpTo(p.id)),
		});
	}
	const aiOn = ((panels.value.ai as { backend?: string } | undefined)?.backend ?? "off") !== "off";
	for (const layer of [
		...LAYER_ITEMS,
		...(aiOn
			? [
					{
						id: "aiBlackouts" as const,
						es: "Apagones · IA",
						en: "Blackouts · AI",
						feed: "",
						words: ["ia", "apagon"],
					},
				]
			: []),
	]) {
		items.push({
			id: `layer:${layer.id}`,
			group: "layers",
			label: layer[l],
			keywords: ["capa", "mapa", "layer", ...layer.words],
			live: () => ({
				figure: shading.value === layer.id ? t("activa", "on") : null,
				age: feedAge(layer.feed || undefined),
			}),
			run: then(() => {
				mapAction({ action: "layer", layer: layer.id });
				jumpTo("mapa");
			}),
		});
	}
	items.push({
		id: "layer:quakes",
		group: "layers",
		label: t("Sismos en el mapa", "Quakes on the map"),
		keywords: ["capa", "sismos", "temblor", "layer"],
		kbd: "Q",
		live: () => ({ figure: showQuakes.value ? t("visibles", "shown") : t("ocultos", "hidden"), age: null }),
		run: then(() => mapAction({ action: "toggle-quakes" })),
	});

	const dark =
		theme.value === "dark" ||
		(theme.value === "system" && !matchMedia("(prefers-color-scheme: light)").matches);
	const command = (id: string, label: string, keywords: string[], run: () => void, kbd?: string) =>
		items.push({
			id: `cmd:${id}`,
			group: "commands",
			label,
			keywords,
			run: then(run),
			...(kbd ? { kbd } : {}),
		});
	command(
		"theme",
		dark ? t("Tema claro", "Light theme") : t("Tema oscuro", "Dark theme"),
		["tema", "theme", "claro", "oscuro"],
		toggleTheme,
		"T",
	);
	command(
		"lang",
		l === "es" ? "English" : "Español",
		["idioma", "language", "ingles", "espanol"],
		toggleLang,
		"E",
	);
	command(
		"share",
		t("Compartir imagen del mapa", "Share an image of the map"),
		["compartir", "share", "imagen", "whatsapp"],
		() => mapAction({ action: "share" }),
		"S",
	);
	command(
		"clean",
		t("Vista limpia para capturas", "Clean view for screenshots"),
		["captura", "screenshot", "limpia"],
		() => setCleanView(!cleanView.value),
		"V",
	);
	command("status", t("Estado de las fuentes", "Feed status"), ["estado", "salud", "health", "status"], () =>
		go("status"),
	);
	command("brief", t("Resumen del día", "Daily brief"), ["resumen", "brief"], () => go("brief"));
	command("guide", t("Configurar claves", "Set up keys"), ["guia", "claves", "keys", "setup"], () =>
		go("guide"),
	);
	command(
		"keys",
		t("Atajos de teclado", "Keyboard shortcuts"),
		["atajos", "teclado", "shortcuts", "ayuda"],
		() => (helpOpen.value = true),
		"?",
	);
	command(
		"motion",
		reducedMotion.value
			? t("Activar animaciones", "Turn animations on")
			: t("Reducir animaciones", "Reduce motion"),
		["animaciones", "motion", "movimiento"],
		() => setReducedMotion(!reducedMotion.value),
	);
	if (selectedState.value)
		command(
			"clear",
			t("Quitar selección del mapa", "Clear the map selection"),
			["quitar", "clear"],
			() => (selectedState.value = null),
			"Esc",
		);

	for (const m of meta.value) {
		items.push({
			id: `source:${m.id}`,
			group: "sources",
			label: m.name[l],
			...(m.provider !== m.name[l] ? { sub: m.provider } : {}),
			keywords: [m.id, m.provider, m.name.es, m.name.en],
			dot: `dot dot--${healthById.value.get(m.id)?.state ?? "pending"}`,
			live: () => {
				const h = healthById.value.get(m.id);
				return { figure: h ? stateLabel(h.state) : null, age: feedAge(m.id) };
			},
			run: then(() => {
				const h = healthById.value.get(m.id);
				openSource.value = {
					feed: m.id,
					observedAt: h?.newestObservedAt ?? h?.lastSuccessAt ?? now.value,
					url: m.homepage,
				};
			}),
		});
	}
	return items.map(prepare);
}

/** What to show before anything is typed: states that need attention, then panels, then commands. */
function suggestions(index: ReturnType<typeof prepare<Item>>[]): { group: Group; items: Item[] }[] {
	const conn = panels.value.connectivity as ConnectivityView | undefined;
	const hot = new Set(
		(conn?.states ?? [])
			.filter((s) => s.level === "drop" || s.level === "severe")
			.map((s) => `state:${s.id}`),
	);
	const out: { group: Group; items: Item[] }[] = [];
	const states = index.filter((i) => hot.has(i.id));
	if (states.length) out.push({ group: "states", items: states });
	out.push({ group: "panels", items: index.filter((i) => i.group === "panels") });
	out.push({ group: "commands", items: index.filter((i) => i.group === "commands").slice(0, 4) });
	return out;
}

function search(index: ReturnType<typeof prepare<Item>>[], q: string): { group: Group; items: Item[] }[] {
	const groups: { group: Group; items: Item[]; best: number }[] = [];
	for (const g of GROUP_ORDER) {
		const hits = rank(
			index.filter((i) => i.group === g),
			q,
			LIMIT[g],
		);
		if (!hits.length) continue;
		// Groups are ordered by how well their best hit matches, then by the fixed order.
		const best = Math.min(...hits.map((h) => score(h.folded, q) ?? 99));
		groups.push({ group: g, items: hits, best });
	}
	return groups.sort(
		(a, b) => a.best - b.best || GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
	);
}

export default function PaletteDialog() {
	const ref = useRef<HTMLDialogElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const [q, setQ] = useState("");
	const [active, setActive] = useState(0);
	const open = paletteOpen.value;
	const close = () => {
		paletteOpen.value = false;
	};
	// Rebuilt per opening and language: labels follow the language, live figures are read at render.
	const index = useMemo(() => (open ? buildIndex(close) : []), [open, lang.value]);

	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (open && !d.open) {
			setQ(takeTypedAhead());
			setActive(0);
			d.showModal();
			input.current?.focus();
		}
		if (!open && d.open) d.close();
	}, [open]);

	const groups = open ? (q.trim() ? search(index, q) : suggestions(index)) : [];
	const flat = groups.flatMap((g) => g.items);
	const current = Math.min(active, Math.max(0, flat.length - 1));

	useEffect(() => {
		list.current?.querySelector<HTMLElement>(`#pal-${current}`)?.scrollIntoView({ block: "nearest" });
	}, [current, q]);

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const n = flat.length;
			if (n) setActive((current + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
		} else if (e.key === "Enter") {
			e.preventDefault();
			flat[current]?.run();
		} else if (e.key === "Home" && e.ctrlKey) {
			setActive(0);
		}
	};

	let n = -1;
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Escape closes the dialog natively.
		<dialog
			ref={ref}
			class="palette"
			aria-label={t("Buscar en Vigía", "Search Vigía")}
			onClose={close}
			onClick={(e) => {
				if (e.target === ref.current) close();
			}}
		>
			{open ? (
				<div class="palette__inner">
					<div class="palette__field">
						<SearchIcon />
						<input
							ref={input}
							class="palette__input"
							type="text"
							role="combobox"
							aria-expanded="true"
							aria-controls="palette-list"
							aria-autocomplete="list"
							aria-activedescendant={flat.length ? `pal-${current}` : undefined}
							autocomplete="off"
							autocapitalize="off"
							spellcheck={false}
							placeholder={t("Estado, municipio, panel, fuente…", "State, place, panel, source…")}
							value={q}
							onInput={(e) => {
								setQ(e.currentTarget.value);
								setActive(0);
							}}
							onKeyDown={onKeyDown}
						/>
						<button type="button" class="palette__esc" onClick={close} aria-label={t("Cerrar", "Close")}>
							Esc
						</button>
					</div>
					<div
						class="palette__list"
						id="palette-list"
						role="listbox"
						ref={list}
						aria-label={t("Resultados", "Results")}
					>
						{flat.length === 0 ? (
							<p class="palette__empty">
								{t(`Nada para “${q}”.`, `Nothing for “${q}”.`)}{" "}
								{t("Prueba un estado, una ciudad o “dólar”.", "Try a state, a city or “dollar”.")}
							</p>
						) : (
							groups.map((g) => (
								// biome-ignore lint/a11y/useSemanticElements: a listbox group, not a form fieldset.
								<div role="group" aria-labelledby={`palg-${g.group}`} key={g.group} class="palette__group">
									<p class="palette__group-label caps" id={`palg-${g.group}`}>
										{GROUP_LABEL[g.group][lang.value]}
									</p>
									{g.items.map((item) => {
										n++;
										const i = n;
										const live = item.live?.();
										const dot = item.iso
											? `level-dot level-dot--${stateLive(item.iso).level ?? "no-data"}`
											: item.dot;
										return (
											// biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useKeyWithClickEvents: combobox pattern; focus stays in the input, which handles ↑↓ and Enter via aria-activedescendant.
											<div
												key={item.id}
												id={`pal-${i}`}
												role="option"
												aria-selected={i === current}
												class={`palette__item${i === current ? " is-active" : ""}`}
												onMouseMove={() => i !== current && setActive(i)}
												onClick={() => item.run()}
											>
												<span class={`palette__dot ${dot ?? ""}`} aria-hidden="true" />
												<span class="palette__label">
													<span class="palette__name">{item.label}</span>
													{item.sub ? <span class="palette__sub">{item.sub}</span> : null}
												</span>
												<span class="palette__live">
													{live?.figure ? <span class="palette__figure">{live.figure}</span> : null}
													{live?.age ? <span class="palette__age">{live.age}</span> : null}
													{item.kbd ? <kbd>{item.kbd}</kbd> : null}
												</span>
											</div>
										);
									})}
								</div>
							))
						)}
					</div>
					<p class="palette__foot">
						<span>
							<kbd>↑</kbd>
							<kbd>↓</kbd> {t("elegir", "move")} · <kbd>↵</kbd> {t("abrir", "open")} · <kbd>Esc</kbd>{" "}
							{t("cerrar", "close")}
						</span>
						<span>{t("Lugares: INE/OCHA, GeoNames", "Places: INE/OCHA, GeoNames")}</span>
					</p>
				</div>
			) : null}
		</dialog>
	);
}
