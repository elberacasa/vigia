/**
 * Abuse-control memory for crowd reports. Lives only in this process: never written to disk, never logged. A client
 * is known only by an HMAC-SHA-256 fingerprint of its connection key (the address, an IPv6 address by its /64)
 * under a random salt that is replaced every day; with the salt gone, yesterday's fingerprints cannot be recomputed
 * from an address. The previous epoch is kept only until its last entry could still be updated (one window), then
 * dropped whole.
 *
 * Per fingerprint: what it answered per municipality and service in the window, by 15-minute bucket (so a repeat
 * updates instead of adding) and the municipalities it reported on this epoch; plus its rate-limit buckets, and one
 * more bucket per IPv6 /48 (a site holds 65,536 /64s). Nothing else, and no time finer than the bucket.
 *
 * The page may send a random per-device token (SECURITY.md, crowd reports), so that phones behind one carrier NAT
 * address count as different reporters. It is never kept as sent: only its HMAC under the same daily salt, as part of
 * an entry's key, for as long as the entry lives. It keys nothing else: every limit stays on the address (and /48),
 * and one address holds at most CROWD_RULES.perClient.devicesPerPair live reporters per municipality and service.
 */

import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { clientKey, RateLimiter } from "../server/ratelimit.ts";
import { ipv6Hextets } from "../userfeeds/net.ts";
import { bucketOf, type Status } from "./counts.ts";
import { type Answer, CROWD_RULES, type Service } from "./rules.ts";

export type Entry = {
	readonly entity: string;
	readonly service: Service;
	bucket: number;
	answer: Answer;
	status: Status;
	/** The device's fingerprint under this epoch's salt ("-" without a token). */
	device: string;
	/**
	 * Counted while its address already had another live reporter for this municipality and service: a second phone
	 * behind the same address. Published as reports, not as another connection.
	 */
	extra: boolean;
};

/** A per-device token as the page sends it: 16 random bytes, base64url (22 characters). */
export const DEVICE_TOKEN = /^[A-Za-z0-9_-]{22}$/;

const NO_DEVICE = "-";

/** An IPv6 address's /48, or null for IPv4 (and IPv4-mapped IPv6). */
export function site48(ip: string): string | null {
	const bare = ip.replace(/%.*$/, "");
	if (isIP(bare) !== 6) return null;
	const h = ipv6Hextets(bare);
	if (!h || (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff))
		return null;
	return `${h
		.slice(0, 3)
		.map((x) => x.toString(16))
		.join(":")}::/48`;
}

type Client = {
	readonly entries: Map<string, Entry>;
	readonly municipalities: Set<string>;
};

class Epoch {
	readonly salt = randomBytes(32);
	readonly clients = new Map<string, Client>();
	readonly submitLimiter: RateLimiter;
	readonly challengeLimiter: RateLimiter;
	readonly siteLimiter: RateLimiter;

	constructor(
		readonly startedAt: number,
		now: () => number,
	) {
		const c = CROWD_RULES.perClient;
		this.submitLimiter = new RateLimiter(c.burst, c.perHour / 3_600, now, CROWD_RULES.maxTracked);
		this.challengeLimiter = new RateLimiter(
			c.challengeBurst,
			c.challengesPerHour / 3_600,
			now,
			CROWD_RULES.maxTracked,
		);
		this.siteLimiter = new RateLimiter(c.site48Burst, c.site48PerHour / 3_600, now, CROWD_RULES.maxTracked);
	}

	fingerprint(ip: string): string {
		return createHmac("sha256", this.salt).update(clientKey(ip)).digest("base64url").slice(0, 22);
	}

	/** A device token's fingerprint; a different domain from addresses so the two can never collide. */
	device(token: string | null): string {
		if (token === null) return NO_DEVICE;
		return createHmac("sha256", this.salt).update(`device\n${token}`).digest("base64url").slice(0, 22);
	}
}

export const entryKey = (entity: string, service: Service, device: string) =>
	`${entity}|${service}|${device}`;

export class ClientMemory {
	#current: Epoch;
	#previous: Epoch | null = null;
	/** Called when the salt changes (the challenge keys rotate with it). */
	onRotate: () => void = () => {};

	constructor(
		readonly now: () => number = Date.now,
		readonly rotationMs: number = CROWD_RULES.saltRotationMs,
		readonly windowMs: number = CROWD_RULES.windowMs,
		readonly maxClients: number = CROWD_RULES.maxTracked,
	) {
		this.#current = new Epoch(now(), now);
	}

