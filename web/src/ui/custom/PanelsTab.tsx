import { lang, t } from "../../lib/i18n.ts";
import { hidePanel, layout, movePanel, type PanelId, showPanel } from "../../lib/layout.ts";
import {
	MAP_LAYERS,
	type MapLayer,
	MONEY_BLOCKS,
	type MoneyBlock,
	panelPrefs,
	REACHES,
	type Reach,
	resetPanelPrefs,
	STANCES,
	type StanceId,
	setPanelPrefs,
} from "../../lib/panelprefs.ts";
import { panelName } from "../../lib/summary.ts";
import { STATES } from "../../map/geometry.gen.ts";

const STANCE_LABEL: Record<StanceId, { es: string; en: string }> = {
	independent: { es: "Independientes", en: "Independent" },
	commercial: { es: "Privados", en: "Private" },
	state: { es: "Estatales", en: "State" },
	"state-aligned": { es: "Afines al gobierno", en: "Government-aligned" },
	"state-funded": { es: "Financiados por un Estado", en: "State-funded" },
	"public-broadcaster": { es: "Servicio público", en: "Public broadcasters" },
	ngo: { es: "ONG", en: "NGOs" },
	partisan: { es: "Partidistas", en: "Partisan" },
	agency: { es: "Agencias", en: "Agencies" },
	aggregator: { es: "Agregadores", en: "Aggregators" },
	multilateral: { es: "Organismos multilaterales", en: "Multilateral bodies" },
	"trade-body": { es: "Gremios", en: "Trade bodies" },
};

const REACH_LABEL: Record<Reach, { es: string; en: string }> = {
	national: { es: "Nacionales", en: "National" },
	regional: { es: "Regionales", en: "Regional" },
	international: { es: "Internacionales", en: "International" },
	diaspora: { es: "Diáspora", en: "Diaspora" },
};

const MONEY_LABEL: Record<MoneyBlock, { es: string; en: string }> = {
	yadio: { es: "Yadio (índice P2P)", en: "Yadio (P2P index)" },
	p2p: { es: "Mercados P2P (si están activos)", en: "P2P markets (when on)" },
	chart: { es: "Gráfico de 90 días", en: "90-day chart" },
	inflation: { es: "Inflación (BCV)", en: "Inflation (BCV)" },
};

const LAYER_LABEL: Record<MapLayer, { es: string; en: string }> = {
	connectivity: { es: "Internet", en: "Internet" },
	nightlights: { es: "Luces nocturnas", en: "Night lights" },
	satellite: { es: "Satélite", en: "Satellite" },
	reports: { es: "Titulares", en: "Headlines" },
	fires: { es: "Incendios", en: "Fires" },
};

const toggle = <T,>(list: readonly T[], item: T): T[] =>
	list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

function Visibility() {
	const l = layout.value;
	return (
		<section aria-labelledby="vis-h">
			<h3 id="vis-h" class="custom-h">
				{t("Qué paneles ver", "Which panels to show")}
			</h3>
			<p class="note custom-lead">
				{t(
					"El orden sirve para la lista del teléfono y para cada columna del escritorio. También puedes moverlos desde el menú ⋯ de cada panel.",
					"The order applies to the phone list and to each desktop column. You can also move them from each panel's ⋯ menu.",
				)}
			</p>
			<ol class="panel-order">
				{l.order.map((id: PanelId) => {
					const hidden = l.hidden.includes(id);
					return (
						<li key={id} class={hidden ? "is-hidden" : ""}>
							<label class="panel-order__name">
								<input
									type="checkbox"
									checked={!hidden}
									onChange={() => (hidden ? showPanel(id) : hidePanel(id))}
								/>{" "}
								{panelName(id)}
							</label>
							<span class="panel-order__move">
								<button
									type="button"
									class="icon-button"
									disabled={hidden}
									aria-label={t(`Subir ${panelName(id)}`, `Move ${panelName(id)} up`)}
									onClick={() => movePanel(id, -1)}
								>
									↑
								</button>
								<button
									type="button"
									class="icon-button"
									disabled={hidden}
									aria-label={t(`Bajar ${panelName(id)}`, `Move ${panelName(id)} down`)}
									onClick={() => movePanel(id, 1)}
								>
									↓
								</button>
							</span>
						</li>
					);
				})}
			</ol>
		</section>
	);
}

