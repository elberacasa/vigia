import { contracts, facts } from "@/lib/data";
import { tsHtml } from "@/lib/highlight";
import { blob, type Lang, num, REPO, tr } from "@/lib/i18n";
import { Arrow, GitHubIcon } from "./Icons";
import { Reveal } from "./Reveal";
import { Scroll } from "./Scroll";
import { Section } from "./Section";

/**
 * The architecture, drawn by hand: one process, sources in, a small client out. Wide screens get it left to right;
 * phones get the same boxes top to bottom at full size, instead of a shrunken strip to scroll.
 */
function Architecture({ lang, tall }: { lang: Lang; tall: boolean }) {
	const t = tr(lang);
	const id = tall ? "arch-tall" : "arch-wide";
	// Styled by class (globals.css, .arch): the diagram is drawn twice (wide and tall), so every byte counts twice.
	const box = (x: number, y: number, w: number, title: string, sub: string, strong = false) => (
		<g className={strong ? "s" : undefined}>
			<rect x={x} y={y} width={w} height="64" rx="10" />
			<text x={x + 16} y={y + 27} className="t1">
				{title}
			</text>
			<text x={x + 16} y={y + 46} className="t2">
				{sub}
			</text>
		</g>
	);
	const ai = (x: number, y: number, w: number, sub: string) => (
		<g className="ai">
			<rect x={x} y={y} width={w} height={tall ? 64 : 52} rx="10" />
			<text x={x + 16} y={y + 23} className="t1">
				{t("Sección de IA", "AI section")}
			</text>
			<text x={x + 16} y={y + 40} className="t2">
				{sub}
			</text>
		</g>
	);
	const arrow = (d: string, dashed = false) => (
		<path d={d} className={dashed ? "a d" : "a"} markerEnd={`url(#${id}-head)`} />
	);
	const sources = box(
		0,
		tall ? 0 : 40,
		tall ? 360 : 160,
		t("Fuentes públicas", "Public sources"),
		`${num(lang, facts.sources)} ${t("fuentes", "sources")}`,
	);
	return (
		<svg
			viewBox={tall ? "0 0 360 664" : "0 0 1080 330"}
			className={`arch ${tall ? "mx-auto h-auto w-full max-w-[360px] lg:hidden" : "hidden h-auto w-full lg:block"}`}
			role="img"
			aria-labelledby={`${id}-title ${id}-desc`}
		>
			<title id={`${id}-title`}>{t("Arquitectura de Vigía", "Vigía's architecture")}</title>
			<desc id={`${id}-desc`}>
				{t(
					"Las fuentes públicas pasan por un cliente HTTP con reintentos y ritmo por servidor hacia los adaptadores, que un planificador con cortacircuitos ejecuta. Los adaptadores guardan observaciones en SQLite. De ahí salen los paneles, calculados en código, y los incidentes y el archivo sellado. Una API HTTP con flujo en vivo los sirve al cliente Preact. La sección de IA es opcional.",
					"Public sources go through an HTTP client with retries and per-host pacing into the adapters, which a scheduler with circuit breakers runs. Adapters store observations in SQLite. From there come the panels, computed in code, and the incidents and sealed archive. An HTTP API with a live stream serves them to the Preact client. The AI section is optional.",
				)}
			</desc>
			<defs>
				<marker
					id={`${id}-head`}
					viewBox="0 0 8 8"
					refX="7"
					refY="4"
					markerWidth="7"
					markerHeight="7"
					orient="auto"
				>
					<path d="M0 0 8 4 0 8z" />
				</marker>
			</defs>
			{tall ? (
				<>
					{sources}
					{box(0, 100, 360, "HttpClient", t("reintentos · ritmo", "retries · pacing"))}
					{box(0, 200, 170, t("Adaptadores", "Adapters"), "fetch → normalise", true)}
					{box(190, 200, 170, t("Planificador", "Scheduler"), t("cortacircuitos", "breakers"))}
					{box(0, 300, 226, "SQLite", t("observaciones + historia", "observations + history"))}
					{ai(242, 300, 118, t("opcional", "optional"))}
					{box(0, 400, 170, t("Paneles", "Panels"), t("cálculo en código", "computed in code"))}
					{box(190, 400, 170, t("Incidentes", "Incidents"), t("+ archivo sellado", "+ sealed archive"))}
					{box(
						0,
						500,
						360,
						t("API HTTP + SSE", "HTTP API + SSE"),
						t("límites · /api/v1", "limits · /api/v1"),
						true,
					)}
					{box(0, 600, 360, t("Cliente Preact", "Preact client"), t("teléfono primero", "phone first"))}
					{arrow("M180 64V96")}
					{arrow("M85 164V196")}
					{arrow("M190 232H174")}
					{arrow("M85 264V296")}
					{arrow("M226 332H238", true)}
					{arrow("M85 364V396")}
					{arrow("M190 364L262 396")}
					{arrow("M85 464V496")}
					{arrow("M275 464V496")}
					{arrow("M180 564V596")}
				</>
			) : (
				<>
					{sources}
					{box(196, 40, 170, "HttpClient", t("reintentos · ritmo", "retries · pacing"))}
					{box(402, 40, 180, t("Adaptadores", "Adapters"), "fetch → normalise", true)}
					{box(
						382,
						180,
						220,
						t("Planificador", "Scheduler"),
						t("intervalos · cortacircuitos", "intervals · breakers"),
					)}
					{box(618, 40, 200, "SQLite", t("observaciones + historia", "observations + history"))}
					{box(858, 0, 222, t("Paneles", "Panels"), t("cálculo determinista", "deterministic compute"))}
					{box(858, 84, 222, t("Incidentes", "Incidents"), t("+ archivo sellado", "+ sealed archive"))}
					{box(
						858,
						250,
						222,
						t("API HTTP + SSE", "HTTP API + SSE"),
						t("límites · /api/v1", "limits · /api/v1"),
						true,
					)}
					{box(618, 250, 200, t("Cliente Preact", "Preact client"), t("teléfono primero", "phone first"))}
					{ai(618, 160, 200, t("opcional, etiquetada", "optional, labelled"))}
					{arrow("M160 72H192")}
					{arrow("M366 72H398")}
					{arrow("M492 180V108")}
					{arrow("M582 72H614")}
					{arrow("M818 62L854 36")}
					{arrow("M818 82L854 110")}
					{arrow("M718 104V156", true)}
					{arrow("M969 148V246")}
					{arrow("M858 282H822")}
				</>
			)}
		</svg>
	);
}

