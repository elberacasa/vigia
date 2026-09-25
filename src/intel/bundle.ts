/**
 * Evidence bundles: one JSON file a journalist can keep. It holds the observations behind an incident (or a
 * panel) with their source links and times, the snapshot shown on screen, the rules, and for each observation a
 * Merkle proof to its day's digest in the archive chain. `vigia verify <file>` checks it offline; comparing its
 * chain digests with /api/archive/digests (or a copy of them kept elsewhere) shows the archive agrees.
 *
 * The file's `sha256` is the SHA-256 of the bundle's canonical JSON without that field: it detects any change
 * to the file, but anyone can recompute it, so it proves integrity against a copy of the hash kept elsewhere.
 *
 * Nothing in the file is trusted by the verifier: every row's hash is recomputed from its fields (the value by its
 * `valueHash` when the value is withheld for its licence), and whether a day is sealed is decided by this machine's
 * archive, never by the file.
 */

import { z } from "zod";
import type { Store } from "../core/store.ts";
import { canonicalJson } from "../core/store.ts";
import type { Json } from "../core/types.ts";
import {
	type ArchivedRow,
	CHAIN_FORMAT,
	CHAIN_FORMAT_V1,
	type ChainEntry,
	chainDigest,
	chainEntry,
	dayHashes,
	fieldsHash,
	type MerkleTree,
	merkleTree,
	type ProofStep,
	proofIn,
	type RawRow,
	ROW_COLUMNS,
	rootFromProof,
	rowHash,
	sealedLeaves,
	sha256,
	toArchived,
	treeRoot,
	utcDay,
	valueHash,
} from "./chain.ts";
import type { ObsRef } from "./incidents.ts";

export { clean } from "./text.ts";

export const BUNDLE_FORMAT = "vigia-evidence/2";
/** Bundles made before rows bound their fields without the value (days sealed with vigia-chain/1). */
export const BUNDLE_FORMAT_V1 = "vigia-evidence/1";
/** A panel bundle carries at most this many observations (the newest of each series). */
export const MAX_BUNDLE_ROWS = 300;
/**
 * Sources whose terms forbid redistributing their data are never shipped in a bundle (the panels show only figures
 * derived from them): RIPEstat (licence "ripestat-no-redistribution"), and any licence whose id
 * says "no-redistribution".
 */
export const NOT_REDISTRIBUTABLE: ReadonlySet<string> = new Set(["ripestat-routing"]);
const redistributable = (row: Pick<ArchivedRow, "source" | "licence">) =>
	!NOT_REDISTRIBUTABLE.has(row.source) && !row.licence.includes("no-redistribution");

/**
 * Licences that allow showing a figure with attribution but not handing out the stored rows: IODA ("All Rights
 * Reserved", permission pending) and the outlets' headlines (title and link are shown; the summary is theirs).
 * For those rows a bundle ships every field but the value, the value's hash, and the proof. The verifier accepts
 * "withheld" only for these licences.
 */
export const WITHHOLD_VALUE: ReadonlySet<string> = new Set(["ioda-all-rights-reserved", "headline-link"]);

export type BundleObservation = Omit<ArchivedRow, "value"> & {
	/** Null when withheld for its licence (the fields, `valueHash` and proof still prove the row). */
	value: Json | null;
	withheld?: "licence";
	/** SHA-256 of the value's canonical JSON: the row hash covers it instead of the value. */
	valueHash: string;
	day: string;
	rowHash: string;
	/** Null while the day is not sealed yet (or when it changed after sealing: see chain.changedDays). */
	proof: ProofStep[] | null;
};

export type Bundle = {
	format: string;
	createdAt: number;
	generator: string;
	subject: { kind: "incident" | "panel"; id: string; title: string };
	/** How to read it (Spanish first). */
	readme: { es: string; en: string };
	rules: { es: string[]; en: string[] };
	snapshot: Json;
	observations: BundleObservation[];
	/** The chain entry of every sealed day the observations belong to; unsealed days are listed apart. */
	chain: {
		format: string;
		entries: ChainEntry[];
		/** Informative only: the verifier decides from its own archive whether a day is sealed. */
		unsealedDays: string[];
		/** Sealed days whose stored rows no longer match their seal (retention, or tampering): no proof possible. */
		changedDays: string[];
	};
	sha256: string;
};

