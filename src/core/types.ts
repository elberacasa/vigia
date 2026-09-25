import type { BlobPolicy, BlobSink } from "./blobs.ts";

/**
 * The adapter contract. Every feed in Vigía is an adapter: it fetches raw bytes, then a pure `normalise`
 * validates them at the boundary and turns them into typed observations. Everything downstream (store,
 * compute, API, UI) only ever sees observations.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** How a figure came to be. Shown next to it in the UI, so it must be honest. */
export type Basis =
	/** Read by an instrument or a network measurement (seismometer, satellite, probes). */
	| "measurement"
	/** Published by an official body as its own figure (BCV rate, INE). */
	| "official"
	/** A named third party's quote or estimate (a P2P market median, an aggregator). */
	| "quote"
	/** A report by a person or outlet (news, social); not verified by us. */
	| "report"
	/** Computed in our code from other observations. */
	| "derived";

export type Layer = "money" | "earth" | "internet" | "news" | "social" | "oil" | "society";

export interface GeoPoint {
	readonly lat: number;
	readonly lon: number;
	/** ISO 3166-2 code, e.g. "VE-V" (Zulia), when the point is inside Venezuela. */
	readonly state?: string;
	/** Human label from the source or the gazetteer. */
	readonly place?: string;
}

export interface Observation<V extends Json = Json> {
	/** Adapter id. */
	readonly source: string;
	/** Stable id of the thing observed within the source, e.g. "usd-ves" or "quake:us7000abcd". */
	readonly series: string;
	/** Link a person can open to see the original. */
	readonly sourceUrl: string;
	/** When we received it (epoch ms). */
	readonly fetchedAt: number;
	/** When the source says it is true (epoch ms). */
	readonly observedAt: number;
	/** Licence id (see licences.ts). */
	readonly licence: string;
	readonly value: V;
	readonly location?: GeoPoint;
	/** 0..1. 1 for instrument readings and official publications; lower for keyword tagging and heuristics. */
	readonly confidence: number;
	readonly basis: Basis;
	/**
	 * `observedAt` is only the time Vigía first saw this (the source gives no date): keep the first stored row and
	 * ignore later ones, so an undated item never looks newer on each poll.
	 */
	readonly keepFirst?: true;
}

export interface RawResponse {
	readonly url: string;
	readonly status: number;
	readonly contentType: string;
	readonly body: string;
	readonly fetchedAt: number;
	/** The response's ETag, when the source sent one (for If-None-Match change detection). */
	readonly etag?: string;
	/** The response's Last-Modified, when sent (for If-Modified-Since). */
	readonly lastModified?: string;
}

export interface Licence {
	readonly id: string;
	readonly name: string;
	readonly url: string;
	/** Attribution text to show wherever the data appears. */
	readonly attribution: string;
	/** Whether commercial use is allowed. Informational; Vigía is free and non-commercial. */
	readonly commercial: boolean | "unclear";
	/**
	 * false: the terms do not allow passing the source's own rows on (only derived results with attribution), so the
	 * raw feed endpoints refuse them; panels still show what Vigía computes from them.
	 */
	readonly raw?: false;
}

export interface FreshnessBudget {
	/** A successful fetch older than this makes the feed stale. */
	readonly fetchMs: number;
	/**
	 * The newest observation older than this makes the feed stale. Null for event feeds, where silence is
	 * normal (no earthquake today is not staleness).
	 */
	readonly dataMs: number | null;
}

export interface FetchContext {
	readonly http: HttpLike;
	/** Returns the key or undefined. Adapters never log it. */
	key(id: string): string | undefined;
	readonly now: () => number;
	readonly signal: AbortSignal;
	/**
	 * This adapter's own image store, present when the adapter declares a `blobs` policy and the host has a
	 * store (absent when recording fixtures). Images are processed and stored here in `fetch`; observations
	 * reference them by key.
	 */
	readonly blobs?: BlobSink;
	/**
	 * Whether this adapter already has an observation of `series` at `observedAt` in the store. With `blobs`,
	 * "done" is the stored observation, not the stored image: an image whose run failed after it was written
	 * must be fetched again, or its observation would never exist. Absent when there is no store.
	 */
	readonly seen?: (series: string, observedAt: number) => boolean;
}

export interface RequestOptions {
	readonly method?: "GET" | "POST";
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
	readonly timeoutMs?: number;
	/** Extra CA certificates (PEM) for sources with broken chains. */
	readonly ca?: string;
	readonly maxBytes?: number;
	/**
	 * Read at most this many bytes, then stop and return them (an endless audio stream answers forever). Unlike
	 * `maxBytes`, reaching it is not an error. The body is then only the first bytes of the response.
	 */
	readonly readBytes?: number;
	/** Minimum gap between requests to the same host, ms. */
	readonly hostGapMs?: number;
	/** Queue for that gap; defaults to the host. Requests with different keys do not wait for each other. */
	readonly paceKey?: string;
	readonly retries?: number;
	/** Treat these statuses as success (e.g. 404 for "no data"). */
	readonly okStatuses?: readonly number[];
	/** Response is binary: body is base64. */
	readonly binary?: boolean;
	readonly signal?: AbortSignal;
}

export interface HttpLike {
	request(url: string, options?: RequestOptions): Promise<RawResponse>;
}

export interface Adapter<V extends Json = Json> {
	readonly id: string;
	readonly layer: Layer;
	readonly name: { readonly es: string; readonly en: string };
	/** Who publishes the data, e.g. "USGS". */
	readonly provider: string;
	readonly homepage: string;
	readonly licence: Licence;
	/** Key ids this adapter needs. Empty: works with no key. */
	readonly keys: readonly string[];
	readonly intervalMs: number;
	readonly freshness: FreshnessBudget;
	/**
	 * Off unless the user turns it on, with the reason shown in the guide (e.g. a source whose terms are unclear
	 * about automated access). Everything else is on by default.
	 */
	readonly optIn?: { readonly es: string; readonly en: string };
	/** Retention for the images this adapter stores (see `FetchContext.blobs`). Absent: it stores none. */
	readonly blobs?: BlobPolicy;
	/** Network: fetch whatever raw responses are needed for one run. */
	fetch(ctx: FetchContext): Promise<readonly RawResponse[]>;
	/** Pure: validate and normalise. Throws on schema violations (the run fails loudly, last-good stays). */
	normalise(raw: readonly RawResponse[]): Observation<V>[];
}

export class SchemaError extends Error {
	override readonly name = "SchemaError";
}

export class HttpError extends Error {
	override readonly name = "HttpError";
	constructor(
		message: string,
		readonly status: number,
		readonly url: string,
	) {
		super(message);
	}
}

export class MissingKeyError extends Error {
	override readonly name = "MissingKeyError";
	constructor(readonly keyId: string) {
		super(`missing key ${keyId}`);
	}
}
