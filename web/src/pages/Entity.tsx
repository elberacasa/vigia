import { useEffect, useState } from "preact/hooks";
import { panels } from "../lib/data.ts";
import type { EntityModel } from "../lib/entity.ts";
import { lang, t } from "../lib/i18n.ts";
import { jumpTo } from "../lib/keys.ts";
import { later } from "../lib/lazy.tsx";
import { entityId, entityTitle, link, openEntity, openPlace, replacePath } from "../lib/router.ts";
import { ISO_BY_CODE, municipalitySlug, STATE_SLUG, slugify } from "../lib/states.ts";
import type { Facility } from "../map/facilities.ts";
import { connectivityFills } from "../map/fills.ts";
import { STATES } from "../map/geometry.gen.ts";
import { VenezuelaMap } from "../map/Map.tsx";
import { project } from "../map/project.ts";
import { selectEntity, selectState } from "../map/view.ts";
import type { ConnectivityView } from "../panels/Connectivity.tsx";
import { EntityLinkTo, EntityProblem, EntitySkeleton, EntityView } from "../ui/entity/EntityView.tsx";
import { Timeline } from "../ui/entity/Timeline.tsx";
import { useEntity, useEntityModel } from "../ui/entity/useEntity.ts";

/** A camera's timeline is its strip of kept stills (loaded with its page). */
const CameraFilm = later(() => import("../panels/Cameras.tsx").then((m) => m.CameraFilm));

/**
 * An entity's page: /lugar/<estado>[/<municipio>[/<parroquia>]], /infra/<id>, /red/<id>, /institucion/<id>,
 * /medio/<id>. Everything the room links to it (the server's view, lib/entity-api.ts): what every live signal says
 * now, its incidents and headlines, its timeline from the archive, its neighbourhood (parents, children, facilities
 * inside or near, relations), how many people live there, and a map of where it is.
 */
export function EntityPage() {
	const id = entityId.value;
	const load = useEntity(id);
	const model = useEntityModel(id, load);
	useLegacyAddress(id, load.status);

	const name = model?.ref.name ?? null;
	useEffect(() => {
		entityTitle.value = name;
		document.title = name ? `${name} · Vigía` : "Vigía";
		return () => {
			document.title = "Vigía · Venezuela en vivo";
		};
	}, [name]);

	if (!id) return <Missing />;
	if (!model) {
		if (load.status === "missing") return <Missing />;
		return (
			<main class="page entpage">
				<Crumbs model={null} />
				{load.status === "loading" ? (
					<EntitySkeleton variant="page" label={(id.split(".").at(-1) ?? id).replace(/-/g, " ")} />
				) : (
					<EntityProblem kind={load.offline ? "offline" : "error"} retry={load.retry} />
				)}
			</main>
		);
	}
	const hasPlace = Boolean(model.map?.iso || model.point || model.ref.kind === "country");
	return (
		<main class="page entpage">
			<EntityView
				key={model.ref.id}
				model={model}
				variant="page"
				crumbs={<Crumbs model={model} />}
				offline={load.offline}
				pending={load.pending}
				serverError={load.serverError}
				savedAt={load.savedAt}
				actions={<ShowInRoom model={model} />}
				aside={hasPlace ? <MapInset model={model} /> : null}
				timeline={
					model.ref.kind === "camera" ? (
						<CameraFilm entity={model.ref.id} />
					) : model.timeline ? (
						<Timeline
							key={model.timeline}
							path={model.timeline}
							kinds={TIMELINE_KINDS[model.ref.kind] ?? []}
							backlog={model.backlog ?? 0}
							rules={model.rules ?? []}
						/>
					) : null
				}
			/>
		</main>
	);
}