/** The stored row a reference points at: that observed time, or the newest one; the newest revision of it. */
export function resolveRef(store: Store, ref: ObsRef, now: number): ArchivedRow | null {
	const row =
		ref.observedAt === null
			? store.db
					.query<RawRow, [string, string, number]>(
						`SELECT ${ROW_COLUMNS} FROM obs WHERE source = ? AND series = ? AND fetched_at <= ?
						 ORDER BY observed_at DESC, id DESC LIMIT 1`,
					)
					.get(ref.source, ref.series, now)
			: store.db
					.query<RawRow, [string, string, number, number]>(
						`SELECT ${ROW_COLUMNS} FROM obs WHERE source = ? AND series = ? AND observed_at = ? AND fetched_at <= ?
						 ORDER BY id DESC LIMIT 1`,
					)
					.get(ref.source, ref.series, ref.observedAt, now);
	return row ? toArchived(row) : null;
}

/** The newest row of every series of these sources observed in the window, newest first, capped. */
export function latestRows(
	store: Store,
	sources: readonly string[],
	since: number,
	cap = MAX_BUNDLE_ROWS,
): ArchivedRow[] {
	const out: ArchivedRow[] = [];
	for (const source of sources) {
		if (NOT_REDISTRIBUTABLE.has(source)) continue;
		const rows = store.db
			.query<RawRow, [string, number]>(
				`SELECT ${ROW_COLUMNS} FROM (
					SELECT *, ROW_NUMBER() OVER (PARTITION BY series ORDER BY observed_at DESC, id DESC) AS rn
					FROM obs WHERE source = ? AND observed_at >= ?
				) WHERE rn = 1 ORDER BY observed_at DESC`,
			)
			.all(source, since);
		out.push(...rows.map(toArchived).filter(redistributable));
	}
	return out.sort((a, b) => b.observedAt - a.observedAt).slice(0, cap);
}

export function bundleHash(bundle: Omit<Bundle, "sha256"> | Bundle): string {
	const { sha256: _omit, ...rest } = bundle as Bundle;
	return sha256(canonicalJson(rest as unknown as Json));
}

/** Sealed days never change: their trees are kept (a few) instead of rebuilding ~100k leaves per request. */
const trees = new Map<string, MerkleTree>();
const MAX_TREES = 4;

/** The tree of a sealed day: from its kept row hashes, or (an old day without them) from its stored rows. */
function sealedTree(store: Store, entry: ChainEntry): MerkleTree {
	const key = `${entry.day}:${entry.digest}`;
	const hit = trees.get(key);
	if (hit) return hit;
	const tree = merkleTree(sealedLeaves(store, entry.day) ?? dayHashes(store, entry.day, entry.format));
	trees.set(key, tree);
	if (trees.size > MAX_TREES) trees.delete(trees.keys().next().value as string);
	return tree;
}

