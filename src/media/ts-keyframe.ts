/**
 * The first video access unit of an MPEG-TS segment, as a raw H.264 elementary stream (Annex B), in pure
 * TypeScript: PAT → PMT → the video PID → the payload of its first PES packet, which ends where the second one
 * starts. Nothing is decoded here; the bytes go to a decoder only when they are one complete keyframe (SPS, PPS and
 * an IDR slice), so a truncated read can never produce a half-grey picture.
 *
 * Why this is enough (measured 2026-09-28 on the newest segment of the cheapest variant of the 38 live streams in
 * iptv-org's Venezuela list): 38 of 38 MPEG-TS segments start with AUD, SPS, PPS and an IDR slice (some with an SEI),
 * as Apple's HLS rules ask, and that first access unit ends 6–97 KB into a segment of 0.4–8 MB. So a still costs the
 * first ~128 KB of one segment, not the segment. (One stream sends fragmented MP4, which needs its init segment:
 * not handled, reported as "fmp4".)
 */

export type KeyframeResult =
	| {
			readonly ok: true;
			/** Annex B H.264: SPS, PPS, (SEI), IDR slices, with start codes. */
			readonly annexB: Uint8Array;
			/** Byte offset where the access unit ended (the next video PES start). */
			readonly endOffset: number;
			/** NAL unit types in the access unit, in order. */
			readonly nalTypes: readonly number[];
	  }
	| {
			readonly ok: false;
			/**
			 * "not-ts": not MPEG-TS (fragmented MP4, an error page); "no-video": no H.264 stream in the PMT;
			 * "codec": video that is not H.264 (HEVC…); "incomplete": the read ended inside the first access unit
			 * (read more); "not-keyframe": the first access unit has no SPS/PPS/IDR.
			 */
			readonly reason: "not-ts" | "no-video" | "codec" | "incomplete" | "not-keyframe";
			/** For "codec": the PMT stream type. */
			readonly streamType?: number;
	  };

const PACKET = 188;
const SYNC = 0x47;
const H264 = 0x1b;
const VIDEO_TYPES = new Set([0x01, 0x02, 0x10, H264, 0x24, 0x42, 0xd1, 0xea]);
/** A keyframe larger than this is refused (a 1080p IDR at broadcast quality is well under 1 MB). */
export const MAX_KEYFRAME_BYTES = 2 * 1024 * 1024;

/** Offset of the first of three consecutive sync bytes, so a segment with leading junk still parses. */
function firstSync(b: Uint8Array): number {
	for (let i = 0; i < Math.min(b.length, PACKET * 2); i++) {
		if (b[i] === SYNC && b[i + PACKET] === SYNC && b[i + 2 * PACKET] === SYNC) return i;
	}
	return -1;
}

/** Payload start of a packet at `o`, or -1 when it carries none. */
function payloadStart(b: Uint8Array, o: number): number {
	const afc = ((b[o + 3] ?? 0) >> 4) & 0x3;
	if (afc === 0 || afc === 2) return -1;
	const p = afc === 3 ? o + 5 + (b[o + 4] ?? 0) : o + 4;
	return p < o + PACKET ? p : -1;
}

/** The program map PID from a PAT section starting at `p` (pointer field included). */
function pmtPid(b: Uint8Array, p: number, end: number): number | null {
	const t = p + 1 + (b[p] ?? 0);
	if (t + 12 > end || b[t] !== 0x00) return null;
	const sectionLength = (((b[t + 1] ?? 0) & 0x0f) << 8) | (b[t + 2] ?? 0);
	const last = Math.min(t + 3 + sectionLength - 4, end);
	for (let q = t + 8; q + 4 <= last; q += 4) {
		const program = ((b[q] ?? 0) << 8) | (b[q + 1] ?? 0);
		if (program !== 0) return (((b[q + 2] ?? 0) & 0x1f) << 8) | (b[q + 3] ?? 0);
	}
	return null;
}

/** The first video elementary stream in a PMT section: its PID and stream type. */
function videoStream(b: Uint8Array, p: number, end: number): { pid: number; type: number } | null {
	const t = p + 1 + (b[p] ?? 0);
	if (t + 12 > end || b[t] !== 0x02) return null;
	const sectionLength = (((b[t + 1] ?? 0) & 0x0f) << 8) | (b[t + 2] ?? 0);
	const last = Math.min(t + 3 + sectionLength - 4, end);
	const infoLength = (((b[t + 10] ?? 0) & 0x0f) << 8) | (b[t + 11] ?? 0);
	for (let q = t + 12 + infoLength; q + 5 <= last; ) {
		const type = b[q] ?? 0;
		const pid = (((b[q + 1] ?? 0) & 0x1f) << 8) | (b[q + 2] ?? 0);
		const esInfo = (((b[q + 3] ?? 0) & 0x0f) << 8) | (b[q + 4] ?? 0);
		if (VIDEO_TYPES.has(type)) return { pid, type };
		q += 5 + esInfo;
	}
	return null;
}

