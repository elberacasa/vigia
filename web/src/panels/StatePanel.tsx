import { later } from "../lib/lazy.tsx";
import { pickedPoint, selectedEntity, selectedState } from "../map/view.ts";

const SelectionInspector = later(() =>
	import("../ui/entity/EntityInspector.tsx").then((m) => m.SelectionInspector),
);

/**
 * Phones and narrow screens: the selection after the map (a state, a municipality, a facility, what is at a pressed
 * point), drawn by the same entity view as the desk's inspector from the server's linked view.
 */
export function StatePanel() {
	if (!selectedState.value && !selectedEntity.value && !pickedPoint.value) return null;
	return (
		<div class="state-slot" id="estado-seleccionado">
			<SelectionInspector />
		</div>
	);
}