export function buildBundle(
	store: Store,
	input: {
		subject: Bundle["subject"];
		rows: readonly ArchivedRow[];
		snapshot: Json;
		rules: Bundle["rules"];
		generator: string;
	},
	now: number,
): Bundle {
	const entries = new Map<string, ChainEntry>();
	const unsealed = new Set<string>();
	const changed = new Set<string>();
	const seen = new Set<string>();
	const observations: BundleObservation[] = [];
	for (const row of input.rows) {
		if (!redistributable(row)) continue;
		const day = utcDay(row.fetchedAt);
		const entry = entries.get(day) ?? chainEntry(store, day);
		const withheld = WITHHOLD_VALUE.has(row.licence);
		const hash = rowHash(row, entry?.format ?? CHAIN_FORMAT);
		if (seen.has(hash)) continue;
		seen.add(hash);
		let proof: ProofStep[] | null = null;
		if (entry) {
			entries.set(day, entry);
			const tree = sealedTree(store, entry);
			// A format-1 row hash covers the value: without the value nobody could check it, so no proof is shipped.
			if (treeRoot(tree) !== entry.root) changed.add(day);
			else if (!(withheld && entry.format === CHAIN_FORMAT_V1)) {
				proof = proofIn(tree, hash);
				if (proof === null) changed.add(day);
			}
		} else unsealed.add(day);
		observations.push({
			...row,
			value: withheld ? null : row.value,
			...(withheld ? { withheld: "licence" as const } : {}),
			valueHash: valueHash(row.value),
			day,
			rowHash: hash,
			proof,
		});
	}
	const body: Omit<Bundle, "sha256"> = {
		format: BUNDLE_FORMAT,
		createdAt: now,
		generator: input.generator,
		subject: input.subject,
		readme: {
			es: "Evidencia guardada de Vigía. Cada observación trae su enlace a la fuente original, cuándo la fuente dice que ocurrió (observedAt) y cuándo Vigía la recibió (fetchedAt), en milisegundos UTC. «rowHash» es la huella de todos sus campos (el valor, por su huella «valueHash»); «proof» prueba que esa huella está en el archivo sellado de su día; «chain» trae los resúmenes de esos días. Las filas con «withheld» no traen su valor por la licencia de la fuente, pero todos sus demás campos quedan probados: el valor se consulta en el enlace. Para que la prueba valga, compare los resúmenes de «chain» con /api/archive/digests de la instancia que la generó o con una copia guardada. Compruébelo con: vigia verify <este archivo>. «sha256» es la huella de todo el archivo: guárdela aparte para demostrar que no cambió.",
			en: "Evidence saved from Vigía. Each observation carries its link to the original source, when the source says it happened (observedAt) and when Vigía received it (fetchedAt), in UTC milliseconds. 'rowHash' is the hash of all its fields (the value by its hash, 'valueHash'); 'proof' proves that hash is in its day's sealed archive; 'chain' carries those days' digests. Rows marked 'withheld' carry no value because of the source's licence, but every other field is still proven: see the link for the value. For the proof to mean anything, compare the 'chain' digests with /api/archive/digests of the instance that made it, or with a copy kept elsewhere. Check it with: vigia verify <this file>. 'sha256' is the whole file's fingerprint: keep it elsewhere to show it did not change.",
		},
		rules: input.rules,
		snapshot: input.snapshot,
		observations,
		chain: {
			format: CHAIN_FORMAT,
			entries: [...entries.values()].sort((a, b) => a.day.localeCompare(b.day)),
			unsealedDays: [...unsealed].sort(),
			changedDays: [...changed].sort(),
		},
	};
	return { ...body, sha256: bundleHash(body) };
}

// ── Verification ─────────────────────────────────────────────────────────────────────────────────────────────

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const dayText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.number().int().min(0).max(8.64e15);
const text = (max: number) => z.string().max(max);
const jsonValue = z.custom<Json>((v) => v !== undefined, "falta el valor");

const entrySchema = z.object({
	day: dayText,
	rows: z.number().int().min(0),
	root: hex64,
	prev: hex64,
	digest: hex64,
	sealedAt: time,
	format: z.enum([CHAIN_FORMAT_V1, CHAIN_FORMAT]).optional(),
});

const observationSchema = z.object({
	source: text(200),
	series: text(2_000),
	observedAt: time,
	fetchedAt: time,
	sourceUrl: text(4_000),
	licence: text(200),
	confidence: z.number().finite(),
	basis: text(100),
	value: jsonValue,
	lat: z.number().finite().nullable(),
	lon: z.number().finite().nullable(),
	state: text(200).nullable(),
	place: text(1_000).nullable(),
	withheld: z.literal("licence").optional(),
	valueHash: hex64.optional(),
	day: dayText,
	rowHash: hex64,
	proof: z
		.array(z.object({ side: z.enum(["L", "R"]), hash: hex64 }))
		.max(64)
		.nullable(),
});

const bundleSchema = z.object({
	format: z.enum([BUNDLE_FORMAT_V1, BUNDLE_FORMAT]),
	createdAt: time,
	generator: text(200),
	subject: z.object({ kind: z.enum(["incident", "panel"]), id: text(300), title: text(500) }),
	observations: z.array(observationSchema).max(100_000),
	chain: z.object({
		format: text(50),
		entries: z.array(entrySchema).max(10_000),
		unsealedDays: z.array(dayText).max(10_000).optional(),
		changedDays: z.array(dayText).max(10_000).optional(),
	}),
	sha256: hex64,
});

