import { mkdtempSync } from "node:fs";
import { setPriority, tmpdir } from "node:os";
import { join } from "node:path";
import { parsePpm, type Rgba } from "../imaging/raster.ts";

/**
 * Decoding one video keyframe into a small still: an OPTIONAL capability. Vigía ships as one binary with no native
 * modules, and H.264 has no pure-TypeScript decoder worth shipping, so a still needs `ffmpeg` on the machine
 * (found on PATH, or named by VIGIA_FFMPEG; VIGIA_FFMPEG=0 turns it off). Without it every TV card shows the
 * channel's logo and says so; nothing pretends.
 *
 * Why not pure TypeScript (measured 2026-09-28 on the 37 live H.264 streams of iptv-org's Venezuela list): 17 are
 * (Constrained) Baseline, which a CAVLC intra-only decoder could handle, but 18 are High and 2 Main profile, which
 * need CABAC, 8×8 transforms and scaling matrices: a full intra decoder, thousands of lines to write, verify and
 * keep correct, for a thumbnail. Demuxing (finding the keyframe's bytes) IS pure TypeScript (ts-keyframe.ts), so
 * the decoder sees exactly one validated access unit.
 *
 * What ffmpeg is allowed to do, since the bytes come from servers Vigía does not control: read only the raw H.264
 * we extracted, from a pipe (`-protocol_whitelist pipe`, `-f h264`, `-c:v h264`: no container demuxer, no network,
 * no other codec), one thread, one frame, a capped allocation size, killed after 10 s, output a raw PPM of at most
 * 480 × 480 that our own code then re-encodes. Lower CPU priority than the server, an environment with only PATH
 * (and SystemRoot on Windows), an empty working directory, and on Linux `prlimit` limits (below). It still runs as
 * the Vigía user: a sandbox (bwrap, a container) is the operator's choice (SECURITY.md).
 */

export type Decoder = { readonly path: string; readonly version: string };

const MAX_OUT_SIDE = 480;
const TIMEOUT_MS = 10_000;
const MAX_STDOUT = MAX_OUT_SIDE * MAX_OUT_SIDE * 3 + 64;

let cached: { decoder: Decoder | null; at: number } | null = null;

/** The ffmpeg this machine offers, or null. Looked up once an hour (installing it later needs no restart). */
export function findDecoder(
	env: Record<string, string | undefined> = process.env,
	now = Date.now(),
): Decoder | null {
	if (cached && now - cached.at < 3_600_000) return cached.decoder;
	const setting = env.VIGIA_FFMPEG?.trim();
	let decoder: Decoder | null = null;
	if (setting !== "0" && setting !== "off") {
		const path = setting ? setting : Bun.which("ffmpeg");
		if (path) {
			try {
				const out = Bun.spawnSync([path, "-hide_banner", "-version"], { stdout: "pipe", stderr: "ignore" });
				const first = new TextDecoder().decode(out.stdout).split("\n")[0] ?? "";
				const version = /^ffmpeg version (\S+)/.exec(first)?.[1];
				if (out.exitCode === 0 && version) decoder = { path, version: version.slice(0, 40) };
			} catch {
				decoder = null;
			}
		}
	}
	cached = { decoder, at: now };
	return decoder;
}

/** Tests only: forget the lookup. */
export function resetDecoderCache(): void {
	cached = null;
}

/** The arguments, fixed: nothing from the network ever reaches this list. */
export function ffmpegArgs(width: number): string[] {
	const w = Math.max(16, Math.min(MAX_OUT_SIDE, Math.round(width / 2) * 2));
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-xerror",
		"-max_alloc",
		"134217728",
		"-threads",
		"1",
		"-filter_threads",
		"1",
		"-protocol_whitelist",
		"pipe",
		"-f",
		"h264",
		"-c:v",
		"h264",
		"-i",
		"pipe:0",
		"-frames:v",
		"1",
		"-an",
		"-vf",
		// Deinterlace only frames flagged interlaced; display aspect kept; height capped.
		`yadif=deint=interlaced,scale=${w}:'min(${MAX_OUT_SIDE},trunc(${w}/dar/2)*2)':flags=area,setsar=1`,
		"-pix_fmt",
		"rgb24",
		"-c:v",
		"ppm",
		"-f",
		"image2pipe",
		"pipe:1",
	];
}

