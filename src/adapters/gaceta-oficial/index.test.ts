import { expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import { gacetaOficial, issueSeries, listUrl, parseIssue, parseList } from "./index.ts";

// The recorded pages name people (appointments), so they stay out of the public repository; the synthetic pages
// below, written by hand in the site's markup, cover the parser everywhere.
const dir = join(import.meta.dir, "fixtures", "2026-09-24");
const recorded = hasFixture(dir);
const live = recorded ? loadFixture(dir) : [];

const LIST = `<html><body><h3>Resultados de Gacetas</h3><table id="tablaGacetas"><thead><tr><th>Nro Gaceta</th>
<th>Tipo</th><th>Título</th><th>Fecha Publicación</th><th>Página Inicio</th><th>Página Fin</th><th>Status</th>
<th>Acciones</th></tr></thead><tbody>
<tr><td>9.002</td><td>EXTRAORDINARIA</td><td>GACETA OFICIAL</td><td>15/09/2026</td><td>1</td><td>24</td>
<td><span class="badge bg-success">PUBLICADO</span></td><td><a href="http://www.gacetaoficial.gob.ve/gacetas/9002">Ver</a></td></tr>
<tr><td>50.001</td><td>ORDINARIA</td><td>GACETA OFICIAL</td><td>11/09/2026</td><td>500001</td><td>500008</td>
<td><span class="badge bg-success">PUBLICADO</span></td><td><a href="http://www.gacetaoficial.gob.ve/gacetas/50001">Ver</a></td></tr>
<tr><td>roto</td><td>ORDINARIA</td><td>GACETA OFICIAL</td><td>31/02/2026</td><td></td><td></td><td></td><td></td></tr>
</tbody></table></body></html>`;

const ISSUE = `<html><body><h5>Detalles de la Gaceta Nro 50.001</h5><table class="table"><thead><tr>
<th>Número de Gaceta</th><th>Tipo de Gaceta</th><th>Título</th><th>Fecha de Publicación</th><th>Página Inicial</th>
<th>Página Final</th><th>Estado de Registro</th></tr></thead><tbody><tr><td>50.001</td><td>ORDINARIA</td>
<td>GACETA OFICIAL</td><td>11/09/2026</td><td>500001</td><td>500008</td><td>
<span class="estado-badge badge bg-success">
	PUBLICADO
</span></td></tr></tbody></table>
<table class="table table-striped" id="sumarios-table" style="display: none;"><thead><tr><th>Órgano</th>
<th>Ente Adscrito</th><th>Título</th><th>Página Inicial</th><th>Página Final</th></tr></thead><tbody>
<tr><td>MINISTERIO DEL PODER POPULAR PARA LA ENERGÍA ELÉCTRICA</td><td></td>
<td>Resolución mediante la cual se designa al ciudadano Pedro Ejemplo Inventado, como Director General de
Planificación del Servicio Eléctrico.</td><td>500001</td><td>500001</td></tr>
<tr><td>PRESIDENCIA DE LA REPÚBLICA</td><td></td><td>Decreto N° 9.999, mediante el cual se fija el horario de la
administración pública.</td><td>500002</td><td>500004</td></tr>
<tr><td>MINISTERIO DEL PODER POPULAR PARA LA SALUD</td><td></td><td>Resolución mediante la cual se designa a las
ciudadanas y ciudadanos que en ella se mencionan, como Directoras y Directores de Área.</td><td>500005</td>
<td>500006</td></tr>
</tbody></table>
<object data="http://www.gacetaoficial.gob.ve/storage/2026/50001-2026-09-11-ORDINARIA.pdf#toolbar=0" type="application/pdf"></object>
</body></html>`;

const at = (url: string, body: string, fetchedAt = Date.UTC(2026, 8, 24, 12)): RawResponse => ({
	url,
	status: 200,
	contentType: "text/html; charset=UTF-8",
	body,
	fetchedAt,
});
const LIST_URL =
	"http://www.gacetaoficial.gob.ve/gacetas/filtro-avanzado?fecha_desde=2026-08-20&fecha_hasta=2026-09-25";

test("parses the range listing and skips a malformed row", () => {
	const { issues, invalid } = parseList(LIST);
	expect(issues).toEqual([
		{ number: 9002, kind: "extraordinaria", date: "2026-09-15", status: "PUBLICADO" },
		{ number: 50001, kind: "ordinaria", date: "2026-09-11", status: "PUBLICADO" },
	]);
	expect(invalid).toBe(1);
});

test("an empty listing is not an error", () => {
	const empty = LIST.replace(
		/<tbody>[\s\S]*<\/tbody>/,
		'<tbody><tr><td colspan="8">No se encontraron Gacetas</td></tr></tbody>',
	);
	expect(parseList(empty)).toEqual({ issues: [], invalid: 0 });
});

test("a page that is not the listing throws SchemaError", () => {
	expect(() => parseList("<html>mantenimiento</html>")).toThrow(SchemaError);
	expect(() => gacetaOficial.normalise([at(LIST_URL, "<html>502</html>")])).toThrow(SchemaError);
});

test("parses an issue page: header, sumario rows (titles naming someone withheld as a category), PDF", () => {
	const issue = parseIssue(ISSUE);
	expect(issue.number).toBe(50001);
	expect(issue.kind).toBe("ordinaria");
	expect(issue.date).toBe("2026-09-11");
	expect(issue.status).toBe("PUBLICADO");
	expect(issue.pdfUrl).toBe("http://www.gacetaoficial.gob.ve/storage/2026/50001-2026-09-11-ORDINARIA.pdf");
	expect(issue.acts).toHaveLength(3);
	expect(issue.acts[0]).toEqual({
		organ: "MINISTERIO DEL PODER POPULAR PARA LA ENERGÍA ELÉCTRICA",
		entity: null,
		title: null,
		instrument: "Resolución",
		withheld: "designacion",
	});
	expect(issue.acts[1]?.instrument).toBe("Decreto");
	expect(issue.acts[1]?.title).toBe(
		"Decreto N° 9.999, mediante el cual se fija el horario de la administración pública.",
	);
	expect(issue.acts[1]?.withheld).toBeNull();
	// "ciudadanas y ciudadanos que en ella se mencionan" names no one, but a designation is never listed.
	expect(issue.acts[2]).toMatchObject({ title: null, withheld: "designacion" });
	expect(JSON.stringify(issue)).not.toContain("Pedro");
});

test("normalise: one official observation per issue page, dated 00:00 Caracas, separate series per kind", () => {
	const obs = gacetaOficial.normalise([
		at(LIST_URL, LIST),
		at("http://www.gacetaoficial.gob.ve/gacetas/50001", ISSUE),
		at("http://www.gacetaoficial.gob.ve/gacetas/9002", "<html>no es un número</html>"),
	]);
	expect(obs).toHaveLength(1);
	const o = obs[0];
	expect(o?.source).toBe("gaceta-oficial");
	expect(o?.series).toBe("gaceta:o:50001");
	expect(o?.observedAt).toBe(Date.UTC(2026, 8, 11, 4));
	expect(o?.sourceUrl).toBe("http://www.gacetaoficial.gob.ve/gacetas/50001");
	expect(o?.basis).toBe("official");
	expect(issueSeries("extraordinaria", 9002)).toBe("gaceta:e:9002");
});

test("list URL spans the last 35 days to tomorrow, Caracas dates (22:00 Caracas on the 24th)", () => {
	expect(listUrl(Date.UTC(2026, 8, 25, 2))).toBe(
		"http://www.gacetaoficial.gob.ve/gacetas/filtro-avanzado?fecha_desde=2026-08-20&fecha_hasta=2026-09-25",
	);
});

test("fetch asks only for issues not stored yet, newest first", async () => {
	const urls: string[] = [];
	const http = {
		async request(url: string) {
			urls.push(url);
			return at(url, url.includes("filtro") ? LIST : ISSUE);
		},
	};
	await gacetaOficial.fetch({
		http,
		key: () => undefined,
		now: () => Date.UTC(2026, 8, 24, 12),
		signal: new AbortController().signal,
		seen: (series) => series === "gaceta:e:9002",
	});
	expect(urls.slice(1)).toEqual(["http://www.gacetaoficial.gob.ve/gacetas/50001"]);
});

test.skipIf(!recorded)(
	"recorded 2026-09-24: 12 issues, newest N° 7.074 (TSJ law reform), no names left",
	() => {
		const obs = gacetaOficial.normalise(live);
		expect(obs).toHaveLength(12);
		const newest = obs.find((o) => o.series === "gaceta:e:7074");
		expect(newest?.value.date).toBe("2026-09-15");
		expect(newest?.value.acts[0]?.title).toBe(
			"Ley Orgánica de Reforma Parcial de la Ley Orgánica del Tribunal Supremo de Justicia.",
		);
		let listed = 0;
		let withheld = 0;
		for (const o of obs) {
			expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
			for (const a of o.value.acts) {
				if (a.title === null) {
					withheld++;
					continue;
				}
				listed++;
				expect(a.withheld).toBeNull();
				expect(a.title).not.toMatch(/ciudadan|c[ée]dula|\[|designa|delega|traslad|jubila|pensi[oó]n/iu);
			}
		}
		// Reviewed by hand on 2026-09-25: the 16 listed titles are laws, budget decrees, norms, corrections, the
		// Chile consulate and one Assembly accord; the rest (appointments, delegations, transfers, decorations, one
		// commission naming its members, one company name in capitals) are counted only.
		expect(listed).toBe(16);
		expect(withheld).toBeGreaterThan(60);
		// A name the old redaction missed in this very fixture ("…y Ovilio José Gamardo Cardiet, en su carácter de…").
		expect(JSON.stringify(obs)).not.toMatch(/Ovilio|Gamardo/u);
	},
);
