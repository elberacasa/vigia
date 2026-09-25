/**
 * Builds one self-contained executable per OS with the web client embedded:
 *   bun scripts/build-bin.ts            → all targets into dist/
 *   bun scripts/build-bin.ts linux-x64  → one target
 * Users download one file and run it; no Bun, Node or Docker needed.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"] as const;
const wanted = process.argv[2] ? TARGETS.filter((t) => t === process.argv[2]) : TARGETS;
if (wanted.length === 0) {
	console.error(`Objetivo desconocido. Opciones: ${TARGETS.join(", ")}`);
	process.exit(1);
}

await Bun.$`bun ${join(root, "scripts", "build-web.ts")}`.env({ ...process.env, QUIET: "1" });

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = join(dir, name);
		return statSync(full).isDirectory() ? files(full) : [full];
	});
}
const dist = join(root, "web", "dist");
const web = files(dist);
const pkg = (await Bun.file(join(root, "package.json")).json()) as { version: string };

// Embed each built file verbatim (type: "file"), keyed by its URL path.
const genPath = join(root, "src", "server", "embedded.gen.ts");
const stub = await Bun.file(genPath).text();
const imports = web.map(
	(f, i) =>
		`import f${i} from ${JSON.stringify(relative(join(root, "src", "server"), f))} with { type: "file" };`,
);
const entries = web.map(
	(f, i) => `\t${JSON.stringify(`/${relative(dist, f).split("\\").join("/")}`)}: f${i},`,
);
await Bun.write(
	genPath,
	`${imports.join("\n")}\nexport const EMBEDDED: Readonly<Record<string, string>> = {\n${entries.join("\n")}\n};\n`,
);

for (const target of wanted) {
	const out = join(
		root,
		"dist",
		`vigia-${pkg.version}-${target}${target.startsWith("windows") ? ".exe" : ""}`,
	);
	const started = performance.now();
	try {
		await Bun.$`bun build --compile --minify --sourcemap=none --target=bun-${target} ${join(root, "src", "cli.ts")} --outfile ${out}`
			.cwd(root)
			.quiet();
	} catch (error) {
		await Bun.write(genPath, stub);
		throw error;
	}
	const mb = (statSync(out).size / 1024 / 1024).toFixed(1);
	console.log(`${relative(root, out)}  ${mb} MB  ${Math.round(performance.now() - started)} ms`);
}
// Always leave the committed stub in place.
await Bun.write(genPath, stub);