function NewsSettings() {
	const lg = lang.value;
	const p = panelPrefs.value;
	const n = p.news;
	const set = (news: typeof n) => setPanelPrefs({ ...p, news });
	const changed = n.hiddenStances.length || n.hiddenReaches.length || n.states.length;
	return (
		<section aria-labelledby="news-h" class="custom-card">
			<header class="custom-card__head">
				<h3 id="news-h" class="custom-h">
					{t("Noticias", "News")}
				</h3>
				<button type="button" class="link-button" disabled={!changed} onClick={() => resetPanelPrefs("news")}>
					{t("Restablecer", "Reset")}
				</button>
			</header>
			<fieldset class="chip-set">
				<legend>{t("Tipos de medio", "Kinds of outlet")}</legend>
				{STANCES.map((s) => {
					const on = !n.hiddenStances.includes(s);
					return (
						<button
							type="button"
							key={s}
							class={`filter-chip${on ? " is-on" : ""}`}
							aria-pressed={on}
							onClick={() => set({ ...n, hiddenStances: toggle(n.hiddenStances, s) })}
						>
							{STANCE_LABEL[s][lg]}
						</button>
					);
				})}
			</fieldset>
			<fieldset class="chip-set">
				<legend>{t("Alcance", "Reach")}</legend>
				{REACHES.map((r) => {
					const on = !n.hiddenReaches.includes(r);
					return (
						<button
							type="button"
							key={r}
							class={`filter-chip${on ? " is-on" : ""}`}
							aria-pressed={on}
							onClick={() => set({ ...n, hiddenReaches: toggle(n.hiddenReaches, r) })}
						>
							{REACH_LABEL[r][lg]}
						</button>
					);
				})}
			</fieldset>
			<fieldset class="chip-set">
				<legend>
					{t("Solo estos estados", "Only these states")}{" "}
					<span class="note">
						{n.states.length ? "" : t("(ninguno elegido: todo el país)", "(none chosen: the whole country)")}
					</span>
				</legend>
				{[...STATES]
					.sort((a, b) => a.name.localeCompare(b.name, "es"))
					.map((s) => {
						const on = n.states.includes(s.iso);
						return (
							<button
								type="button"
								key={s.iso}
								class={`filter-chip${on ? " is-on" : ""}`}
								aria-pressed={on}
								onClick={() => set({ ...n, states: toggle(n.states, s.iso) })}
							>
								{s.name}
							</button>
						);
					})}
			</fieldset>
			<p class="note">
				{t(
					"Una historia aparece si al menos uno de sus medios pasa el filtro. Los totales del panel siguen contando todo, y el panel avisa que está filtrado.",
					"A story shows if at least one of its outlets passes the filter. The panel's totals still count everything, and the panel says it is filtered.",
				)}
			</p>
		</section>
	);
}

function MoneySettings() {
	const lg = lang.value;
	const p = panelPrefs.value;
	const hidden = p.money.hidden;
	return (
		<section aria-labelledby="money-h" class="custom-card">
			<header class="custom-card__head">
				<h3 id="money-h" class="custom-h">
					{t("Dólar", "Dollar")}
				</h3>
				<button
					type="button"
					class="link-button"
					disabled={!hidden.length}
					onClick={() => resetPanelPrefs("money")}
				>
					{t("Restablecer", "Reset")}
				</button>
			</header>
			<label class="toggle">
				<input type="checkbox" checked disabled />{" "}
				{t(
					"Tasa oficial del BCV (siempre: es la referencia)",
					"BCV official rate (always: it is the reference)",
				)}
			</label>
			{MONEY_BLOCKS.map((b) => (
				<label class="toggle" key={b}>
					<input
						type="checkbox"
						checked={!hidden.includes(b)}
						onChange={() => setPanelPrefs({ ...p, money: { hidden: toggle(hidden, b) } })}
					/>{" "}
					{MONEY_LABEL[b][lg]}
				</label>
			))}
		</section>
	);
}

function MapSettings() {
	const lg = lang.value;
	const p = panelPrefs.value;
	const m = p.map;
	return (
		<section aria-labelledby="map-h" class="custom-card">
			<header class="custom-card__head">
				<h3 id="map-h" class="custom-h">
					{t("Mapa al abrir", "Map on open")}
				</h3>
				<button
					type="button"
					class="link-button"
					disabled={m.layer === null && m.quakes === null}
					onClick={() => resetPanelPrefs("map")}
				>
					{t("Restablecer", "Reset")}
				</button>
			</header>
			<fieldset class="radio-set">
				<legend>{t("Capa", "Layer")}</legend>
				{MAP_LAYERS.map((layer) => (
					<label key={layer} class="toggle">
						<input
							type="radio"
							name="map-layer"
							checked={(m.layer ?? "connectivity") === layer}
							onChange={() =>
								setPanelPrefs({ ...p, map: { ...m, layer: layer === "connectivity" ? null : layer } })
							}
						/>{" "}
						{LAYER_LABEL[layer][lg]}
					</label>
				))}
			</fieldset>
			<label class="toggle">
				<input
					type="checkbox"
					checked={m.quakes ?? true}
					onChange={() => setPanelPrefs({ ...p, map: { ...m, quakes: (m.quakes ?? true) ? false : null } })}
				/>{" "}
				{t("Mostrar sismos", "Show earthquakes")}
			</label>
			<p class="note">
				{t(
					"Se aplica la próxima vez que abras Vigía. Un enlace compartido que ya trae su capa manda sobre esto.",
					"Applies the next time you open Vigía. A shared link that carries its own layer wins over this.",
				)}
			</p>
		</section>
	);
}

export function PanelsTab() {
	return (
		<div class="custom-tab">
			<Visibility />
			<section class="custom-tab__group">
				<h3 class="custom-h custom-h--section">{t("Ajustes de cada panel", "Each panel's settings")}</h3>
				<p class="note custom-lead">
					{t(
						"Eligen qué muestra cada panel en este dispositivo; no cambian cómo se calcula ninguna cifra.",
						"They choose what each panel shows on this device; they never change how a figure is computed.",
					)}
				</p>
			</section>
			<div class="custom-cards">
				<NewsSettings />
				<MoneySettings />
				<MapSettings />
			</div>
		</div>
	);
}
