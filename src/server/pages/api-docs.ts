import { OPERATIONS } from "../v1/openapi.ts";
import { h, page } from "./shell.ts";

/**
 * GET /api: the read API's documentation for people, in Spanish first (a short English section at the end), built
 * from the same route table as the OpenAPI document so the two never disagree.
 */
export function apiDocsPage(options: {
	readonly version: string;
	readonly origin: string;
	readonly cors: boolean;
	readonly mode: "local" | "public";
}): string {
	const { origin } = options;
	const routes = OPERATIONS.map((op) => {
		const params = (op.params ?? [])
			.map(
				(p) =>
					`<tr><td><code>${h(p.name)}</code></td><td>${p.in === "path" ? "ruta" : "consulta"}${p.required ? ", obligatorio" : ""}</td><td>${h(p.description)}</td></tr>`,
			)
			.join("");
		const id = `op-${op.id}`;
		return `<section aria-labelledby="${id}">
<h3 id="${id}"><code>GET ${h(op.path)}</code></h3>
<p><strong>${h(op.summary)}.</strong> ${h(op.description)}</p>
${params ? `<div class="scroll" tabindex="0" role="region" aria-label="Parámetros de ${h(op.path)}"><table><thead><tr><th scope="col">Parámetro</th><th scope="col">Dónde</th><th scope="col">Qué es</th></tr></thead><tbody>${params}</tbody></table></div>` : ""}
${op.csv ? `<p class="note">Columnas CSV: <code>${h(op.csv)}</code></p>` : ""}
<p class="note">Ejemplo: <a href="${h(op.example)}">${h(op.example)}</a></p>
</section>`;
	}).join("\n");

	const body = `<p class="kicker">Vigía ${h(options.version)} · API v1</p>
<h1>API pública de lectura</h1>
<p class="lede">Las mismas cifras que muestra Vigía, para programas, hojas de cálculo e instituciones: cada una con su fuente, la hora en que la fuente dice que es cierta, la hora en que Vigía la recibió y su licencia. Solo lectura, versionada y documentada en <a href="/api/v1/openapi.json">OpenAPI 3.1</a>.</p>

<h2>Primeros pasos</h2>
<pre tabindex="0" aria-label="Ejemplos con curl"><code>curl ${h(origin)}/api/v1/panels
curl ${h(origin)}/api/v1/panels/money/figures?format=csv -o dinero.csv
curl ${h(origin)}/api/v1/health</code></pre>
<p>Para una copia impresa del día con todas las fuentes y horas: <a href="/informe">el informe diario</a> (imprímalo o guárdelo como PDF desde el navegador).</p>

<h2>Reglas de la API</h2>
<ul>
<li><strong>Estable.</strong> Dentro de <code>/api/v1</code> los campos y las rutas solo se agregan; nunca se renombran, quitan ni cambian de tipo. Un cambio incompatible sería <code>/api/v2</code>. Su programa debe ignorar los campos que no conozca.</li>
<li><strong>Horas.</strong> En JSON, milisegundos Unix (UTC); en CSV, ISO 8601 en UTC. <code>observedAt</code> es cuándo la fuente dice que el dato es cierto; <code>fetchedAt</code>, cuándo Vigía lo recibió.</li>
<li><strong>Cifras calculadas por código.</strong> Tasas, brechas, conteos y variaciones se calculan de forma determinista y probada; ningún modelo de IA produce una cifra.</li>
<li><strong>Licencias.</strong> Cada fuente declara su licencia y su atribución (<a href="/api/v1/sources">/api/v1/sources</a>); al reutilizar datos, cite la atribución. Las fuentes cuyos términos no permiten redistribuir sus filas (<code>licence.raw: false</code>, por ejemplo las noticias, IODA o RIPEstat) responden <code>403</code> en las rutas de series: de ellas solo se publican los resultados que Vigía deriva (paneles, cifras, historial de conectividad).</li>
<li><strong>Caché.</strong> Cada respuesta lleva <code>ETag</code> y <code>Last-Modified</code>; repita la consulta con <code>If-None-Match</code> o <code>If-Modified-Since</code> y recibirá <code>304</code> sin cuerpo si nada cambió. <code>Cache-Control</code> dice por cuántos segundos puede reutilizarla.</li>
<li><strong>CORS.</strong> ${options.cors ? "Activado: cualquier página puede leer esta API desde el navegador (solo GET, HEAD y OPTIONS; nunca con credenciales)." : "Desactivado en esta instalación (modo local): solo esta página y programas fuera del navegador leen la API. Quien la aloje puede activarlo con <code>VIGIA_CORS=1</code>; en el modo público está activado."}</li>
<li><strong>Límites.</strong> Por cliente, ráfagas de 120 solicitudes y 2 por segundo; las exportaciones CSV, las series y el historial cuentan 5. Al pasarse, <code>429</code> con <code>Retry-After</code>.</li>
<li><strong>Errores.</strong> <code>{"error": "…"}</code> con un mensaje en español y el código HTTP que corresponde (400, 403, 404, 405, 429, 503).</li>
<li><strong>Solo lectura.</strong> La API no tiene rutas de escritura, nunca muestra claves ni ajustes, y ${options.mode === "public" ? "esta instalación es un espejo público: toda escritura está desactivada." : "los cambios de ajustes solo se hacen desde el equipo donde corre Vigía."}</li>
</ul>

<h2>Rutas</h2>
${routes}

<h2 lang="en">In English</h2>
<div lang="en">
<p>A versioned, read-only JSON and CSV API over Vigía's computed panels, each figure with its source, observed and fetched times and licence. The machine-readable contract is <a href="/api/v1/openapi.json">/api/v1/openapi.json</a> (OpenAPI 3.1, generated from the server's schemas). Times are Unix ms (UTC) in JSON and ISO 8601 UTC in CSV. Within v1, fields are only ever added. Rows of sources whose terms forbid redistribution are never served (403); only what Vigía derives from them. Responses carry weak ETags and Last-Modified for conditional requests; CORS is ${options.cors ? "on" : "off on this installation"}; rate limits answer 429 with Retry-After.</p>
</div>`;

	return page({
		title: "API de Vigía",
		lang: "es",
		description:
			"Documentación de la API pública de lectura de Vigía (v1): cifras con fuente, hora y licencia.",
		body,
		css: "section h3{margin-top:1.5rem}",
	});
}
