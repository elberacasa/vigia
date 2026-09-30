/**
 * Cuts a recorded iptv-org fixture (four files, ~20 MB) down to what the Venezuela directory reads, so the test
 * fixture stays small but classifies exactly like the full list: every stream that concerns Venezuela, every other
 * stream on a bare-IP host that carries one (the relay-host rule counts countries per host), and the channels, feeds
 * and blocklist rows they name. iptv-org's data is public domain.
 *
 *   bun scripts/media/iptv-subset.ts <full fixture dir> <out dir>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCatalog } from "../../src/adapters/iptv-ve/catalog.ts";

const [from, to] = process.argv.slice(2);
if (!from || !to) throw new Error("uso: iptv-subset.ts <dir completo> <dir de salida>");
type Entry = { file: string; url: string; status: number; contentType: string; fetchedAt: number };
const manifest = JSON.parse(readFileSync(join(from, "manifest.json"), "utf8")) as Entry[];
const body = (name: string) => {
	const e = manifest.find((m) => m.url.endsWith(`/${name}.json`));
	if (!e) throw new Error(name);
	return readFileSync(join(from, e.file), "utf8");
};
const files = {
	channels: body("channels"),
	feeds: body("feeds"),
	streams: body("streams"),
	blocklist: body("blocklist"),
};
const full = buildCatalog(files);

type Row = Record<string, unknown>;
const channels = JSON.parse(files.channels) as Row[];
const feeds = JSON.parse(files.feeds) as Row[];
const streams = JSON.parse(files.streams) as Row[];
const blocklist = JSON.parse(files.blocklist) as Row[];
const urls = new Set(full.entries.map((e) => e.url));
const hostOf = (u: string) => {
	try {
		return new URL(u).host;
	} catch {
		return "";
	}
};
const ipHosts = new Set([...urls].map(hostOf).filter((h) => /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(h)));
const keptStreams = streams.filter((s) => urls.has(String(s.url)) || ipHosts.has(hostOf(String(s.url))));
const ids = new Set(keptStreams.map((s) => String(s.channel)));
// The list's minimum-size guard needs ≥ 100 channels and feeds: pad with the first Venezuelan ones (never streamed).
for (const c of channels) if (ids.size < 160 && c.country === "VE") ids.add(String(c.id));
const out = {
	channels: channels.filter((c) => ids.has(String(c.id))),
	feeds: feeds.filter((f) => ids.has(String(f.channel))),
	streams: keptStreams,
	blocklist: blocklist.filter((b) => ids.has(String(b.channel))).concat(blocklist.slice(0, 3)),
};
const subset = buildCatalog({
	channels: JSON.stringify(out.channels),
	feeds: JSON.stringify(out.feeds),
	streams: JSON.stringify(out.streams),
	blocklist: JSON.stringify(out.blocklist),
});
if (JSON.stringify(subset.entries) !== JSON.stringify(full.entries))
	throw new Error("the subset classifies differently");
mkdirSync(to, { recursive: true });
const newManifest = manifest.map((m) => {
	const name = ["channels", "feeds", "streams", "blocklist"].find((n) =>
		m.url.endsWith(`/${n}.json`),
	) as keyof typeof out;
	const file = `${name}.json`;
	writeFileSync(join(to, file), `${JSON.stringify(out[name])}\n`);
	return { ...m, file };
});
writeFileSync(join(to, "manifest.json"), `${JSON.stringify(newManifest, null, 2)}\n`);
console.log(
	`${full.entries.length} entries; subset: ${out.channels.length} channels, ${out.feeds.length} feeds, ${out.streams.length} streams`,
);
