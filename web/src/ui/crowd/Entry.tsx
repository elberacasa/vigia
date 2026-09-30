import type { ComponentProps } from "preact";
import { crowdOn, reportSheet } from "../../lib/crowd.ts";
import { later } from "../../lib/lazy.tsx";

/*
 * The ways into the crowd report ("¿tienes luz?"), in the first load only as these few lines: the buttons, the
 * sheet, its worker and its words are chunks of their own. Nothing is offered until this Vigía has said it takes
 * reports (lib/crowd.ts asks once, after the first data is on screen).
 */

const Sheet = later(() => import("./ReportSheet.tsx").then((m) => m.ReportSheet));
const Row = later(() => import("./Buttons.tsx").then((m) => m.ReportRow));
const Button = later<ComponentProps<typeof import("./Buttons.tsx").ReportButton>>(() =>
	import("./Buttons.tsx").then((m) => m.ReportButton),
);

let used = false;
/** The sheet, mounted the first time a report is opened, then kept (its dialog opens and closes). */
export function ReportSheetSlot() {
	if (reportSheet.value) used = true;
	return used ? <Sheet /> : null;
}

/** The phone's row under the priority list. */
export function ReportRow() {
	return crowdOn() ? <Row /> : null;
}

/** A button for a bar or a header ("¿Tienes luz? Reportar"), starting from a municipality when one is in view. */
export function ReportButton(props: ComponentProps<typeof import("./Buttons.tsx").ReportButton>) {
	return crowdOn() ? <Button {...props} /> : null;
}