/**
 * On Linux, `prlimit` (util-linux) caps the decoder's address space (1 GB), CPU time (10 s) and open files (32), so a
 * decoder bug fed a hostile bitstream cannot take the machine's memory or run away; elsewhere the 10 s kill and
 * `-max_alloc` remain. Found once per process.
 */
let prlimit: string | null | undefined;
export function limiter(): string[] {
	if (prlimit === undefined) prlimit = process.platform === "linux" ? Bun.which("prlimit") : null;
	return prlimit ? [prlimit, "--as=1073741824", "--cpu=10", "--nofile=32", "--"] : [];
}

let dir: string | null = null;
function workDir(): string {
	if (!dir) dir = mkdtempSync(join(tmpdir(), "vigia-decode-"));
	return dir;
}

/** One at a time: a round of 40 stills costs ~1.3 s of one core, never 40 processes at once. */
let queue: Promise<unknown> = Promise.resolve();

export type DecodeResult =
	| { ok: true; image: Rgba; cpuMs: number }
	| { ok: false; reason: string; cpuMs: number };

/** Decode one H.264 keyframe (Annex B) to an RGBA image `width` wide (at most 480 × 480). */
export function decodeKeyframe(
	decoder: Decoder,
	annexB: Uint8Array,
	width = MAX_OUT_SIDE,
	signal?: AbortSignal,
): Promise<DecodeResult> {
	const run = queue.then(() => runDecode(decoder, annexB, width, signal));
	queue = run.catch(() => undefined);
	return run;
}

async function runDecode(
	decoder: Decoder,
	annexB: Uint8Array,
	width: number,
	signal?: AbortSignal,
): Promise<DecodeResult> {
	const t0 = performance.now();
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn([...limiter(), decoder.path, ...ffmpegArgs(width)], {
			// An empty directory of its own: nothing to read or write where it runs.
			cwd: workDir(),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			// Nothing of ours: only what the OS needs to start a program (Windows needs SystemRoot).
			env: Object.fromEntries(
				Object.entries({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }).filter(
					(e): e is [string, string] => typeof e[1] === "string",
				),
			),
		});
	} catch {
		return { ok: false, reason: "decoder-start", cpuMs: 0 };
	}
	try {
		setPriority(proc.pid, 10);
	} catch {
		// Not permitted or not supported: it still runs, one at a time.
	}
	const kill = () => proc.kill(9);
	const timer = setTimeout(kill, TIMEOUT_MS);
	signal?.addEventListener("abort", kill, { once: true });
	try {
		const stdin = proc.stdin as import("bun").FileSink;
		stdin.write(annexB);
		await stdin.end();
		const [out, code] = await Promise.all([
			readCapped(proc.stdout as ReadableStream<Uint8Array>, MAX_STDOUT),
			proc.exited,
			readCapped(proc.stderr as ReadableStream<Uint8Array>, 4_096),
		]);
		const cpuMs = cpuTime(proc, t0);
		if (code !== 0 || out === null)
			return { ok: false, reason: code === 137 || code === null ? "decoder-timeout" : "decode-error", cpuMs };
		const image = parsePpm(out, MAX_OUT_SIDE, MAX_OUT_SIDE);
		return image ? { ok: true, image, cpuMs } : { ok: false, reason: "decode-output", cpuMs };
	} catch {
		kill();
		return { ok: false, reason: "decode-error", cpuMs: cpuTime(proc, t0) };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", kill);
	}
}

function cpuTime(proc: ReturnType<typeof Bun.spawn>, t0: number): number {
	const usage = proc.resourceUsage();
	if (usage) return Math.round((Number(usage.cpuTime.user) + Number(usage.cpuTime.system)) / 1_000);
	return Math.round(performance.now() - t0);
}

/** Reads a stream to its end; null when it goes past `cap` (then the rest is discarded). */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array | null> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	let over = false;
	for await (const chunk of stream) {
		if (over) continue;
		size += chunk.byteLength;
		if (size > cap) {
			over = true;
			continue;
		}
		chunks.push(chunk);
	}
	if (over) return null;
	const out = new Uint8Array(size);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}
