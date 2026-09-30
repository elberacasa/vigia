import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { connection, healthById, meta, now, panels, tick, wantPanel } from "../../lib/data.ts";
import { type EntityInput, type EntityModel, municipalityModel, stateModel } from "../../lib/entity.ts";
import { type ApiView, adaptEntity, fetchEntity, isoOfPlace, savedEntity } from "../../lib/entity-api.ts";
import {
	licencesSection,
	type MonetaryLite,
	monetarySection,
	officesSection,
	sanctionsSection,
} from "../../lib/entity-extras.ts";
import { lang } from "../../lib/i18n.ts";
import type { OfficialsView, SanctionsView } from "../../lib/sanctions-view.ts";
import { municipalitySlug, slugify } from "../../lib/states.ts";

/**
 * Loading an entity for the inspector and the pages: the server's linked view, refreshed every minute while shown;
 * this device's copy when the server cannot be reached (said, with its age); and, for a state or a municipality, the
 * model built here from the loaded panels (said as well) when there is neither.
 */

export type EntityStatus = "loading" | "ok" | "missing" | "error";

export interface EntityLoad {
	status: EntityStatus;
	view: ApiView | null;
	/** When the shown copy arrived (UTC ms); for a saved copy, how old the page is. */
	savedAt: number | null;
	/** The copy is this device's: the server has not answered (yet, or at all). */
	offline: boolean;
	/** A saved copy shown while the server's answer is on its way. */
	pending: boolean;
	/** The server answered with an error (not a lost connection). */
	serverError: boolean;
	retry: () => void;
}

type LoadState = Omit<EntityLoad, "retry">;
const REFRESH_MS = 60_000;
/** A saved copy older than this shows every figure as out of date. */
const SAVED_FRESH_MS = 5 * 60_000;
const LOADING: LoadState = {
	status: "loading",
	view: null,
	savedAt: null,
	offline: false,
	pending: false,
	serverError: false,
};

/** What to show before the server answers: this device's copy, said to be one, or the loading frame. */
function initial(id: string | null): LoadState {
	const saved = id ? savedEntity(id) : null;
	return saved
		? { status: "ok", view: saved.data, savedAt: saved.at, offline: true, pending: true, serverError: false }
		: LOADING;
}

export function useEntity(id: string | null): EntityLoad {
	const [state, setState] = useState<LoadState>(() => initial(id));
	const [nonce, setNonce] = useState(0);
	// A minute's bucket of the 15 s tick: the page refreshes its view without re-rendering every second.
	const bucket = Math.floor(tick.value / REFRESH_MS);
	const live = connection.value === "live";
	const current = useRef<string | null>(id);
	const inflight = useRef<AbortController | null>(null);

	const load = (target: string) => {
		inflight.current?.abort();
		const ctrl = new AbortController();
		inflight.current = ctrl;
		fetchEntity(target, ctrl.signal)
			.then((r) => {
				if (ctrl.signal.aborted || current.current !== target) return;
				if (r.state === "ok")
					setState({
						status: "ok",
						view: r.data,
						savedAt: r.savedAt,
						offline: r.offline,
						pending: false,
						serverError: Boolean(r.serverError),
					});
				else if (r.state === "missing") setState({ ...LOADING, status: "missing" });
				else if (r.state === "error")
					setState((s) =>
						s.view
							? { ...s, offline: true, pending: false, serverError: !r.offline }
							: { ...LOADING, status: "error", offline: r.offline, serverError: !r.offline },
					);
			})
			.catch(() => {
				// Aborted: a newer request or the view went away.
			})
			.finally(() => {
				if (inflight.current === ctrl) inflight.current = null;
			});
	};

	// A new id (or a retry, or the connection coming back) asks at once, cancelling what was in flight.
	useEffect(() => {
		if (!id) return;
		if (current.current !== id) {
			current.current = id;
			setState(initial(id));
		}
		load(id);
	}, [id, nonce, live]);
	// The minute's refresh never cancels an answer on its way.
	useEffect(() => {
		if (id && !inflight.current) load(id);
	}, [bucket]);
	useEffect(() => () => inflight.current?.abort(), []);

	const retry = () => setNonce((n) => n + 1);
	// The render between a new id and its effect must not show the previous entity.
	if (id && state.view && state.view.entity.id !== id) return { ...initial(id), retry };
	return { ...state, retry };
}

