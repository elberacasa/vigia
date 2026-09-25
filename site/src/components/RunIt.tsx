import { apiFigure, capturedAt, facts, terminal } from "@/lib/data";
import { jsonHtml, terminalHtml } from "@/lib/highlight";
import { blob, type Lang, num, REPO, tr, when } from "@/lib/i18n";
import { CopyButton } from "./CopyButton";
import { type Install, InstallTabs } from "./InstallTabs";
import { Reveal } from "./Reveal";
import { Scroll } from "./Scroll";
import { Section } from "./Section";

/** Trusted markup built on the server from the repository's own captures (see lib/highlight). */
function Code({ html, className, label }: { html: string; className: string; label: string }) {
	return (
		<Scroll label={label}>
			{/* biome-ignore lint/security/noDangerouslySetInnerHtml: escaped, built at build time from our own files */}
			<pre className={`code w-fit min-w-full p-5 ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
		</Scroll>
	);
}

function Window({
	title,
	children,
	copy,
	lang,
}: {
	title: string;
	children: React.ReactNode;
	copy: string;
	lang: Lang;
}) {
	return (
		<div className="frame flex min-w-0 flex-col">
			<div className="flex items-center gap-3 border-b border-line bg-surface-1 py-2 pl-4 pr-2">
				<p className="data min-w-0 flex-1 truncate text-[0.75rem] text-text-2">
					<span className="select-none text-text-3">$ </span>
					{title}
				</p>
				<CopyButton lang={lang} text={copy} />
			</div>
			<div className="min-w-0 flex-1 bg-surface-0">{children}</div>
		</div>
	);
}

/** The release's archive for a target, as its notes list it (facts.release, from docs/releases/v<version>.md). */
function archive(target: string) {
	const f = facts.release.find((r) => r.target === target);
	if (!f) throw new Error(`RunIt: the release notes list no archive for ${target}`);
	return f;
}

export function RunIt({ lang }: { lang: Lang }) {
	const t = tr(lang);
	const v = facts.version;
	const api = apiFigure();
	const download = (target: string) => {
		const f = archive(target);
		return {
			href: `${REPO}/releases/download/v${v}/${f.file}`,
			file: f.file,
			size: `${num(lang, f.mb)} MB`,
		};
	};
	const folder = (target: string) => `vigia-${v}-${target}`;
	const tarRun = (target: string, mac = false) =>
		[
			`tar -xf ${archive(target).file}`,
			...(mac ? [`xattr -dr com.apple.quarantine ${folder(target)}`] : []),
			`./${folder(target)}/vigia`,
		].join("\n");
	const Cmd = ({ children }: { children: string }) => (
		<code className="data text-[0.8125rem] text-text">{children}</code>
	);
	const checksum = (command: string) => (
		<p>
			<span className="font-medium text-text">{t("Comprueba la descarga: ", "Check your download: ")}</span>
			{t(
				"baja también SHA256SUMS de la misma versión y, en la misma carpeta, ejecuta ",
				"also get SHA256SUMS from the same release and, in the same folder, run ",
			)}
			<Cmd>{command}</Cmd>
			{t(". Debe decir OK.", ". It should say OK.")}
		</p>
	);
	const tabs: Install[] = [
		{
			id: "windows",
			label: "Windows",
			intro: t(
				"Descarga el .zip, haz clic derecho → «Extraer todo» y abre vigia.exe dentro de la carpeta. O, en PowerShell, desde la carpeta de descargas:",
				"Download the .zip, right-click → “Extract All” and open vigia.exe inside the folder. Or, in PowerShell, from your downloads folder:",
			),
			variants: [
				{
					id: "x64",
					label: "x64",
					download: download("windows-x64"),
					command: `Expand-Archive ${archive("windows-x64").file} .\n.\\${folder("windows-x64")}\\vigia.exe`,
				},
			],
			after: (
				<>
					<p>
						<span className="font-medium text-text">{t("Primera vez: ", "First run: ")}</span>
						{t(
							"el archivo aún no está firmado por Microsoft, así que SmartScreen puede decir «Windows protegió tu PC». Elige «Más información» → «Ejecutar de todas formas». Si la ventana se cierra sola, ábrelo desde PowerShell para leer el mensaje (por ejemplo, el puerto 7722 ocupado: usa --port 8080).",
							"the file is not signed by Microsoft yet, so SmartScreen may say “Windows protected your PC”. Choose “More info” → “Run anyway”. If the window closes by itself, run it from PowerShell to read the message (for example, port 7722 taken: use --port 8080).",
						)}
					</p>
					<p>
						<span className="font-medium text-text">
							{t("Comprueba la descarga: ", "Check your download: ")}
						</span>
						<Cmd>{`Get-FileHash .\\${archive("windows-x64").file}`}</Cmd>
						{t(
							" y compara el resultado con su línea en SHA256SUMS, adjunto a la misma versión.",
							" and compare the result with its line in SHA256SUMS, attached to the same release.",
						)}
					</p>
				</>
			),
		},
		{
			id: "macos",
			label: "macOS",
			intro: t(
				"Descarga el archivo de tu Mac y, en Terminal, desde la carpeta de descargas:",
				"Download the file for your Mac and, in Terminal, from your downloads folder:",
			),
			variants: [
				{
					id: "arm64",
					label: t("Apple silicon (M1 o más nuevo)", "Apple silicon (M1 or newer)"),
					download: download("darwin-arm64"),
					command: tarRun("darwin-arm64", true),
				},
				{
					id: "x64",
					label: "Intel",
					download: download("darwin-x64"),
					command: tarRun("darwin-x64", true),
				},
			],
			after: (
				<>
					<p>
						<span className="font-medium text-text">{t("Primera vez: ", "First run: ")}</span>
						{t(
							"el archivo aún no está firmado por Apple. La línea xattr le quita a la carpeta la marca de «descargado de internet», y macOS lo deja abrir. Sin ella, macOS dice que no puede verificar al desarrollador: abre Configuración del Sistema → Privacidad y seguridad y elige «Abrir de todos modos».",
							"the file is not signed by Apple yet. The xattr line removes the folder's “downloaded from the internet” mark, and macOS lets it open. Without it, macOS says it cannot verify the developer: open System Settings → Privacy & Security and choose “Open Anyway”.",
						)}
					</p>
					{checksum("shasum -a 256 -c SHA256SUMS --ignore-missing")}
				</>
			),
		},
		{
			id: "linux",
			label: "Linux",
			intro: t(
				"Descarga el archivo de tu equipo y, en una terminal, desde la carpeta de descargas:",
				"Download the file for your machine and, in a terminal, from your downloads folder:",
			),
			variants: [
				{ id: "x64", label: "x64", download: download("linux-x64"), command: tarRun("linux-x64") },
				{
					id: "arm64",
					label: "ARM64",
					download: download("linux-arm64"),
					command: tarRun("linux-arm64"),
				},
			],
			after: checksum("sha256sum -c SHA256SUMS --ignore-missing"),
		},
		{
			id: "source",
			label: t("Código fuente", "From source"),
			intro: t(
				"Con Bun 1.4 o más reciente, en Linux, macOS o Windows.",
				"With Bun 1.4 or newer, on Linux, macOS or Windows.",
			),
			variants: [
				{
					id: "bun",
					label: "Bun",
					command: `git clone ${REPO}.git\ncd vigia\nbun install\nbun run build:web\nbun start`,
				},
			],
		},
		{
			id: "docker",
			label: "Docker",
			intro: t(
				"Para instituciones que publican un espejo público de solo lectura: se construye desde el repositorio, en un contenedor sin privilegios, con el puerto solo en 127.0.0.1; pon un proxy TLS delante.",
				"For institutions publishing a public, read-only mirror: built from the repository, in an unprivileged container, with the port bound to 127.0.0.1; put a TLS proxy in front.",
			),
			variants: [
				{
					id: "compose",
					label: "Compose",
					command: `git clone ${REPO}.git\ncd vigia\ndocker compose up -d`,
				},
			],
			after: (
				<p>
					{t("Detalles: ", "Details: ")}
					<a className="link" href={blob("docs/OPERATIONS.md")} target="_blank" rel="noopener noreferrer">
						docs/OPERATIONS.md
					</a>
				</p>
			),
		},
	];
	const sizes = facts.release.map((r) => r.mb);
	return (
		<Section
			id="instalar"
			index="05"
			eyebrow={t("Córrelo tú", "Run it yourself")}
			title={t("Un archivo. Sin cuenta. Sin claves.", "One file. No account. No keys.")}
			lede={t(
				`Con cero claves, ${num(lang, facts.keyless)} fuentes empiezan a llenar la pantalla en uno o dos minutos. Las claves opcionales (NASA FIRMS gratis; Jev o Anthropic con el presupuesto que fijes) se agregan desde la guía (/guia) y nunca salen de tu equipo salvo hacia su servicio.`,
				`With zero keys, ${num(lang, facts.keyless)} sources start filling the screen within a minute or two. Optional keys (NASA FIRMS, free; Jev or Anthropic within a budget you set) are added from the guide (/guia) and never leave your machine except to their own service.`,
			)}
		>
			<div className="mt-14 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
				<Reveal className="flex min-w-0 flex-col gap-4">
					<InstallTabs
						lang={lang}
						tabs={tabs}
						phoneNote={t(
							"Vigía se instala en una computadora. Desde el teléfono lo abres por la red de tu casa (con --host 0.0.0.0 en la computadora) o en un espejo público.",
							"Vigía installs on a computer. From a phone, you open it over your home network (with --host 0.0.0.0 on the computer) or on a public mirror.",
						)}
					/>
					<p className="text-[0.8125rem] leading-relaxed text-text-3">
						{t(
							`Archivos de ${num(lang, Math.min(...sizes))} a ${num(lang, Math.max(...sizes))} MB, sin instalar nada más; cada uno trae una carpeta con el programa, LICENSE y NOTICE. Windows y macOS son nuevos: cada archivo arranca y responde en una prueba automática en su sistema antes de publicarse, pero aún pocas personas los han usado. Si algo falla, `,
							`Files of ${num(lang, Math.min(...sizes))} to ${num(lang, Math.max(...sizes))} MB, nothing else to install; each holds a folder with the program, LICENSE and NOTICE. Windows and macOS are new: every file starts and answers in an automated test on its own system before it is published, but few people have used them yet. If something fails, `,
						)}
						<a className="link" href={`${REPO}/issues`} target="_blank" rel="noopener noreferrer">
							{t("abre un issue", "open an issue")}
						</a>
						{t(" con lo que imprime la terminal.", " with what the terminal prints.")}
					</p>
				</Reveal>
				<Reveal delay={0.06} className="min-w-0">
					<div className="card h-full p-6 sm:p-7">
						<h3 className="text-[1.0625rem] font-semibold">
							{t("Todo en tu equipo", "Everything on your machine")}
						</h3>
						<ul className="mt-3 space-y-2 text-[0.9375rem] text-text-2">
							<li>
								{t(
									"Tu historial queda en una base SQLite local, sellada cada día en una cadena SHA-256 que ",
									"Your history stays in a local SQLite database, sealed every day into a SHA-256 chain that ",
								)}
								<code className="data text-[0.875rem] text-text">vigia verify</code>
								{t(" comprueba sin conexión.", " checks offline.")}
							</li>
							<li>
								{t(
									"Abre Vigía en otros equipos de tu red con ",
									"Open Vigía on other devices on your network with ",
								)}
								<code className="data text-[0.875rem] text-text">--host 0.0.0.0</code>
								{t(
									"; la configuración solo cambia desde tu computadora.",
									"; settings only change from your computer.",
								)}
							</li>
							<li>
								{t("Guía completa: ", "Full guide: ")}
								<a className="link" href={blob("docs/SETUP.md")} target="_blank" rel="noopener noreferrer">
									docs/SETUP.md
								</a>
							</li>
							<li>
								<strong className="font-semibold text-text">
									{t("¿Tienes un agente de IA? ", "Have an AI coding agent? ")}
								</strong>
								<a
									className="link"
									href={blob("docs/AGENT-SETUP.md")}
									target="_blank"
									rel="noopener noreferrer"
								>
									{t("Pégale esto", "Paste this into it")}
								</a>
								{t(
									": descarga el archivo correcto, comprueba su suma, lo abre y nunca te pide claves por el chat.",
									": it downloads the right file, checks its checksum, opens it, and never asks for your keys in the chat.",
								)}
							</li>
						</ul>
					</div>
				</Reveal>
			</div>
			<Reveal className="mt-16 grid gap-8 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
				<div className="flex flex-col justify-center">
					<h3 className="text-[1.375rem] font-semibold tracking-[-0.015em]">
						{t("También en la terminal", "In the terminal, too")}
					</h3>
					<p className="mt-3 text-[0.9375rem] leading-relaxed text-text-2">
						{t(
							"Sin navegador: curl localhost:7722 imprime la situación en texto plano, 80 columnas, cada línea con su fuente y la edad del dato. Útil en un servidor, por SSH o con una conexión mala.",
							"No browser needed: curl localhost:7722 prints the situation as plain text, 80 columns, every line with its source and the age of its data. Handy on a server, over SSH or on a bad connection.",
						)}
					</p>
				</div>
				<Window lang={lang} title="curl localhost:7722" copy="curl localhost:7722">
					<Code
						html={terminalHtml(terminal(lang).trimEnd())}
						className="text-[0.75rem] leading-[1.6] text-text-2"
						label={t("Salida de curl localhost:7722", "Output of curl localhost:7722")}
					/>
				</Window>
			</Reveal>
			<Reveal className="mt-16 grid gap-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
				<div className="flex flex-col justify-center">
					<h3 className="text-[1.375rem] font-semibold tracking-[-0.015em]">
						{t("Una API abierta y versionada", "An open, versioned API")}
					</h3>
					<p className="mt-3 text-[0.9375rem] leading-relaxed text-text-2">
						{t(
							"Tu Vigía sirve cada panel, cada fuente y cada serie con su historia en /api/v1, en JSON o CSV, con OpenAPI y límites de uso. Cada cifra tomada de una fuente lleva su fuente, su licencia y sus dos horas (cuándo valía y cuándo llegó); las calculadas nombran las fuentes de su panel.",
							"Your Vigía serves every panel, source and series with its history at /api/v1, as JSON or CSV, with OpenAPI and rate limits. Every figure taken from a source carries its source, its licence and both times (when it was valid and when it arrived); computed ones name their panel's sources.",
						)}
					</p>
					<p className="mt-3 text-[0.9375rem] text-text-2">
						<a className="link" href={blob("docs/API.md")} target="_blank" rel="noopener noreferrer">
							docs/API.md
						</a>
					</p>
				</div>
				<Window
					lang={lang}
					title="curl -s localhost:7722/api/v1/panels/money/figures | jq '.figures[0]'"
					copy="curl -s localhost:7722/api/v1/panels/money/figures | jq '.figures[0]'"
				>
					<Code
						html={jsonHtml(api.raw.trimEnd())}
						className="text-[0.75rem] text-text-2 sm:text-[0.8125rem]"
						label={t("Respuesta JSON de la API", "The API's JSON response")}
					/>
				</Window>
			</Reveal>
			<p className="data mt-4 text-[0.75rem] text-text-3">
				{t(
					`Salidas reales de Vigía, capturadas el ${when(lang, capturedAt)} (hora de Caracas).`,
					`Real output from Vigía, captured on ${when(lang, capturedAt)} (Caracas time).`,
				)}
			</p>
		</Section>
	);
}
