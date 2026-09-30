import { lang, setLang, t } from "../lib/i18n.ts";
import { layoutIsDefault, resetLayout } from "../lib/layout.ts";
import {
	density,
	letterKeys,
	reducedMotion,
	setDensity,
	setLetterKeys,
	setReducedMotion,
	setTheme,
	theme,
} from "../lib/prefs.ts";

/** The ⚙ menu: language, theme, motion, single-key shortcuts, density, layout reset, ideas and credit. */
export function PrefsMenu() {
	return (
		<details class="prefs">
			<summary
				class="icon-btn"
				aria-label={t("Preferencias", "Preferences")}
				title={t("Preferencias", "Preferences")}
			>
				<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
					<path
						d="M10 12.6a2.6 2.6 0 1 0 0-5.2a2.6 2.6 0 0 0 0 5.2ZM16.2 11.6l1.3 1-1.6 2.8-1.6-.6a6 6 0 0 1-1.7 1l-.3 1.7H9l-.3-1.7a6 6 0 0 1-1.7-1l-1.6.6-1.6-2.8 1.3-1a6 6 0 0 1 0-2l-1.3-1L5.4 5.8l1.6.6a6 6 0 0 1 1.7-1L9 3.7h3.2l.3 1.7a6 6 0 0 1 1.7 1l1.6-.6 1.6 2.8-1.3 1a6 6 0 0 1 0 2Z"
						fill="none"
						stroke="currentColor"
						stroke-width="1.4"
						stroke-linejoin="round"
					/>
				</svg>
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
											"Para una pantalla en la pared: letra grande; el inspector rota entre lo que no está normal",
											"For a wall screen: large type; the inspector rotates among what is not normal",
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
	);
}