/** The on-demand panels an entity's extra sections read (sanctions, offices, the BCV's series). */
function extrasFor(type: string, id: string): string[] {
	if (type === "institution") return ["sanctions", "officials", ...(id === "inst.bcv" ? ["monetary"] : [])];
	if (type === "state") return ["officials"];
	return [];
}

/** The news outlets' feeds, for the headline count's freshness in the panel-built model. */
export function newsFeeds(): string[] {
	return meta.value.filter((m) => m.layer === "news").map((m) => m.id);
}

/** Municipalities of a state from the names-only index (loaded on demand, 8 KB), for the offline model. */
async function municipalityOf(
	iso: string,
	slug: string,
): Promise<{ code: string; name: string; stateIso: string } | null> {
	const [{ PLACES }, { ISO_BY_CODE }] = await Promise.all([
		import("../../lib/places.gen.ts"),
		import("../../lib/states.ts"),
	]);
	for (const r of PLACES.split("|")) {
		if (!r.startsWith("M")) continue;
		const code = `VE${r.slice(1, 5)}`;
		const name = r.slice(5);
		if (ISO_BY_CODE.get(code.slice(0, 4)) !== iso) continue;
		if (municipalitySlug(name) === slug || slugify(name) === slug) return { code, name, stateIso: iso };
	}
	return null;
}

/**
 * The model to draw: the server's view adapted, with the sections the room's own panels add (sanctions, offices,
 * the BCV's series); or, for a state or municipality without it, the panel-built model. Rebuilt when a panel, the
 * feeds' health or the language changes, and at most every 30 s otherwise.
 */
export function useEntityModel(id: string | null, load: EntityLoad): EntityModel | null {
	const view = load.view;
	const type = view?.entity.type ?? null;
	useEffect(() => {
		if (!view) return;
		for (const p of extrasFor(view.entity.type, view.entity.id)) void wantPanel(p).catch(() => {});
	}, [view?.entity.id]);

	// Offline fallback for places: the municipality's name comes from the lazily loaded index.
	const [muni, setMuni] = useState<{ code: string; name: string; stateIso: string } | null>(null);
	const segs = id?.startsWith("ve.") ? id.slice(3).split(".") : [];
	const iso = id ? isoOfPlace(id) : null;
	const needFallback =
		!view && (load.status === "error" || load.status === "loading") && segs.length === 2 && iso;
	useEffect(() => {
		if (!needFallback || !iso) return;
		let alive = true;
		void municipalityOf(iso, segs[1] as string)
			.then((m) => alive && setMuni(m))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [needFallback, id]);

	const bucket = tick.value;
	const savedAt = load.savedAt;
	const saved = load.offline;
	const p = panels.value;
	return useMemo(() => {
		const l = lang.value;
		if (view) {
			const model = adaptEntity(view, l, now.peek());
			// A copy from this device carries the stale flags of when it was saved: once it is older than a few
			// minutes, every figure in it is out of date, whatever it said then.
			if (saved && savedAt !== null && now.peek() - savedAt > SAVED_FRESH_MS)
				model.facts = model.facts.map((f) => ({ ...f, stale: true }));
			const names = {
				id: view.entity.id,
				type: view.entity.type,
				name: view.entity.name,
				short: view.entity.short,
				aliases: view.entity.aliases,
			};
			const extras = [
				monetarySection(names, p.monetary as MonetaryLite | undefined, l),
				type === "institution" || type === "state"
					? officesSection(names, p.officials as OfficialsView | undefined, l, isoOfPlace(view.entity.id))
					: null,
				type === "institution" ? sanctionsSection(names, p.sanctions as SanctionsView | undefined, l) : null,
				type === "institution" ? licencesSection(names, p.sanctions as SanctionsView | undefined, l) : null,
			].filter((s) => s !== null);
			return { ...model, sections: [...model.sections, ...extras] };
		}
		if (!iso || segs.length > 2) return null;
		const input = { ...(p as EntityInput), newsFeeds: newsFeeds() };
		if (segs.length === 1) return stateModel(iso, input, healthById.value, now.peek(), l);
		return muni && muni.stateIso === iso
			? municipalityModel(muni, input, healthById.value, now.peek(), l)
			: null;
	}, [view, p, healthById.value, lang.value, bucket, muni, id, saved, savedAt]);
}
