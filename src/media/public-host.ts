import { isIP } from "node:net";
import { HttpError, type HttpLike, type RawResponse, type RequestOptions } from "../core/types.ts";
import { isPublicAddress, type Resolver, systemResolver } from "../userfeeds/net.ts";

/**
 * Before Vigía turns bytes from a listed URL into a picture it serves from its own origin (a TV still, a channel logo,
 * a camera still), the URL's host must be on the public internet. The lists come from third parties (iptv-org's
 * community list, Windy): an entry pointing at 192.168.1.10 would otherwise make a Vigía read a camera or router on
 * its own network and publish the picture. The host must be a public IP literal, or a dotted name (not .local,
 * .internal, .lan, .home.arpa, .localhost, .onion) whose every address is public; checked before the request and
 * before every redirect hop (`publicRequest`: the client never follows a redirect on its own, so no private address
 * is ever asked). Answers are kept a minute per host. What remains: a DNS answer that changes between this check and
 * the connection (rebinding); the user-feed fetcher pins the address, the shared client does not.
 */

const BLOCKED_SUFFIXES = [
	".local",
	".internal",
	".lan",
	".home.arpa",
	".localhost",
	".onion",
	".localdomain",
];
/** A host's verdict is reused this long (short: a DNS answer that changes later is re-checked soon). */
const TTL_MS = 60_000;

let resolver: Resolver = systemResolver;
const verdicts = new Map<string, { ok: boolean; at: number }>();

/** Tests only: a resolver that answers without the network, and an empty verdict cache. */
export function useResolver(r: Resolver): void {
	resolver = r;
	verdicts.clear();
}

async function hostIsPublic(host: string, now: number): Promise<boolean> {
	const known = verdicts.get(host);
	if (known && now - known.at < TTL_MS) return known.ok;
	let ok = false;
	const literal = host.startsWith("[") ? host.slice(1, -1) : host;
	if (isIP(literal)) ok = isPublicAddress(literal);
	else if (host.includes(".") && !BLOCKED_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) {
		// A numeric-looking name that is not a valid IP (0x7f.1, 2130706433) is how filters are dodged: refused.
		if (!/^[\d.x]+$/i.test(host)) {
			try {
				const addresses = await resolver(literal);
				ok = addresses.length > 0 && addresses.every(isPublicAddress);
			} catch {
				ok = false;
			}
		}
	}
	verdicts.set(host, { ok, at: now });
	return ok;
}

/**
 * Without the network: a URL that is plainly not a public stream (not http(s), credentials, a private or loopback IP
 * literal, a local-only name, a numeric-looking name that dodges filters). A directory marks such an entry excluded;
 * a name that only resolves to a private address is caught at the probe (`publicRequest`).
 */
export function plainlyPrivateUrl(url: string): boolean {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return true;
	}
	if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return true;
	const host = u.hostname.toLowerCase().replace(/\.$/, "");
	const literal = host.startsWith("[") ? host.slice(1, -1) : host;
	if (isIP(literal)) return !isPublicAddress(literal);
	if (!host.includes(".") || /^[\d.x]+$/i.test(host)) return true;
	return BLOCKED_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s));
}

/** Throws (a short "private-host" failure) unless `url` is http(s), without credentials, on a public host. */
export async function assertPublicUrl(url: string, now = Date.now()): Promise<void> {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		throw new HttpError("private-host: not a URL", 0, url);
	}
	if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password)
		throw new HttpError("private-host: scheme or credentials", 0, url);
	const host = u.hostname.toLowerCase().replace(/\.$/, "");
	if (!(await hostIsPublic(host, now))) throw new HttpError("private-host", 0, url);
}

const REDIRECTS = [301, 302, 303, 307, 308];
const MAX_HOPS = 3;

/**
 * A GET of a listed URL that never touches a private host: every hop is checked BEFORE it is asked for (redirects
 * are not followed by the client; each Location is checked and then requested), at most three redirects.
 */
export async function publicRequest(
	http: HttpLike,
	url: string,
	options: RequestOptions,
	now: () => number,
): Promise<RawResponse> {
	let target = url;
	for (let hop = 0; ; hop++) {
		await assertPublicUrl(target, now());
		const res = await http.request(target, {
			...options,
			redirect: "manual",
			okStatuses: [...(options.okStatuses ?? []), ...REDIRECTS],
			captureHeaders: [...(options.captureHeaders ?? []), "location"],
		});
		if (!REDIRECTS.includes(res.status)) return { ...res, url: res.url || target };
		const location = res.headers?.location;
		if (!location || hop >= MAX_HOPS) throw new HttpError("too many or empty redirects", res.status, target);
		target = new URL(location, target).toString();
	}
}