	/** Rotates the salt when the epoch is over, and drops the previous epoch once none of its entries can matter. */
	tick(): void {
		const t = this.now();
		if (this.#previous && t - this.#current.startedAt > this.windowMs) this.#previous = null;
		if (t - this.#current.startedAt >= this.rotationMs) {
			this.#previous = this.#current;
			this.#current = new Epoch(t, this.now);
			this.onRotate();
		}
	}

	/** The current fingerprint of a connection (for the rate limiters). */
	fingerprint(ip: string): string {
		this.tick();
		return this.#current.fingerprint(ip);
	}

	/** One submission: the connection's bucket, and its IPv6 /48's. */
	takeSubmit(fp: string, ip: string): boolean {
		const site = site48(ip);
		if (site && !this.#current.siteLimiter.take(this.#current.fingerprint(site))) return false;
		return this.#current.submitLimiter.take(fp);
	}

	takeChallenge(fp: string): boolean {
		return this.#current.challengeLimiter.take(fp);
	}

	#client(fp: string): Client {
		const map = this.#current.clients;
		let c = map.get(fp);
		if (c) {
			// Most recently seen last, for the cap below.
			map.delete(fp);
		} else c = { entries: new Map(), municipalities: new Set() };
		map.set(fp, c);
		if (map.size > this.maxClients)
			for (const oldest of map.keys()) {
				map.delete(oldest);
				if (map.size <= this.maxClients) break;
			}
		return c;
	}

	/** Municipalities this connection reported on in this epoch. */
	municipalities(fp: string): ReadonlySet<string> {
		return this.#current.clients.get(fp)?.municipalities ?? new Set();
	}

	/** A device token's fingerprint under the current salt ("-" for none). */
	device(token: string | null): string {
		this.tick();
		return this.#current.device(token);
	}

	/**
	 * This reporter's live entry (this address and device) for a municipality and service: from this epoch, or from
	 * the previous one (then moved here, under the new fingerprints). Entries older than the window are gone.
	 */
	entry(ip: string, fp: string, token: string | null, entity: string, service: Service): Entry | null {
		const device = this.#current.device(token);
		const key = entryKey(entity, service, device);
		const live = (e: Entry | undefined) => (e && this.#live(e) ? e : null);
		const mine = live(this.#current.clients.get(fp)?.entries.get(key));
		if (mine) return mine;
		if (!this.#previous) return null;
		const old = this.#previous.clients.get(this.#previous.fingerprint(ip));
		const oldKey = entryKey(entity, service, this.#previous.device(token));
		const found = live(old?.entries.get(oldKey));
		if (!found || !old) return null;
		old.entries.delete(oldKey);
		found.device = device;
		this.#client(fp).entries.set(key, found);
		return found;
	}

	/** Live reporters (devices) of this address for a municipality and service, in either epoch. */
	reporters(ip: string, fp: string, entity: string, service: Service): number {
		const prefix = `${entity}|${service}|`;
		let n = 0;
		for (const [c, epoch] of [
			[this.#current.clients.get(fp), this.#current],
			[this.#previous?.clients.get(this.#previous.fingerprint(ip)), this.#previous],
		] as const) {
			if (!c || !epoch) continue;
			for (const [k, e] of c.entries) if (k.startsWith(prefix) && this.#live(e)) n++;
		}
		return n;
	}

	remember(fp: string, e: Entry): void {
		const c = this.#client(fp);
		c.entries.set(entryKey(e.entity, e.service, e.device), e);
		c.municipalities.add(e.entity);
	}

	/** An entry lives while its bucket is in the window: exactly as long as the report it stands for is counted. */
	#live(e: Entry): boolean {
		return e.bucket >= bucketOf(this.now()) - this.windowMs;
	}

	/** Drops expired entries (the "update" window is over); a client with nothing left but its day's list keeps that. */
	sweep(): void {
		for (const epoch of [this.#current, this.#previous]) {
			if (!epoch) continue;
			for (const [fp, c] of epoch.clients) {
				for (const [k, e] of c.entries) if (!this.#live(e)) c.entries.delete(k);
				if (epoch !== this.#current && c.entries.size === 0) epoch.clients.delete(fp);
			}
		}
	}

	/** For tests and the status of the memory: how many fingerprints are tracked. */
	get size(): { current: number; previous: number } {
		return { current: this.#current.clients.size, previous: this.#previous?.clients.size ?? 0 };
	}
}