export function Developers({ lang }: { lang: Lang }) {
	const t = tr(lang);
	const stack = [
		"Bun",
		t("TypeScript estricto", "Strict TypeScript"),
		"Preact + signals",
		"SQLite",
		"Zod",
		t("SVG hecho a mano", "Hand-built SVG"),
		"SSE",
		`${num(lang, facts.tests)} ${t("pruebas", "tests")}`,
	];
	const steps = [
		t("Lee los términos y límites de la fuente.", "Read the source's terms and rate limits."),
		t(
			"Crea src/adapters/<id>/index.ts con el contrato, y regístralo.",
			"Create src/adapters/<id>/index.ts with the contract, and register it.",
		),
		t(
			"Graba una respuesta real con scripts/record-fixture.ts y escribe las pruebas.",
			"Record a real response with scripts/record-fixture.ts and write the tests.",
		),
		t(
			"bun run check: formato, lint, tipos, pruebas y build. En verde.",
			"bun run check: format, lint, types, tests and build. Green.",
		),
	];
	return (
		<Section
			id="desarrolladores"
			index="07"
			eyebrow={t("Para desarrolladores", "For developers")}
			title={t(
				"Un proceso, un contrato, cada fuente probada.",
				"One process, one contract, every source tested.",
			)}
			lede={t(
				"Un solo proceso de Bun lee las fuentes por adaptadores, guarda cada observación en SQLite con su historia, calcula cada panel en código probado y sirve un cliente pequeño por HTTP y eventos en vivo.",
				"One Bun process reads sources through adapters, stores every observation in SQLite with its history, computes each panel in tested code and serves a small client over HTTP and live events.",
			)}
		>
			<Reveal className="card mt-14 p-5 sm:p-8">
				<Architecture lang={lang} tall={false} />
				<Architecture lang={lang} tall />
			</Reveal>

			<div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
				<Reveal className="frame min-w-0">
					<div className="flex items-center justify-between gap-3 border-b border-line bg-surface-1 px-4 py-2.5">
						<p className="data text-[0.75rem] text-text-2">src/core/types.ts</p>
						<a
							className="text-[0.75rem] text-text-3 transition-colors hover:text-text"
							href={blob("src/core/types.ts")}
							target="_blank"
							rel="noopener noreferrer"
						>
							{t("ver en GitHub", "view on GitHub")}
						</a>
					</div>
					<Scroll
						label={t("El contrato de un adaptador, en TypeScript", "An adapter's contract, in TypeScript")}
					>
						<pre
							className="code w-fit min-w-full bg-surface-0 p-5 text-text-2 sm:p-6"
							// biome-ignore lint/security/noDangerouslySetInnerHtml: escaped, built at build time from src/core/types.ts
							dangerouslySetInnerHTML={{
								__html: `${tsHtml(contracts.adapter)}\n\n${tsHtml(contracts.observation)}`,
							}}
						/>
					</Scroll>
				</Reveal>
				<div className="flex min-w-0 flex-col gap-6">
					<Reveal delay={0.05} className="card p-6 sm:p-7">
						<h3 className="text-[1.125rem] font-semibold">{t("Agregar una fuente", "Adding a source")}</h3>
						<ol className="mt-4 space-y-3">
							{steps.map((s, i) => (
								<li key={s} className="flex gap-3 text-[0.9375rem] text-text-2">
									<span className="data mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line-strong text-[0.75rem] text-text-2">
										{i + 1}
									</span>
									<span>{s}</span>
								</li>
							))}
						</ol>
						<a
							className="group mt-5 inline-flex items-center gap-1.5 text-[0.9375rem] font-medium text-text"
							href={blob("docs/ADAPTERS.md")}
							target="_blank"
							rel="noopener noreferrer"
						>
							{t("La guía completa", "The full guide")}
							<span className="transition-transform group-hover:translate-x-0.5">
								<Arrow />
							</span>
						</a>
					</Reveal>
					<Reveal delay={0.1} className="card p-6 sm:p-7">
						<h3 className="text-[1.125rem] font-semibold">
							{t("Con qué está hecho", "What it is built with")}
						</h3>
						<ul className="mt-4 flex flex-wrap gap-2">
							{stack.map((s) => (
								<li key={s} className="chip">
									{s}
								</li>
							))}
						</ul>
						<div className="mt-6 flex flex-wrap gap-3">
							<a
								className="btn btn-ghost !h-10 text-[0.875rem]"
								href={blob("CONTRIBUTING.md")}
								target="_blank"
								rel="noopener noreferrer"
							>
								{t("Cómo contribuir", "How to contribute")}
							</a>
							<a
								className="btn btn-ghost !h-10 text-[0.875rem]"
								href={blob("docs/ARCHITECTURE.md")}
								target="_blank"
								rel="noopener noreferrer"
							>
								{t("Arquitectura", "Architecture")}
							</a>
							<a
								className="btn btn-ghost !h-10 text-[0.875rem]"
								href={REPO}
								target="_blank"
								rel="noopener noreferrer"
							>
								<GitHubIcon />
								{t("Código", "Code")}
							</a>
						</div>
					</Reveal>
				</div>
			</div>
		</Section>
	);
}
