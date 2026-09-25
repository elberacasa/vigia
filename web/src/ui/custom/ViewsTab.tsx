import { signal } from "@preact/signals";
import { useState } from "preact/hooks";
import { now } from "../../lib/data.ts";
import { stamp } from "../../lib/format.ts";
import { lang, t } from "../../lib/i18n.ts";
import { layout, PANEL_IDS, replaceLayout, resetLayout } from "../../lib/layout.ts";
import { panelPrefs, resetPanelPrefs, setPanelPrefs } from "../../lib/panelprefs.ts";
import { density, setDensity } from "../../lib/prefs.ts";
import { stateName } from "../../lib/states.ts";
import {
	exportViewsFile,
	mergeViews,
	newViewId,
	PRESETS,
	type Preset,
	parseViewsFile,
	presetLayout,
	repairViews,
	type SavedView,
	VIEW_LIMIT,
	type ViewShading,
} from "../../lib/views.ts";
import {
	selectedState,
	selectState,
	setLayer,
	shading,
	showFires,
	showQuakes,
	toggleFires,
	toggleQuakes,
} from "../../map/view.ts";

const KEY = "vigia:views:v1";
const ACTIVE = "vigia:views:active";

function loadViews(): SavedView[] {
	try {
		const raw = localStorage.getItem(KEY);
		return raw ? repairViews(JSON.parse(raw), Date.now()) : [];
	} catch {
		return [];
	}
}
function readActive(): string | null {
	try {
		return localStorage.getItem(ACTIVE);
	} catch {
		return null;
	}
}

const views = signal<SavedView[]>(loadViews());
/** The view or preset applied last on this device (a check mark, not a lock: any change keeps working). */
const active = signal<string | null>(readActive());

function store(next: SavedView[]): boolean {
	views.value = next;
	try {
		localStorage.setItem(KEY, JSON.stringify(next));
		return true;
	} catch {
		return false;
	}
}
function markActive(id: string | null): void {
	active.value = id;
	try {
		if (id) localStorage.setItem(ACTIVE, id);
		else localStorage.removeItem(ACTIVE);
	} catch {
		// ignore
	}
}

const LAYER_NAME: Record<ViewShading, { es: string; en: string }> = {
	connectivity: { es: "Internet", en: "Internet" },
	nightlights: { es: "Luces", en: "Lights" },
	satellite: { es: "Satélite", en: "Satellite" },
	reports: { es: "Titulares", en: "Headlines" },
	fires: { es: "Incendios", en: "Fires" },
	aiBlackouts: { es: "Apagones (IA)", en: "Blackouts (AI)" },
};

function capture(name: string): SavedView {
	return {
		id: newViewId(),
		name,
		savedAt: now.value,
		layout: layout.value,
		map: {
			layer: shading.value,
			quakes: showQuakes.value,
			fires: showFires.value,
			state: selectedState.value,
		},
		density: density.value,
		panelPrefs: panelPrefs.value,
	};
}

function applyView(v: SavedView): void {
	replaceLayout(v.layout);
	setLayer(v.map.layer);
	toggleQuakes(v.map.quakes);
	toggleFires(v.map.fires);
	selectState(v.map.state);
	if (v.density !== density.value) setDensity(v.density);
	if (v.panelPrefs) setPanelPrefs(v.panelPrefs);
	markActive(v.id);
}

function applyPreset(p: Preset): void {
	replaceLayout(presetLayout(p, layout.value));
	setLayer(p.map.layer);
	toggleQuakes(p.map.quakes);
	toggleFires(p.map.fires);
	if (p.density && p.density !== density.value) setDensity(p.density);
	markActive(`preset:${p.id}`);
}

function download(name: string, text: string): void {
	const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

const slug = (s: string) =>
	s
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "") || "vista";

function Mini({ shown }: { shown: readonly string[] }) {
	return (
		<span class="preset__mini" aria-hidden="true">
			<i class="preset__map" />
			{PANEL_IDS.map((id) => (
				<i key={id} class={shown.includes(id) ? "is-on" : ""} />
			))}
		</span>
	);
}

