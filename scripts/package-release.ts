/**
 * Packs the built executables for download on slow connections, and writes the checksums:
 *   bun scripts/package-release.ts [dist]      default: dist/
 *
 * For every `vigia-<version>-<target>[.exe]` in the folder:
 * - linux and darwin → `vigia-<version>-<target>.tar.xz` (xz -9: about 23 % smaller than gzip -9 on these files,
 *   measured on linux-x64; `tar -xf` opens it on Linux and macOS, and so does macOS's Archive Utility),
 * - windows → `vigia-<version>-<target>.zip` (opened by Windows Explorer with no extra software).
 * Each archive holds one folder, `vigia-<version>-<target>/`, with the executable (`vigia` with its executable bit,
 * or `vigia.exe`), LICENSE and NOTICE. Entries are sorted, owned by 0:0 and dated to the release commit
 * (SOURCE_DATE_EPOCH, else the last commit), so the same binaries give the same archives.
 * `SHA256SUMS` then covers every raw executable and every archive, in `sha256sum` format.
 *
 * Needs GNU tar, xz and zip (Linux; the release workflow packs on ubuntu).
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BINARY = /^vigia-(\d+\.\d+\.\d+(?:-[\w.]+)?)-((?:linux|darwin|windows)-(?:x64|arm64))(\.exe)?$/;

export interface Packed {
	readonly binary: string;
	readonly archive: string;
}

function sh(cmd: readonly string[], cwd: string): void {
	// TZ=UTC: zip stores local times, so the archive would otherwise depend on the machine's time zone.
	const r = Bun.spawnSync([...cmd], {
		cwd,
		stderr: "pipe",
		stdout: "pipe",
		env: { ...process.env, TZ: "UTC" },
	});
	if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr.toString().trim()}`);
}

function sourceEpoch(): number {
	const env = process.env.SOURCE_DATE_EPOCH;
	if (env && /^\d+$/.test(env)) return Number(env);
	const r = Bun.spawnSync(["git", "log", "-1", "--format=%ct"], { cwd: ROOT });
	const out = r.stdout.toString().trim();
	return r.exitCode === 0 && /^\d+$/.test(out) ? Number(out) : 0;
}

export function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Packs every executable in `dist` and rewrites `dist/SHA256SUMS`. Returns what was packed. */
export function packageRelease(
	dist: string,
	docs: { licence: string; notice: string },
	epoch: number,
): Packed[] {
	const binaries = readdirSync(dist)
		.filter((f) => BINARY.test(f))
		.sort();
	if (binaries.length === 0) throw new Error(`no vigia-<version>-<target> executables in ${dist}`);
	const staging = join(dist, ".staging");
	const packed: Packed[] = [];
	for (const binary of binaries) {
		const m = BINARY.exec(binary);
		if (!m) continue;
		const windows = m[3] === ".exe";
		const folder = binary.replace(/\.exe$/, "");
		rmSync(staging, { recursive: true, force: true });
		const dir = join(staging, folder);
		mkdirSync(dir, { recursive: true });
		const exe = join(dir, windows ? "vigia.exe" : "vigia");
		copyFileSync(join(dist, binary), exe);
		copyFileSync(docs.licence, join(dir, "LICENSE"));
		copyFileSync(docs.notice, join(dir, "NOTICE"));
		chmodSync(exe, 0o755);
		chmodSync(join(dir, "LICENSE"), 0o644);
		chmodSync(join(dir, "NOTICE"), 0o644);
		chmodSync(dir, 0o755);
		for (const p of [exe, join(dir, "LICENSE"), join(dir, "NOTICE"), dir]) utimesSync(p, epoch, epoch);
		const archive = `${folder}${windows ? ".zip" : ".tar.xz"}`;
		const out = join(dist, archive);
		rmSync(out, { force: true });
		if (windows) {
			// -X: no extra attributes (uid, atime), so only content and the fixed dates go in.
			sh(["zip", "-q", "-X", "-9", "-r", out, folder], staging);
		} else {
			const tarPath = join(staging, `${folder}.tar`);
			sh(
				[
					"tar",
					"--sort=name",
					"--owner=0",
					"--group=0",
					"--numeric-owner",
					`--mtime=@${epoch}`,
					"--format=ustar",
					"-cf",
					tarPath,
					folder,
				],
				staging,
			);
			sh(["xz", "-9", "-T1", "--force", tarPath], staging);
			copyFileSync(`${tarPath}.xz`, out);
		}
		packed.push({ binary, archive });
	}
	rmSync(staging, { recursive: true, force: true });
	const files = [...binaries, ...packed.map((p) => p.archive)].sort();
	writeFileSync(join(dist, "SHA256SUMS"), files.map((f) => `${sha256File(join(dist, f))}  ${f}\n`).join(""));
	return packed;
}

if (import.meta.main) {
	const dist = resolve(process.argv[2] ?? join(ROOT, "dist"));
	if (!existsSync(dist)) {
		console.error(`No existe ${dist}. Primero: bun run build:bin`);
		process.exit(1);
	}
	const packed = packageRelease(
		dist,
		{ licence: join(ROOT, "LICENSE"), notice: join(ROOT, "NOTICE") },
		sourceEpoch(),
	);
	const mb = (f: string) => `${(statSync(join(dist, f)).size / 1024 / 1024).toFixed(1)} MB`;
	for (const p of packed)
		console.log(`${p.archive.padEnd(36)} ${mb(p.archive).padStart(8)}  (${mb(p.binary)} sin comprimir)`);
	console.log(`SHA256SUMS: ${packed.length * 2} archivos`);
}