/** This machine's archive, as the verifier sees it. */
export interface LocalArchive {
	entry(day: string): ChainEntry | null;
	/** Whether this machine's sealed day holds this row hash; null when it cannot tell (its rows changed). */
	holds(day: string, hash: string): boolean | null;
}

/** The local archive for `verifyBundle`: sealed entries, and each day's row hashes (checked against its seal). */
export function localArchive(store: Store): LocalArchive {
	const sets = new Map<string, Set<string> | null>();
	return {
		entry: (day) => chainEntry(store, day),
		holds(day, hash) {
			if (!sets.has(day)) {
				const e = chainEntry(store, day);
				const hashes = e ? (sealedLeaves(store, day) ?? dayHashes(store, day, e.format)) : null;
				sets.set(day, e && hashes && treeRoot(merkleTree(hashes)) === e.root ? new Set(hashes) : null);
			}
			const set = sets.get(day);
			return set ? set.has(hash) : null;
		},
	};
}

export type BundleReport = {
	ok: boolean;
	/** The file has the shape of a bundle (every field typed at the boundary); nothing else is checked otherwise. */
	readable: boolean;
	fileHashOk: boolean;
	/** Observations in the file. */
	total: number;
	/** Observations whose proof reaches their day's root in the bundle. */
	proven: number;
	/** Observations confirmed against this machine's sealed archive (a matching day, or the row in its day). */
	anchored: number;
	/** Observations without a working proof that this machine cannot check either (its day is not sealed here). */
	unproven: number;
	/** Observations whose value was withheld for its licence (their other fields are still checked). */
	withheld: number;
	problems: string[];
	/** Per day of the bundle, against this machine's archive chain. */
	local: { day: string; status: "same" | "different" | "absent" | "sealed-here" | "unchecked" }[];
};

