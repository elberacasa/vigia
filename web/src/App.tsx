import { connection, health, now } from "./lib/data.ts";
import { clock } from "./lib/format.ts";
import { feedCounts } from "./lib/fresh.ts";
import { lang, setLang, t } from "./lib/i18n.ts";
import { layoutIsDefault, resetLayout } from "./lib/layout.ts";
import { later, lazy } from "./lib/lazy.tsx";
import {
	density,
	letterKeys,
	reducedMotion,
	setDensity,
	setLetterKeys,
	setReducedMotion,
	setTheme,
	theme,
} from "./lib/prefs.ts";
import { link, route } from "./lib/router.ts";
import { AlertToasts, CustomizeButton, LazyCustomize } from "./ui/custom/Entry.tsx";
import { LiveMark, Wordmark } from "./ui/Logo.tsx";
import { Palette, PaletteButton } from "./ui/Palette.tsx";
import { openMethod, openSource } from "./ui/Source.tsx";
import { StatusBar } from "./ui/StatusBar.tsx";
import { Wall } from "./ui/Wall.tsx";

function Header() {
	// The one feed count (lib/fresh.ts). From 1000 px the status bar shows it, so this copy is for narrower screens.
	const c = feedCounts(health.value);
	const late = c.late + c.down;
	return (
		<header class="topbar">
			<a class="brand" {...link("wall")}>
				<LiveMark size={30} />
				<Wordmark height={15} />
			</a>
			<div class="topbar__clock">
				<span class="caps">Caracas</span>
				<time class="data" dateTime={new Date(now.value).toISOString()}>
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
				<a {...link("ai")} aria-current={route.value === "ai" ? "page" : undefined}>
					{t("Capa IA", "AI")}
				</a>
				<a {...link("sources")} aria-current={route.value === "sources" ? "page" : undefined}>
					{t("Fuentes", "Sources")}
				</a>
			</nav>
			<a class="topbar__status" {...link("status")}>
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
			<details class="prefs">
				<summary class="chip" aria-label={t("Preferencias", "Preferences")}>
					<span aria-hidden="true">⚙</span>
				</summary>
				<div class="prefs__menu">
					<p class="caps">{t("Idioma", "Language")}</p>
					<div class="segmented">
						<button type="button" aria-pressed={lang.value === "es"} onClick={() => setLang("es")}>
							Español
						</button>
						<button type="button" aria-pressed={lang.value === "en"} onClick={() => setLang("en")}>
							English
						</button>
					</div>
					<p class="caps">{t("Tema", "Theme")}</p>
					<div class="segmented">
						{(["system", "dark", "light"] as const).map((k) => (
							<button type="button" key={k} aria-pressed={theme.value === k} onClick={() => setTheme(k)}>
								{k === "system"
									? t("Sistema", "System")
									: k === "dark"
										? t("Oscuro", "Dark")
										: t("Claro", "Light")}
							</button>
						))}
					</div>
					<label class="toggle">
						<input
							type="checkbox"
							checked={reducedMotion.value}
							onChange={() => setReducedMotion(!reducedMotion.value)}
						/>{" "}
						{t("Reducir animaciones", "Reduce motion")}
					</label>
					<label class="toggle">
						<input
							type="checkbox"
							checked={letterKeys.value}
							onChange={() => setLetterKeys(!letterKeys.value)}
						/>{" "}
						{t("Atajos de una tecla", "Single-key shortcuts")}
					</label>
					<p class="caps">{t("Densidad", "Density")}</p>
					<div class="segmented">
						{(["comodo", "compacto", "pared"] as const).map((k) => (
							<button
								type="button"
								key={k}
								aria-pressed={density.value === k}
								onClick={() => setDensity(k)}
								title={
									k === "pared"
										? t(
												"Para una pantalla en la pared: letra grande, un panel abierto a la vez",
												"For a wall screen: large type, one panel open at a time",
											)
										: undefined
								}
							>
								{k === "comodo"
									? t("Cómodo", "Comfy")
									: k === "compacto"
										? t("Compacto", "Compact")
										: t("Pared", "Wall")}
							</button>
						))}
					</div>
					<button
						type="button"
						class="button prefs__reset"
						disabled={layoutIsDefault.value}
						onClick={resetLayout}
					>
						{t("Restaurar diseño", "Reset layout")}
					</button>
					<a
						class="prefs__idea"
						href="https://github.com/elberacasa/vigia/discussions/categories/ideas"
						target="_blank"
						rel="noopener noreferrer"
					>
						{t("Sugerir una idea y votar →", "Suggest an idea and vote →")}
					</a>
					<p class="prefs__credit note">
						Vigía ·{" "}
						<a href="https://github.com/elberacasa" target="_blank" rel="noopener noreferrer">
							{t("por elberacasa", "by elberacasa")}
						</a>
					</p>
				</div>
			</details>
		</header>
	);
}

function OfflineBanner() {
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

const StatusPage = lazy(() => import("./pages/Status.tsx").then((m) => m.StatusPage));
const SourcesPage = lazy(() => import("./pages/Sources.tsx").then((m) => m.SourcesPage));
const GuidePage = lazy(() => import("./pages/Guide.tsx").then((m) => m.GuidePage));
const AiPage = lazy(() => import("./pages/Ai.tsx").then((m) => m.AiPage));
const BriefPage = lazy(() => import("./pages/Brief.tsx").then((m) => m.BriefPage));
const BlockLookupPage = lazy(() => import("./pages/BlockLookup.tsx").then((m) => m.BlockLookupPage));

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

export function App() {
	const r = route.value;
	return (
		<>
			<Header />
			<OfflineBanner />
			{r === "status" ? (
				<StatusPage />
			) : r === "sources" ? (
				<SourcesPage />
			) : r === "guide" ? (
				<GuidePage />
			) : r === "ai" ? (
				<AiPage />
			) : r === "brief" ? (
				<BriefPage />
			) : r === "bloqueos" ? (
				<BlockLookupPage />
			) : (
				<Wall />
			)}
			<Sheets />
			<Palette />
			<StatusBar />
			<LazyCustomize />
			<AlertToasts />
		</>
	);
}
