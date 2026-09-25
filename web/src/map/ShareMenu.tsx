import { type ComponentType, h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../lib/i18n.ts";

type Sheet = ComponentType<{ mapCard: () => Promise<Blob> }>;
let sheet: Sheet | null = null;

/**
 * The share button. Its menu (copy link, WhatsApp, Telegram, image cards) loads as its own chunk the first time it is
 * opened, so none of it weighs on the first load.
 */
export function ShareMenu({ mapCard }: { mapCard: () => Promise<Blob> }) {
	const [open, setOpen] = useState(false);
	const [Sheet, setSheet] = useState<Sheet | null>(() => sheet);
	const [failed, setFailed] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		if (!Sheet)
			import("./ShareSheet.tsx")
				.then((m) => {
					sheet = m.ShareSheet;
					setSheet(() => m.ShareSheet);
				})
				.catch(() => setFailed(true));
		const close = (e: Event) => {
			if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node))
				setOpen(false);
		};
		addEventListener("pointerdown", close);
		addEventListener("keydown", close);
		return () => {
			removeEventListener("pointerdown", close);
			removeEventListener("keydown", close);
		};
	}, [open, Sheet]);

	return (
		<div class="share-menu" ref={ref}>
			<button
				type="button"
				class="share-menu__button"
				aria-expanded={open}
				aria-haspopup="menu"
				onClick={() => setOpen(!open)}
			>
				<span aria-hidden="true">⤴</span> {t("Compartir", "Share")}
			</button>
			{open ? (
				Sheet ? (
					h(Sheet, { mapCard })
				) : (
					<div class="share-menu__sheet" role="status">
						<p class="note">
							{failed
								? t("No se pudo cargar el menú (¿sin conexión?).", "Could not load the menu (offline?).")
								: t("Cargando…", "Loading…")}
						</p>
					</div>
				)
			) : null}
		</div>
	);
}

/** For the palette and shortcuts: make one card without opening the menu ("map" needs the map panel's own maker). */
export async function shareCard(
	kind: "map" | "dollar" | "internet" | "quakes" | "state",
	mapCard?: () => Promise<Blob>,
): Promise<boolean> {
	return (await import("./ShareSheet.tsx")).shareCard(kind, mapCard);
}
