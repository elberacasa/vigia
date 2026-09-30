/**
 * Entity ids (src/ontology: `ve.zulia.maracaibo`, `infra.planta-centro`, `net.cantv`, `asn.8048`, `inst.bcv`,
 * `outlet.el-pitazo`) and the addresses of their pages, both ways. Small and pure: it is in the first load (the
 * router reads it), the view models and the pages are not.
 *
 *   ve                      /lugar
 *   ve.zulia.maracaibo…     /lugar/zulia/maracaibo…   (the id's segments are the path's)
 *   infra.planta-centro     /infra/planta-centro
 *   net.cantv               /red/cantv
 *   asn.8048                /red/as8048
 *   inst.bcv                /institucion/bcv
 *   outlet.el-pitazo        /medio/el-pitazo
 *   cam.charallave-oeste    /camara/charallave-oeste
 */

const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const PREFIX: readonly (readonly [string, string])[] = [
	["infra.", "/infra/"],
	["net.", "/red/"],
	["inst.", "/institucion/"],
	["outlet.", "/medio/"],
	["cam.", "/camara/"],
];

/** The page of an entity; null for an id this client does not know how to address. */
export function entityPath(id: string): string | null {
	if (id === "ve") return "/lugar";
	if (id.startsWith("ve.")) {
		const segs = id.slice(3).split(".");
		return segs.length <= 3 && segs.every((s) => SEGMENT.test(s)) ? `/lugar/${segs.join("/")}` : null;
	}
	const asn = /^asn\.(\d{1,10})$/.exec(id);
	if (asn) return `/red/as${asn[1]}`;
	for (const [pre, path] of PREFIX) {
		if (!id.startsWith(pre)) continue;
		const rest = id.slice(pre.length);
		return SEGMENT.test(rest) ? `${path}${rest}` : null;
	}
	return null;
}

/** The entity an address shows; null when the address is not an entity page. */
export function entityIdFromPath(path: string): string | null {
	const clean = path.replace(/\/+$/, "") || "/";
	if (clean === "/lugar") return "ve";
	const place = /^\/lugar\/(.+)$/.exec(clean);
	if (place) {
		const segs = (place[1] as string).split("/");
		return segs.length <= 3 && segs.every((s) => SEGMENT.test(s)) ? `ve.${segs.join(".")}` : null;
	}
	const asn = /^\/red\/as(\d{1,10})$/.exec(clean);
	if (asn) return `asn.${asn[1]}`;
	for (const [pre, prefix] of PREFIX) {
		if (!clean.startsWith(prefix)) continue;
		const rest = clean.slice(prefix.length);
		return SEGMENT.test(rest) ? `${pre}${rest}` : null;
	}
	return null;
}

/** "ve.zulia.maracaibo" → "ve.zulia": the state of a place id (null for the country and for non-places). */
export function stateIdOf(id: string): string | null {
	const m = /^ve\.([a-z0-9-]+)/.exec(id);
	return m ? `ve.${m[1]}` : null;
}
