import { openReport } from "../../lib/crowd.ts";
import { addStyles } from "../../lib/css.ts";
import { t } from "../../lib/i18n.ts";
import entryCss from "../../styles/crowd-entry.css?inline";

addStyles(entryCss);

/*
 * The buttons into the crowd report, their own small chunk: they appear only after this Vigía said it takes reports
 * (lib/crowd.ts asks once, after the first data is on screen), so nothing here is in the first load.
 */

function Icon() {
	return (
		<svg class="report-cta__icon ico" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
			<path d="M11 2.5 4.5 11.5h5l-1 6 6.5-9h-5l1-6Z" />
		</svg>
	);
}

/** The phone's row under the priority list: calm, one line of what it is and one of what it is not. */
export function ReportRow() {
	return (
		<button type="button" class="report-cta" onClick={() => openReport()} aria-haspopup="dialog">
			<Icon />
			<span class="report-cta__text">
				<span class="report-cta__main">
					{t("¿Tienes luz, agua, internet? Reporta", "Do you have power, water, internet? Report")}
				</span>
				<span class="report-cta__sub">
					{t(
						"Anónimo, por municipio; se muestra como reportes de usuarios, nunca como medición",
						"Anonymous, by municipality; shown as user reports, never as a measurement",
					)}
				</span>
			</span>
		</button>
	);
}

/** A button for a bar or a header ("Reportar"), starting from a municipality when one is in view. */
export function ReportButton({
	municipality = null,
	label,
	class: cls = "btn btn--quiet",
}: {
	municipality?: string | null;
	label?: string;
	class?: string;
}) {
	return (
		<button
			type="button"
			class={cls}
			aria-haspopup="dialog"
			onClick={() => openReport(municipality)}
			title={t(
				"¿Tienes luz, agua, internet, gasolina? Reporte anónimo por municipio",
				"Do you have power, water, internet, fuel? Anonymous report by municipality",
			)}
		>
			<svg class="ico" viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
				<path d="M11 2.5 4.5 11.5h5l-1 6 6.5-9h-5l1-6Z" />
			</svg>
			{label ?? t("¿Tienes luz? Reportar", "Power out? Report")}
		</button>
	);
}
