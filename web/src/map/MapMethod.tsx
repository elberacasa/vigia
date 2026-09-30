import { t } from "../lib/i18n.ts";

/** The map's "?" (how to read it): its own chunk, loaded when the method sheet opens. */
export function MapMethod() {
	return (
		<>
			<p>
				{t(
					"Una sola capa colorea los estados a la vez; sismos y focos de calor van encima como puntos. Cada fila de la lista dice su cifra y la edad de su dato.",
					"One layer colours the states at a time; earthquakes and heat spots sit on top as points. Each row of the list gives its figure and the age of its data.",
				)}
			</p>
			<p>
				{t(
					"Historial (capa Internet): el nivel de cada estado al cierre de cada hora (o el peor nivel horario en 7 y 30 días), calculado en el servidor con las mismas reglas del panel de Internet sobre los datos de IODA guardados. Nada se interpola; una hora sin datos queda rayada. Altura de cada barra: estados con caída.",
					"History (Internet layer): each state's level at the close of each hour (or its worst hourly level over 7 and 30 days), computed on the server by the Internet panel's rules over the stored IODA data. Nothing is interpolated; an hour without data stays hatched. Bar height: states with a drop.",
				)}
			</p>
			<p>
				{t(
					"Sismos: círculo según la magnitud; el borde se atenúa con la edad (1 h a 30 días). Un sismo nuevo se anuncia con un solo anillo.",
					"Earthquakes: circle by magnitude; the outline fades with age (1 h to 30 days). A new quake is announced with a single ring.",
				)}
			</p>
			<p>
				{t(
					"Límites: INE vía OCHA/HDX (CC BY-IGO 3.0). Países vecinos: Natural Earth. La zona al oeste del Esequibo se marca como en reclamación.",
					"Boundaries: INE via OCHA/HDX (CC BY-IGO 3.0). Neighbours: Natural Earth. The area west of the Essequibo is marked as under claim.",
				)}
			</p>
		</>
	);
}
