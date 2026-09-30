import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hdf5Error, Hdf5File, lookup3, NeedBytes, SparseFile, unshuffle, WholeFile } from "./hdf5.ts";

// The first file of the GLM fixture (adapters/goes-glm, recorded 2026-09-29): the byte ranges the adapter read from
// OR_GLM-L2-LCFA_G19_s20262720200000 (559,145 bytes), 17 of them. The values below were read from the full file
// with the HDF5 project's own h5dump 1.14 and must come out identical.
const dir = join(import.meta.dir, "..", "adapters", "goes-glm", "fixtures", "2026-09-29");
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { file: string }[];
const bundle = JSON.parse(readFileSync(join(dir, manifest[1]?.file ?? ""), "utf8")) as {
	size: number;
	ranges: [number, string][];
};
const sparse = (skip = -1) => {
	const s = new SparseFile(bundle.size);
	bundle.ranges.forEach(([offset, b64], i) => {
		if (i !== skip) s.add(offset, new Uint8Array(Buffer.from(b64, "base64")));
	});
	return s;
};

test("reads GLM flash_lat, flash_lon and flash_quality_flag from 17 byte ranges, as h5dump does", () => {
	const file = new Hdf5File(sparse());
	const links = file.rootLinks(["flash_lat", "flash_lon", "flash_quality_flag"]);
	expect([...links.keys()].sort()).toEqual(["flash_lat", "flash_lon", "flash_quality_flag"]);
	const lat = file.read1d("flash_lat", links.get("flash_lat"));
	expect(lat.length).toBe(780);
	expect(lat.slice(0, 3).map((v) => Math.round(v * 1e4) / 1e4)).toEqual([-18.9856, 19.9985, -11.1449]);
	expect(file.info("flash_lat")).toMatchObject({
		shape: [780],
		type: { kind: "float", size: 4, bigEndian: false },
		layout: "chunked-btree",
	});
	expect(file.info("flash_lat").filters.map((f) => f.id)).toEqual([2, 1]);
	const quality = file.read1d("flash_quality_flag");
	expect(quality.length).toBe(780);
	expect(quality.every((q) => Number.isInteger(q))).toBe(true);
	expect(bundle.ranges.reduce((n, [, b64]) => n + Buffer.from(b64, "base64").length, 0)).toBeLessThan(40_000);
});

test("a missing range surfaces as NeedBytes at or after its offset (overlapping read-ahead can make one redundant)", () => {
	let required = 0;
	for (let i = 0; i < bundle.ranges.length; i++) {
		try {
			const f = new Hdf5File(sparse(i));
			const links = f.rootLinks(["flash_lat", "flash_lon", "flash_quality_flag"]);
			for (const n of ["flash_lat", "flash_lon", "flash_quality_flag"]) f.read1d(n, links.get(n));
		} catch (error) {
			if (!(error instanceof NeedBytes)) throw error;
			expect(error.offset).toBeGreaterThanOrEqual(bundle.ranges[i]?.[0] ?? 0);
			required++;
		}
	}
	expect(required).toBeGreaterThanOrEqual(bundle.ranges.length - 3);
});

test("SparseFile joins adjacent pieces and knows the file's end", () => {
	const s = new SparseFile(10);
	s.add(0, new Uint8Array([1, 2, 3]));
	s.add(3, new Uint8Array([4, 5]));
	expect([...s.read(1, 4)]).toEqual([2, 3, 4, 5]);
	expect(() => s.read(4, 3)).toThrow(NeedBytes);
	expect(() => s.read(8, 4)).toThrow(Hdf5Error);
});

test("lookup3 matches Bob Jenkins' published test vectors", () => {
	const enc = (s: string) => new TextEncoder().encode(s);
	expect(lookup3(enc(""))).toBe(0xdeadbeef);
	expect(lookup3(enc("Four score and seven years ago"))).toBe(0x17770551);
	expect(lookup3(enc("Four score and seven years ago"), 1)).toBe(0xcd628161);
});

test("unshuffle puts bytes back in element order", () => {
	// Two 4-byte elements shuffled: all first bytes, then all second bytes…
	expect([...unshuffle(new Uint8Array([1, 5, 2, 6, 3, 7, 4, 8]), 4)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("not an HDF5 file", () => {
	expect(() => new Hdf5File(new WholeFile(new TextEncoder().encode("<html>not hdf5</html>")))).toThrow(
		Hdf5Error,
	);
});