function ViewRow({ v }: { v: SavedView }) {
	const l = lang.value;
	const [renaming, setRenaming] = useState(false);
	const [name, setName] = useState(v.name);
	const shown = v.layout.order.filter((id) => !v.layout.hidden.includes(id));
	const on = active.value === v.id;
	const rename = (e: Event) => {
		e.preventDefault();
		const clean = name.trim().slice(0, 60);
		if (!clean) return;
		store(views.value.map((x) => (x.id === v.id ? { ...x, name: clean } : x)));
		setRenaming(false);
	};
	return (
		<li class={`view-row${on ? " is-active" : ""}`}>
			<Mini shown={shown} />
			<div class="view-row__text">
				{renaming ? (
					<form class="inline-form" onSubmit={rename}>
						<label class="sr-only" for={`rename-${v.id}`}>
							{t("Nuevo nombre", "New name")}
						</label>
						<input
							id={`rename-${v.id}`}
							class="input"
							value={name}
							maxLength={60}
							onInput={(e) => setName((e.target as HTMLInputElement).value)}
						/>
						<button type="submit" class="button button--small">
							{t("Guardar", "Save")}
						</button>
					</form>
				) : (
					<p class="view-row__name">
						{on ? (
							<span class="view-row__check" title={t("aplicada", "applied")}>
								✓{" "}
							</span>
						) : null}
						{v.name}
					</p>
				)}
				<p class="view-row__meta note">
					{t(`${shown.length} paneles`, `${shown.length} panels`)} · {LAYER_NAME[v.map.layer][l]}
					{v.map.state ? ` · ${stateName(v.map.state)}` : ""}
					{v.density !== "comodo"
						? ` · ${v.density === "pared" ? t("pared", "wall") : t("compacto", "compact")}`
						: ""}
					{" · "}
					<span class="data">{stamp(v.savedAt, l)}</span>
				</p>
			</div>
			<div class="view-row__actions">
				<button type="button" class="button button--small button--primary" onClick={() => applyView(v)}>
					{t("Aplicar", "Apply")}
				</button>
				<details class="row-menu">
					<summary
						class="button button--small"
						aria-label={t(`Más acciones: ${v.name}`, `More actions: ${v.name}`)}
					>
						⋯
					</summary>
					<div class="row-menu__list">
						<button type="button" onClick={() => setRenaming(true)}>
							{t("Renombrar", "Rename")}
						</button>
						<button
							type="button"
							onClick={() => {
								store(views.value.map((x) => (x.id === v.id ? { ...capture(x.name), id: x.id } : x)));
								markActive(v.id);
							}}
						>
							{t("Reemplazar con lo que ves ahora", "Replace with what you see now")}
						</button>
						<button
							type="button"
							onClick={() => download(`vigia-vista-${slug(v.name)}.json`, exportViewsFile([v], now.value))}
						>
							{t("Exportar (.json)", "Export (.json)")}
						</button>
						<button
							type="button"
							class="row-menu__danger"
							onClick={() => {
								store(views.value.filter((x) => x.id !== v.id));
								if (active.value === v.id) markActive(null);
							}}
						>
							{t("Borrar", "Delete")}
						</button>
					</div>
				</details>
			</div>
		</li>
	);
}

