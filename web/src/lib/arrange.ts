import type { PanelId } from "./layout.ts";
import type { ModuleDef } from "./modules.ts";

/* The desk's arrangement of a module's panels (pure; used by the workstation chunk, not by a phone). */

/**
 * A module's columns as the reader arranged them in Personalizar: a panel moved to another column of its module
 * (`deskColumn`, an index into `m.columns`) goes there, each column follows the saved panel order, hidden panels
 * are left out. Empty columns stay (as empty lists) so indices keep matching `m.columns` and `m.widths`.
 */
export function arrange(
	m: ModuleDef,
	order: readonly PanelId[],
	hidden: readonly PanelId[],
	deskColumn: Readonly<Partial<Record<PanelId, number>>>,
): PanelId[][] {
	const n = m.columns.length;
	const cols: PanelId[][] = Array.from({ length: n }, () => []);
	m.columns.forEach((col, i) => {
		for (const id of col) {
			const c = deskColumn[id];
			(cols[c !== undefined && Number.isInteger(c) && c >= 0 && c < n ? c : i] as PanelId[]).push(id);
		}
	});
	const rank = new Map(order.map((id, i) => [id, i]));
	return cols.map((c) =>
		c.filter((id) => !hidden.includes(id)).sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)),
	);
}

/**
 * The columns a desk shows: the non-empty arranged columns with their widths; below 1700 px (`three` false) a third
 * column and beyond join the second. `from` maps each shown column to the module columns it holds.
 */
export function shownColumns(
	m: ModuleDef,
	arranged: readonly PanelId[][],
	three: boolean,
): { panels: PanelId[]; width: number; from: number[] }[] {
	let cols = arranged
		.map((panels, i) => ({ panels: [...panels], width: m.widths?.[i] ?? 1, from: [i] }))
		.filter((c) => c.panels.length);
	if (!three && cols.length > 2) {
		const [first, second, ...rest] = cols as [(typeof cols)[0], (typeof cols)[0], ...typeof cols];
		cols = [
			first,
			{
				panels: [...second.panels, ...rest.flatMap((c) => c.panels)],
				width: second.width,
				from: [...second.from, ...rest.flatMap((c) => c.from)],
			},
		];
	}
	return cols;
}
