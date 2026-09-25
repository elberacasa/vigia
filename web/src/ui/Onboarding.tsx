import { useEffect, useRef, useState } from "preact/hooks";
import { addStyles } from "../lib/css.ts";
import { t } from "../lib/i18n.ts";
import { applyPreset, markOnboarded, PANEL_IDS, type PanelId, shouldOnboard } from "../lib/layout.ts";
import onboardingCss from "../styles/onboarding.css?inline";

addStyles(onboardingCss);

interface Preset {
	id: string;
	name: string;
	blurb: string;
	panels: readonly PanelId[] | "all";
}

/**
 * First visit only: three ways to start, no account. Picking one hides the panels it leaves out (they stay one
 * tap away under "Paneles ocultos"); closing the sheet keeps everything. Never shown to someone who arrived by a
 * shared link (see shouldOnboard).
 */
export function Onboarding() {
	const ref = useRef<HTMLDialogElement>(null);
	const [open, setOpen] = useState(shouldOnboard);
	useEffect(() => {
		const d = ref.current;
		if (open && d && !d.open) d.showModal();
	}, [open]);
	if (!open) return null;
	const presets: Preset[] = [
		{
			id: "esencial",
			name: t("Lo esencial", "The essentials"),
			blurb: t(
				"Incidentes, dólar, internet, sismos y noticias.",
				"Incidents, dollar, internet, earthquakes and news.",
			),
			panels: ["incidentes", "dinero", "conectividad", "sismos", "noticias"],
		},
		{
			id: "todo",
			name: t("Todo", "Everything"),
			blurb: t(
				"Cada señal: también clima, incendios, luces, satélite, petróleo y censura.",
				"Every signal: also weather, fires, night lights, satellite, oil and censorship.",
			),
			panels: "all",
		},
		{
			id: "periodista",
			name: t("Periodista", "Journalist"),
			blurb: t(
				"Incidentes con su evidencia, noticias, censura y caídas de internet, con el mapa para compartir.",
				"Incidents with their evidence, news, censorship and internet drops, with the map to share.",
			),
			panels: ["incidentes", "noticias", "censura", "conectividad"],
		},
	];
	const finish = (panels?: Preset["panels"]) => {
		if (panels) applyPreset(panels);
		markOnboarded();
		ref.current?.close();
		setOpen(false);
	};
	return (
		<dialog ref={ref} class="sheet sheet--onboard" aria-labelledby="onboard-title" onClose={() => finish()}>
			<div class="sheet__inner">
				<header class="sheet__head">
					<div>
						<p class="caps sheet__kicker">{t("Bienvenida", "Welcome")}</p>
						<h2 id="onboard-title" class="sheet__title">
							{t("¿Qué quieres ver primero?", "What do you want to see first?")}
						</h2>
						<p class="sheet__sub">
							{t(
								"Vigía reúne señales públicas de Venezuela, cada cifra con su fuente y su hora.",
								"Vigía gathers Venezuela's public signals, every figure with its source and time.",
							)}
						</p>
					</div>
					<button type="button" class="sheet__close" onClick={() => finish()}>
						<span aria-hidden="true">✕</span>
						<span class="sr-only">{t("Cerrar y ver todo", "Close and see everything")}</span>
					</button>
				</header>
				<div class="presets">
					{presets.map((p) => {
						const on = p.panels === "all" ? PANEL_IDS : p.panels;
						return (
							<button type="button" class="preset" key={p.id} onClick={() => finish(p.panels)}>
								<span class="preset__mini" aria-hidden="true">
									<i class="preset__map" />
									{PANEL_IDS.map((id) => (
										<i key={id} class={on.includes(id) ? "is-on" : ""} />
									))}
								</span>
								<span class="preset__name">{p.name}</span>
								<span class="preset__count data">
									{t(`${on.length} paneles + mapa`, `${on.length} panels + map`)}
								</span>
								<span class="preset__blurb">{p.blurb}</span>
							</button>
						);
					})}
				</div>
				<p class="note presets__foot">
					{t(
						"Datos abiertos, sin cuenta. Cambia esto cuando quieras en ⚙ o en el menú ⋯ de cada panel.",
						"Open data, no account. Change this any time in ⚙ or in each panel's ⋯ menu.",
					)}
				</p>
			</div>
		</dialog>
	);
}