export function ViewsTab() {
	const l = lang.value;
	const [name, setName] = useState("");
	const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
	const list = views.value;
	const full = list.length >= VIEW_LIMIT;

	const save = (e: Event) => {
		e.preventDefault();
		const clean = name.trim().slice(0, 60);
		if (!clean) return;
		const existing = list.find((v) => v.name.toLowerCase() === clean.toLowerCase());
		const view = { ...capture(clean), ...(existing ? { id: existing.id } : {}) };
		if (!existing && full) {
			setMessage({
				tone: "error",
				text: t(
					`Máximo ${VIEW_LIMIT} vistas: borra una primero.`,
					`At most ${VIEW_LIMIT} views: delete one first.`,
				),
			});
			return;
		}
		const ok = store(existing ? list.map((v) => (v.id === existing.id ? view : v)) : [...list, view]);
		markActive(view.id);
		setName("");
		setMessage(
			ok
				? {
						tone: "ok",
						text: existing
							? t(`«${clean}» actualizada.`, `“${clean}” updated.`)
							: t(`«${clean}» guardada en este dispositivo.`, `“${clean}” saved on this device.`),
					}
				: {
						tone: "error",
						text: t(
							"Este navegador no permite guardar: la vista dura esta visita.",
							"This browser does not allow saving: the view lasts this visit.",
						),
					},
		);
	};

	const importFile = async (e: Event) => {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = "";
		if (!file) return;
		// A views file is a few KB; refuse a large one before reading it.
		const r =
			file.size > 200_000
				? ({
						ok: false,
						reason: { es: "El archivo es demasiado grande.", en: "The file is too large." },
					} as const)
				: parseViewsFile(await file.text(), Date.now());
		if (!r.ok) {
			setMessage({ tone: "error", text: r.reason[l] });
			return;
		}
		const merged = mergeViews(views.value, r.views);
		store(merged);
		const n = r.views.length;
		setMessage({
			tone: "ok",
			text:
				t(
					`${n} ${n === 1 ? "vista importada" : "vistas importadas"}`,
					`${n} ${n === 1 ? "view" : "views"} imported`,
				) +
				(r.skipped ? t(` (${r.skipped} no válidas, ignoradas)`, ` (${r.skipped} invalid, skipped)`) : "") +
				".",
		});
	};

	return (
		<div class="custom-tab">
			<section aria-labelledby="presets-h">
				<h3 id="presets-h" class="custom-h">
					{t("Empezar desde", "Start from")}
				</h3>
				<p class="note custom-lead">
					{t(
						"Cada punto de partida elige paneles, su orden y la capa del mapa. Lo oculto sigue a un toque en «Paneles ocultos».",
						"Each starting point picks panels, their order and the map layer. What it hides stays one tap away under “Hidden panels”.",
					)}
				</p>
				<div class="presets presets--compact">
					{PRESETS.map((p) => {
						const shown = p.panels === "all" ? PANEL_IDS : p.panels;
						const on = active.value === `preset:${p.id}`;
						return (
							<button
								type="button"
								class={`preset${on ? " is-active" : ""}`}
								key={p.id}
								aria-pressed={on}
								onClick={() => applyPreset(p)}
							>
								<Mini shown={shown} />
								<span class="preset__name">
									{on ? "✓ " : ""}
									{p.name[l]}
								</span>
								<span class="preset__count data">
									{t(`${shown.length} paneles`, `${shown.length} panels`)} · {LAYER_NAME[p.map.layer][l]}
								</span>
								<span class="preset__blurb">{p.blurb[l]}</span>
							</button>
						);
					})}
				</div>
			</section>

			<section aria-labelledby="views-h">
				<h3 id="views-h" class="custom-h">
					{t("Tus vistas", "Your views")}{" "}
					<span class="data note">
						{list.length}/{VIEW_LIMIT}
					</span>
				</h3>
				<p class="note custom-lead">
					{t(
						"Una vista guarda los paneles y su orden, la capa y los puntos del mapa, el estado elegido, la densidad y los ajustes de cada panel. Se guarda en este dispositivo.",
						"A view saves the panels and their order, the map layer and points, the selected state, the density and each panel's settings. It is saved on this device.",
					)}
				</p>
				<form class="inline-form" onSubmit={save}>
					<label class="sr-only" for="view-name">
						{t("Nombre de la vista", "View name")}
					</label>
					<input
						id="view-name"
						class="input"
						placeholder={t("Nombre, p. ej. «Mañana en la redacción»", "Name, e.g. “Morning desk”")}
						value={name}
						maxLength={60}
						onInput={(e) => setName((e.target as HTMLInputElement).value)}
					/>
					<button type="submit" class="button button--primary" disabled={!name.trim()}>
						{t("Guardar lo que ves", "Save what you see")}
					</button>
				</form>
				{message ? (
					<p class={`custom-msg custom-msg--${message.tone}`} role="status">
						{message.text}
					</p>
				) : null}
				{list.length ? (
					<ul class="view-list">
						{list.map((v) => (
							<ViewRow key={v.id} v={v} />
						))}
					</ul>
				) : (
					<p class="empty">{t("Todavía no guardaste ninguna vista.", "You have not saved a view yet.")}</p>
				)}
				<div class="custom-actions">
					<button
						type="button"
						class="button"
						disabled={!list.length}
						onClick={() => download("vigia-vistas.json", exportViewsFile(list, now.value))}
					>
						{t("Exportar todas (.json)", "Export all (.json)")}
					</button>
					<label class="button file-button">
						{t("Importar…", "Import…")}
						<input type="file" accept="application/json,.json" class="sr-only" onChange={importFile} />
					</label>
					<button
						type="button"
						class="button"
						onClick={() => {
							resetLayout();
							resetPanelPrefs();
							setLayer("connectivity");
							toggleQuakes(true);
							toggleFires(false);
							selectState(null);
							markActive(null);
							setMessage({
								tone: "ok",
								text: t("Diseño y ajustes de Vigía restaurados.", "Vigía's layout and settings restored."),
							});
						}}
					>
						{t("Restaurar todo", "Reset everything")}
					</button>
				</div>
			</section>
		</div>
	);
}