/** The kinds of fact the archive can link to each type (src/ontology/linker.ts), offered as timeline filters. */
const TIMELINE_KINDS: Record<string, readonly string[]> = {
	country: ["quake", "fire", "flare", "outage", "hazard", "incident", "plume", "flood", "forest", "radar"],
	state: [
		"quake",
		"fire",
		"flare",
		"outage",
		"hazard",
		"headline",
		"incident",
		"crowd",
		"plume",
		"flood",
		"forest",
		"radar",
	],
	municipality: [
		"quake",
		"fire",
		"flare",
		"hazard",
		"headline",
		"incident",
		"crowd",
		"plume",
		"flood",
		"forest",
	],
	parish: ["quake", "fire", "flare", "hazard", "headline"],
	infrastructure: ["fire", "flare", "quake", "headline", "plume", "ships", "flight"],
	network: ["outage", "routing", "incident", "radar"],
	institution: ["headline", "gazette", "sanction", "licence", "intervention"],
	outlet: ["headline"],
};

/**
 * /lugar/amazonas/autonomo-atures (the address before the ontology dropped formal prefixes) still opens: the
 * names index finds the municipality and the address becomes /lugar/amazonas/atures.
 */
function useLegacyAddress(id: string | null, status: string): void {
	useEffect(() => {
		if (status !== "missing" || !id?.startsWith("ve.")) return;
		const [state, seg] = id.slice(3).split(".");
		const iso = state ? [...STATE_SLUG].find(([, s]) => s === state)?.[0] : undefined;
		if (!iso || !seg) return;
		void import("../lib/places.gen.ts").then(({ PLACES }) => {
			for (const r of PLACES.split("|")) {
				if (!r.startsWith("M") || ISO_BY_CODE.get(`VE${r.slice(1, 3)}`) !== iso) continue;
				const name = r.slice(5);
				if (slugify(name) === seg && municipalitySlug(name) !== seg) {
					replacePath(`/lugar/${state}/${municipalitySlug(name)}`);
					return;
				}
			}
		});
	}, [id, status]);
}

/** Selects the entity in the room (map, inspector, the panels that follow the selection) and goes there. */
function ShowInRoom({ model }: { model: EntityModel }) {
	const r = model.ref;
	return (
		<button
			type="button"
			class="btn btn--quiet"
			onClick={() => {
				const iso = model.map?.iso ?? null;
				if (r.kind === "state") selectState(iso);
				else if (r.kind === "country") selectState(null);
				else selectEntity(r.id, iso);
				jumpTo("mapa");
			}}
			title={t(
				"Seleccionarlo en el mapa y el inspector de la sala",
				"Select it on the room's map and inspector",
			)}
		>
			{t("Ver en la sala", "Show in the room")}
		</button>
	);
}

function Crumbs({ model }: { model: EntityModel | null }) {
	return (
		<nav class="place__crumbs" aria-label={t("Ruta", "Breadcrumb")}>
			<a {...link("wall")}>{t("Sala", "Room")}</a>
			{(model?.crumbs ?? []).map((c) => (
				<span key={c.id} class="place__crumb">
					<span aria-hidden="true">/</span>
					<EntityLinkTo r={c} />
				</span>
			))}
			{model ? (
				<span class="place__crumb">
					<span aria-hidden="true">/</span>
					<span aria-current="page">{model.ref.name}</span>
				</span>
			) : null}
		</nav>
	);
}

/**
 * Where it is: the state outlined (the municipality inside it), the entity's own point, and the facilities the
 * server lists inside or near it (a press opens one's page). Another state on the map opens that state's page.
 */
