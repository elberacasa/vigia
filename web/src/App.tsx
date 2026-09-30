import type { ComponentChildren, ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import { loadCrowdConfig } from "./lib/crowd.ts";
import { connection, health, now } from "./lib/data.ts";
import { clock } from "./lib/format.ts";
import { feedCounts } from "./lib/fresh.ts";
import { lang, t } from "./lib/i18n.ts";
import { viewport } from "./lib/layout.ts";
import { later } from "./lib/lazy.tsx";
import { link, route } from "./lib/router.ts";
import { recoverFromChunkError } from "./lib/update.ts";
import { ReportSheetSlot } from "./ui/crowd/Entry.tsx";
import { AlertToasts, CustomizeButton, LazyCustomize } from "./ui/custom/Entry.tsx";
import { LiveMark, Wordmark } from "./ui/Logo.tsx";
import { Palette, PaletteButton } from "./ui/Palette.tsx";
import { PrefsMenu } from "./ui/Prefs.tsx";
import {
	AiPage,
	BlockLookupPage,
	BriefPage,
	EntityPage,
	GuidePage,
	SourcesPage,
	StatusPage,
} from "./ui/pages.tsx";
import { openMethod, openSource } from "./ui/Source.tsx";
import { TabBar } from "./ui/TabBar.tsx";
import { Wall } from "./ui/Wall.tsx";

/** Phones and narrow screens: the header over one scrolling page. */
function Header() {
	const c = feedCounts(health.value);
	const late = c.late + c.down;
	return (
		<header class="topbar">
			<a class="brand" {...link("wall")}>
				<LiveMark size={26} />
				<Wordmark height={13} />
			</a>
			<div class="topbar__clock">
				<span class="caps">Caracas</span>
				<time class="mono" dateTime={new Date(now.value).toISOString()}>
					{clock(now.value, lang.value, true)}
				</time>
			</div>
			<nav class="topbar__nav" aria-label={t("Secciones", "Sections")}>
				<a {...link("wall")} aria-current={route.value === "wall" ? "page" : undefined}>
					{t("En vivo", "Live")}
				</a>
				<a {...link("brief")} aria-current={route.value === "brief" ? "page" : undefined}>
					{t("Resumen", "Brief")}
				</a>
				<a {...link("guide")} aria-current={route.value === "guide" ? "page" : undefined}>
					{t("Configurar", "Set up")}
				</a>
				<a {...link("sources")} aria-current={route.value === "sources" ? "page" : undefined}>
					{t("Fuentes", "Sources")}
				</a>
			</nav>
			<a
				class="topbar__status"
				title={t(`${c.live} de ${c.enabled} fuentes al día`, `${c.live} of ${c.enabled} feeds current`)}
				{...link("status")}
			>
				<span
					class={`dot dot--${connection.value === "live" ? "ok" : connection.value === "offline" ? "failing" : "pending"}`}
				/>
				<span>
					{t(`${c.live} de ${c.enabled} fuentes al día`, `${c.live} of ${c.enabled} feeds current`)}
					{late ? <span class="topbar__late"> · {t(`${late} con retraso`, `${late} delayed`)}</span> : null}
				</span>
			</a>
			<PaletteButton />
			<CustomizeButton />
			<PrefsMenu />
		</header>
	);
}

export function OfflineBanner() {
	if (connection.value !== "offline") return null;
	return (
		<div class="offline" role="status">
			{t(
				"Sin conexión con Vigía. Ves los últimos datos guardados en este dispositivo; cada cifra muestra su edad real.",
				"No connection to Vigía. You are seeing the last data saved on this device; every figure shows its real age.",
			)}
		</div>
	);
}

/** The page for the current route (the room itself is the Wall on a phone, a module on a desk). */
export function RoutePage() {
	switch (route.value) {
		case "status":
			return <StatusPage />;
		case "sources":
			return <SourcesPage />;
		case "guide":
			return <GuidePage />;
		case "ai":
			return <AiPage />;
		case "brief":
			return <BriefPage />;
		case "bloqueos":
			return <BlockLookupPage />;
		case "entity":
			return <EntityPage />;
		default:
			return null;
	}
}

const SourceSheet = later(() => import("./ui/SourceSheet.tsx").then((m) => m.SourceSheet));
const MethodSheet = later(() => import("./ui/SourceSheet.tsx").then((m) => m.MethodSheet));
let sheetsUsed = false;
/** The source and method sheets load the first time one is opened, then stay mounted. */
function Sheets() {
	if (openSource.value || openMethod.value) sheetsUsed = true;
	return sheetsUsed ? (
		<>
			<SourceSheet />
			<MethodSheet />
		</>
	) : null;
}

/**
 * The desk's workstation is its own chunk (not in a phone's first load). main.tsx fetches it before the first render
 * on a desk, so the static shell in index.html stays until the workstation can draw; after a resize from a phone
 * width it loads here, with the same silhouette meanwhile.
 */
let Desk: ComponentType | null = null;
export function loadWorkstation(): Promise<ComponentType> {
	return import("./ui/ws/Workstation.tsx").then((m) => {
		Desk = m.Workstation;
		return m.Workstation;
	});
}
function DeskShell({ fallback }: { fallback: ComponentChildren }) {
	const [C, setC] = useState<ComponentType | null>(() => Desk);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (C) return;
		loadWorkstation()
			.then((c) => setC(() => c))
			.catch((err) => {
				// Offline before the desk's chunk was ever cached: the one-page room works everywhere.
				if (!recoverFromChunkError(err)) setFailed(true);
			});
	}, [C]);
	if (C) return <C />;
	return failed ? <>{fallback}</> : <div class="ws-boot" aria-busy="true" />;
}

export function isDesk(): boolean {
	return viewport.value === "mid" || viewport.value === "wide";
}

/** Asks once, after the first data, whether this Vigía takes crowd reports (the report buttons wait for it). */
function useCrowdConfig(): void {
	const ready = connection.value !== "connecting";
	useEffect(() => {
		if (!ready) return;
		const idle = (fn: () => void) =>
			"requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(fn, 800);
		idle(() => void loadCrowdConfig());
	}, [ready]);
}

export function App() {
	useCrowdConfig();
	const page = (
		<>
			<Header />
			<OfflineBanner />
			{route.value === "wall" ? (
				<Wall />
			) : (
				<>
					<RoutePage />
					{viewport.value === "phone" ? <TabBar /> : null}
				</>
			)}
		</>
	);
	return (
		<>
			{isDesk() ? <DeskShell fallback={page} /> : page}
			<Sheets />
			<Palette />
			<ReportSheetSlot />
			<LazyCustomize />
			<AlertToasts />
		</>
	);
}
