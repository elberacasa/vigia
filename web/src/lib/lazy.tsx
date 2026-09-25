import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import { t } from "./i18n.ts";
import { recoverFromChunkError } from "./update.ts";

/**
 * A component loaded on first render, in its own chunk: the secondary pages stay out of the first load on a slow
 * connection. Shows a quiet line while loading and a retry if the chunk cannot be fetched (e.g. offline).
 */
export function lazy(load: () => Promise<ComponentType>): ComponentType {
	let loaded: ComponentType | null = null;
	return function Lazy() {
		const [C, setC] = useState<ComponentType | null>(() => loaded);
		const [failed, setFailed] = useState(false);
		useEffect(() => {
			if (C) return;
			load()
				.then((c) => {
					loaded = c;
					setC(() => c);
				})
				.catch((err) => {
					if (!recoverFromChunkError(err)) setFailed(true);
				});
		}, [C]);
		if (C) return <C />;
		return (
			<main class="page">
				<p class="note">
					{failed ? (
						<>
							{t("No se pudo cargar esta página.", "Could not load this page.")}{" "}
							<button type="button" class="link-button" onClick={() => location.reload()}>
								{t("Reintentar", "Retry")}
							</button>
						</>
					) : (
						t("Cargando…", "Loading…")
					)}
				</p>
			</main>
		);
	};
}

/**
 * A component whose code loads the first time it renders and which draws nothing until then (a dialog, a sheet,
 * a panel shown only after an action). If the chunk cannot be fetched it stays absent; the next render retries.
 */
export function later<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
	let loaded: ComponentType<P> | null = null;
	let pending: Promise<ComponentType<P>> | null = null;
	return function Later(props: P) {
		const [C, setC] = useState<ComponentType<P> | null>(() => loaded);
		useEffect(() => {
			if (C) return;
			pending ??= load();
			pending
				.then((c) => {
					loaded = c;
					setC(() => c);
				})
				.catch((err) => {
					pending = null;
					recoverFromChunkError(err);
				});
		}, [C]);
		return C ? <C {...props} /> : null;
	};
}
