import { z } from "zod";

/**
 * A feed the user added by hand ("Mis fuentes"), as stored in config.json. The id is derived from the URL, so the
 * same address can never be added twice and its stored history survives removing and re-adding it.
 */
export const USER_FEED_ID = /^mia-[0-9a-f]{10}$/;
export const USER_FEED_REGION = /^(national|international|VE-[A-Z])$/;
export const USER_FEED_LIMIT = 30;
export const USER_FEED_INTERVALS_MIN = [15, 30, 60, 180] as const;

export const UserFeedSchema = z
	.object({
		id: z.string().regex(USER_FEED_ID),
		url: z.string().min(8).max(2_048),
		name: z.string().min(1).max(80),
		/** "national", "international", or the ISO 3166-2 state the feed covers (place tagging starts from it). */
		region: z.string().regex(USER_FEED_REGION),
		intervalMin: z.union(USER_FEED_INTERVALS_MIN.map((m) => z.literal(m))),
		addedAt: z.number().int().min(0),
	})
	.strict();

export type UserFeed = z.infer<typeof UserFeedSchema>;

/** What the client sends to add one. */
export const AddFeedSchema = z
	.object({
		url: z.string().min(1).max(2_048),
		name: z.string().trim().max(80).optional(),
		region: z.string().regex(USER_FEED_REGION).optional(),
		intervalMin: z.union(USER_FEED_INTERVALS_MIN.map((m) => z.literal(m))).optional(),
	})
	.strict();

export type AddFeed = z.infer<typeof AddFeedSchema>;