function MapInset({ model }: { model: EntityModel }) {
	const iso = model.map?.iso ?? null;
	// "← Venezuela" on the inset zooms out here; it does not leave the page.
	const [shown, setShown] = useState<string | null>(iso);
	useEffect(() => setShown(iso), [iso]);
	const near = model.nearby?.items ?? [];
	const self = model.ref.kind === "infrastructure" ? model.ref.id : null;
	const wanted = new Set([...near.map((n) => n.ref.id), ...(self ? [self] : [])]);
	const wantHealth =
		near.some((n) => n.ref.sub && /salud|health/i.test(n.ref.sub)) ||
		/hospital|salud/.test(model.ref.sub ?? "");
	const [marks, setMarks] = useState<Facility[]>([]);
	const [Marks, setMarksC] = useState<typeof import("../map/FacilityLayer.tsx").FacilityMarks | null>(null);
	const key = [...wanted].sort().join(",");
	useEffect(() => {
		if (!wanted.size) {
			setMarks([]);
			return;
		}
		let alive = true;
		void Promise.all([import("../map/facilities.ts"), import("../map/FacilityLayer.tsx")])
			.then(async ([f, layer]) => {
				const core = await f.loadCore();
				const health =
					wantHealth || (self && !core.facilities.some((x) => x.id === self)) ? await f.loadHealth() : [];
				if (!alive) return;
				setMarksC(() => layer.FacilityMarks);
				setMarks([...core.facilities, ...health].filter((x) => wanted.has(x.id)));
			})
			.catch(() => {
				// Offline without the chunk: the map shows the place without its facilities.
			});
		return () => {
			alive = false;
		};
	}, [key]);
	const point =
		model.point && model.ref.kind !== "infrastructure" ? project(model.point.lon, model.point.lat) : null;
	const l = lang.value;
	const total = (model.nearby?.byKind ?? []).reduce((a, b) => a + b.n, 0) || marks.length;
	return (
		<figure class="place__map">
			<VenezuelaMap
				fills={connectivityFills(panels.value.connectivity as ConnectivityView | undefined)}
				selected={shown}
				highlight={shown ? (model.map?.muni ?? null) : null}
				zoomToHighlight
				onSelect={(next) => {
					if (next && next !== iso) openPlace([STATE_SLUG.get(next) ?? ""]);
					else setShown(next);
				}}
				layers={() => (
					<>
						{Marks && marks.length ? (
							<Marks
								facilities={marks}
								grid={[]}
								selected={self}
								onSelect={(f) => f.id !== self && openEntity(f.id)}
							/>
						) : null}
						{point ? (
							// biome-ignore lint/a11y/noAriaHiddenOnFocusable: the entity's own point; its page says where it is.
							<g
								class="pick-mark pick-mark--entity"
								aria-hidden="true"
								style={{
									transform: `translate(${point[0].toFixed(1)}px, ${point[1].toFixed(1)}px) scale(var(--zk, 1))`,
								}}
							>
								<circle r={4} class="pick-mark__dot" />
							</g>
						) : null}
					</>
				)}
			/>
			<figcaption class="note">
				{marks.length
					? t(
							`Colores: internet por estado (IODA). Formas: ${marks.length} de ${total} instalaciones, las listadas al lado (OpenStreetMap, OurAirports, PortWatch); tócalas para abrir su ficha.`,
							`Colours: internet by state (IODA). Shapes: ${marks.length} of ${total} facilities, those listed beside (OpenStreetMap, OurAirports, PortWatch); tap one for its page.`,
						)
					: t(
							"Colores: internet por estado (IODA). Toca otro estado para abrir su ficha.",
							"Colours: internet by state (IODA). Tap another state to open its page.",
						)}
				{model.ref.kind === "parish"
					? ` ${l === "es" ? "La parroquia se señala con un punto dentro de su municipio." : "The parish is marked with a dot inside its municipality."}`
					: ""}
			</figcaption>
		</figure>
	);
}

function Missing() {
	return (
		<main class="page entpage entpage--missing">
			<h1>{t("Entidad no encontrada", "Entity not found")}</h1>
			<p class="note">
				{t(
					"Esta dirección no corresponde a un lugar, instalación, red, institución ni medio conocido. Búscalo con la lupa de arriba o elige un estado:",
					"This address is not a known place, facility, network, institution or outlet. Search with the magnifier above or pick a state:",
				)}
			</p>
			<ul class="children children--wide">
				{[...STATES]
					.sort((a, b) => a.name.localeCompare(b.name, "es"))
					.map((s) => (
						<li key={s.iso}>
							<a
								href={`/lugar/${STATE_SLUG.get(s.iso) ?? ""}`}
								onClick={(e) => {
									if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
									e.preventDefault();
									openPlace([STATE_SLUG.get(s.iso) ?? ""]);
								}}
							>
								{s.name}
							</a>
						</li>
					))}
			</ul>
			<p>
				<a class="link" {...link("wall")}>
					{t("← Volver a la sala", "← Back to the room")}
				</a>
			</p>
		</main>
	);
}