const failed = (problem: string): BundleReport => ({
	ok: false,
	readable: false,
	fileHashOk: false,
	total: 0,
	proven: 0,
	anchored: 0,
	unproven: 0,
	withheld: 0,
	problems: [problem],
	local: [],
});

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** Checks a bundle offline; with `local`, also against this machine's archive. Never trusts the file's claims. */
export function verifyBundle(raw: unknown, local?: LocalArchive): BundleReport {
	const kind = (raw as { format?: unknown } | null)?.format;
	if (kind !== BUNDLE_FORMAT && kind !== BUNDLE_FORMAT_V1)
		return failed(`no es un archivo de evidencia de Vigía (${BUNDLE_FORMAT})`);
	const parsed = bundleSchema.safeParse(raw);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		return failed(`el archivo no tiene la forma de una evidencia de Vigía (${first?.path.join(".") ?? "?"})`);
	}
	const bundle = parsed.data;
	const legacy = bundle.format === BUNDLE_FORMAT_V1;
	const problems: string[] = [];
	// Over the file as read (the schema drops unknown keys; any added key must still break the hash).
	const fileHashOk = bundleHash(raw as Bundle) === bundle.sha256;
	if (!fileHashOk) problems.push("la huella sha256 no coincide: el archivo cambió después de guardarse");

	const formatOf = (e: z.infer<typeof entrySchema>) => e.format ?? (legacy ? CHAIN_FORMAT_V1 : CHAIN_FORMAT);
	const entries = new Map<string, z.infer<typeof entrySchema>>();
	for (const e of bundle.chain.entries) {
		if (entries.has(e.day)) problems.push(`el día ${e.day} aparece dos veces`);
		entries.set(e.day, e);
	}
	const sorted = [...entries.values()].sort((a, b) => a.day.localeCompare(b.day));
	sorted.forEach((e, i) => {
		if (chainDigest(e.prev, e.day, e.rows, e.root, formatOf(e)) !== e.digest)
			problems.push(`el resumen del día ${e.day} no corresponde a sus datos`);
		const before = sorted[i - 1];
		if (before && dayMs(e.day) - dayMs(before.day) === 86_400_000 && e.prev !== before.digest)
			problems.push(`el día ${e.day} no está encadenado al ${before.day}`);
	});

	// Per day, against this machine: decided by its own chain, never by the file's lists.
	const days = new Set([...entries.keys(), ...bundle.observations.map((o) => o.day)]);
	const localStatus = new Map<string, BundleReport["local"][number]["status"]>();
	for (const day of [...days].sort()) {
		if (!local) localStatus.set(day, "unchecked");
		else {
			const mine = local.entry(day);
			const theirs = entries.get(day);
			localStatus.set(
				day,
				!mine ? "absent" : !theirs ? "sealed-here" : mine.digest === theirs.digest ? "same" : "different",
			);
		}
	}
	for (const [day, status] of localStatus)
		if (status === "different")
			problems.push(`el día ${day} no coincide con el archivo sellado de este equipo`);

	let proven = 0;
	let anchored = 0;
	let unproven = 0;
	let withheld = 0;
	for (const o of bundle.observations) {
		const label = `${o.source} ${o.series}`;
		if (o.withheld) {
			withheld++;
			if (!WITHHOLD_VALUE.has(o.licence)) {
				problems.push(`${label}: marcada «sin valor», pero su licencia (${o.licence}) permite mostrarlo`);
				continue;
			}
			if (o.value !== null) {
				problems.push(`${label}: marcada «sin valor», pero trae un valor`);
				continue;
			}
		} else if (o.valueHash !== undefined && o.valueHash !== valueHash(o.value)) {
			problems.push(`${label}: el valor fue modificado (su huella no coincide)`);
			continue;
		}
		if (utcDay(o.fetchedAt) !== o.day) {
			problems.push(`${label}: el día no corresponde a su hora de recepción`);
			continue;
		}
		const row: ArchivedRow = {
			source: o.source,
			series: o.series,
			observedAt: o.observedAt,
			fetchedAt: o.fetchedAt,
			sourceUrl: o.sourceUrl,
			licence: o.licence,
			confidence: o.confidence,
			basis: o.basis,
			value: o.value,
			lat: o.lat,
			lon: o.lon,
			state: o.state,
			place: o.place,
		};
		/** The row's hash under a format; null when it cannot be computed (a withheld value under format 1). */
		const hashIn = (format: string): string | null => {
			if (format === CHAIN_FORMAT_V1) return o.withheld ? null : rowHash(row, format);
			const vh = o.withheld ? o.valueHash : valueHash(o.value);
			if (vh === undefined) return null;
			const { value: _v, ...fields } = row;
			return fieldsHash({ ...fields, valueHash: vh });
		};
		const entry = entries.get(o.day);
		const format = entry ? formatOf(entry) : legacy ? CHAIN_FORMAT_V1 : CHAIN_FORMAT;
		const hash = hashIn(format);
		if (hash === null) {
			// Nothing binds its fields: it counts as unchecked, never as proven.
			unproven++;
			continue;
		}
		if (hash !== o.rowHash) {
			problems.push(`${label}: la observación fue modificada (su huella no coincide)`);
			continue;
		}
		const mine = local?.entry(o.day) ?? null;
		if (o.proof !== null) {
			if (!entry || rootFromProof(hash, o.proof) !== entry.root) {
				problems.push(`${label}: la prueba no lleva al resumen sellado del día ${o.day}`);
				continue;
			}
			proven++;
			if (mine && mine.digest === entry.digest) anchored++;
			continue;
		}
		// No proof. If this machine sealed that day, its archive decides; the file's word does not count.
		if (mine && local) {
			const localHash = mine.format === format ? hash : hashIn(mine.format);
			const held = localHash === null ? null : local.holds(o.day, localHash);
			if (held === true) anchored++;
			else if (held === false)
				problems.push(`${label}: no está en el día ${o.day} sellado en este equipo (inventada o modificada)`);
			else unproven++;
		} else unproven++;
	}
	return {
		ok: problems.length === 0,
		readable: true,
		fileHashOk,
		total: bundle.observations.length,
		proven,
		anchored,
		unproven,
		withheld,
		problems,
		local: [...localStatus].map(([day, status]) => ({ day, status })),
	};
}