/** NAL unit types of an Annex B stream (3- or 4-byte start codes). */
export function nalTypes(annexB: Uint8Array): number[] {
	const out: number[] = [];
	for (let i = 0; i + 3 < annexB.length; i++) {
		if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1) {
			out.push((annexB[i + 3] ?? 0) & 0x1f);
			i += 3;
		}
	}
	return out;
}

/** Pure: the first complete video access unit of a TS prefix. */
export function firstKeyframe(bytes: Uint8Array): KeyframeResult {
	const start = firstSync(bytes);
	if (start < 0) return { ok: false, reason: "not-ts" };
	let pmt: number | null = null;
	let video: { pid: number; type: number } | null = null;
	const chunks: Uint8Array[] = [];
	let size = 0;
	let inAu = false;
	let auPts: number | null = null;
	for (let o = start; o + PACKET <= bytes.length; o += PACKET) {
		if (bytes[o] !== SYNC) return { ok: false, reason: "not-ts" };
		const pusi = ((bytes[o + 1] ?? 0) & 0x40) !== 0;
		const pid = (((bytes[o + 1] ?? 0) & 0x1f) << 8) | (bytes[o + 2] ?? 0);
		const p = payloadStart(bytes, o);
		if (p < 0) continue;
		const end = o + PACKET;
		if (pid === 0 && pusi && pmt === null) {
			pmt = pmtPid(bytes, p, end);
			continue;
		}
		if (pmt !== null && pid === pmt && pusi && video === null) {
			video = videoStream(bytes, p, end);
			if (video === null) return { ok: false, reason: "no-video" };
			if (video.type !== H264) return { ok: false, reason: "codec", streamType: video.type };
			continue;
		}
		if (video === null || pid !== video.pid) continue;
		if (pusi) {
			// PES header: 00 00 01, stream id, length (2), flags (2), header data length, header data.
			if (bytes[p] !== 0 || bytes[p + 1] !== 0 || bytes[p + 2] !== 1) continue;
			const pts = ((bytes[p + 7] ?? 0) & 0x80) !== 0 ? readPts(bytes, p + 9) : null;
			const headerLength = bytes[p + 8] ?? 0;
			const data = p + 9 + headerLength;
			if (data > end) continue;
			// Encoders that cap PES packets at 64 KB split a large IDR over several, each with the same timestamp
			// (measured on Isla TV and teleSUR 1080p). A new access unit has a new timestamp or opens with an access
			// unit delimiter or parameter sets.
			if (inAu && ((pts !== null && pts !== auPts) || opensAccessUnit(bytes, data, end)))
				return finish(chunks, size, o);
			if (!inAu) auPts = pts;
			inAu = true;
			chunks.push(bytes.subarray(data, end));
			size += end - data;
		} else if (inAu) {
			chunks.push(bytes.subarray(p, end));
			size += end - p;
		}
		if (size > MAX_KEYFRAME_BYTES) return { ok: false, reason: "not-keyframe" };
	}
	// No video stream found in a long read: there is none; in a short one, read more.
	if (video === null && bytes.length >= 64 * 1024) return { ok: false, reason: "no-video" };
	return { ok: false, reason: "incomplete" };
}

/** The 33-bit PES timestamp at `q`. */
function readPts(b: Uint8Array, q: number): number {
	const b0 = b[q] ?? 0;
	return (
		((b0 >> 1) & 0x07) * 2 ** 30 +
		(((b[q + 1] ?? 0) << 7) | ((b[q + 2] ?? 0) >> 1)) * 2 ** 15 +
		(((b[q + 3] ?? 0) << 7) | ((b[q + 4] ?? 0) >> 1))
	);
}

/** The payload at `q` opens with a start code and an access unit delimiter, SEI, SPS or PPS. */
function opensAccessUnit(b: Uint8Array, q: number, end: number): boolean {
	let i = q;
	while (i < end && i < q + 3 && b[i] === 0) i++;
	// A start code is 00 00 01 or 00 00 00 01: at least two zero bytes.
	if (i - q < 2 || b[i] !== 1 || i + 1 >= end) return false;
	const type = (b[i + 1] ?? 0) & 0x1f;
	return type === 9 || type === 6 || type === 7 || type === 8;
}

function finish(chunks: readonly Uint8Array[], size: number, endOffset: number): KeyframeResult {
	const annexB = new Uint8Array(size);
	let at = 0;
	for (const c of chunks) {
		annexB.set(c, at);
		at += c.length;
	}
	const types = nalTypes(annexB);
	// A keyframe a decoder can start from: parameter sets and an IDR slice; nothing that is not H.264.
	if (!types.includes(7) || !types.includes(8) || !types.includes(5) || types.some((t) => t === 0 || t > 23))
		return { ok: false, reason: "not-keyframe" };
	return { ok: true, annexB, endOffset, nalTypes: types };
}
