import { Schema } from "effect";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * Durable per-agent key-value state. See `docs/agent-primitives.md` for the
 * design. Overwrite semantics; the agent that owns the row is the only
 * writer, pod-mates may read across. Caps here are advisory to the client
 * and enforced by the core.
 */

export const MAX_STATE_KEY_CHARACTERS = 128;
export const MAX_STATE_PURPOSE_CHARACTERS = 500;
/** Serialised JSON size cap for a single `value`. */
export const MAX_STATE_VALUE_BYTES = 50_000;
export const MAX_STATE_KEYS_PER_AGENT = 100;
/** Sum of every value's serialised size, per agent. */
export const MAX_STATE_TOTAL_BYTES_PER_AGENT = 2_000_000;
/** How many entries `recall_all` returns in one call. */
export const STATE_LIST_PAGE_SIZE = 25;

export const agentStateKeySchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_STATE_KEY_CHARACTERS),
);

export const agentStatePurposeSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_STATE_PURPOSE_CHARACTERS),
);

/** Any JSON — the store does not interpret the shape. */
export const agentStateValueSchema = Schema.Unknown;

export const agentStateSourceSchema = Schema.Literals(["agent", "human"]);
export type AgentStateSource = typeof agentStateSourceSchema.Type;

export const agentStateSchema = Schema.Struct({
	agentId: uuidSchema,
	key: agentStateKeySchema,
	value: agentStateValueSchema,
	purpose: agentStatePurposeSchema,
	source: agentStateSourceSchema,
	sourceUserId: Schema.NullOr(uuidSchema),
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
});

export type AgentState = typeof agentStateSchema.Type;

/** Shape returned when the agent asks for one entry. */
export const agentStateRecallSchema = Schema.Struct({
	key: agentStateKeySchema,
	value: agentStateValueSchema,
	purpose: agentStatePurposeSchema,
	source: agentStateSourceSchema,
	updatedAt: isoTimestampSchema,
});

export type AgentStateRecall = typeof agentStateRecallSchema.Type;

/** Summary in a list — value is truncated by the caller. */
export const agentStateSummarySchema = Schema.Struct({
	key: agentStateKeySchema,
	purpose: agentStatePurposeSchema,
	source: agentStateSourceSchema,
	updatedAt: isoTimestampSchema,
});

export type AgentStateSummary = typeof agentStateSummarySchema.Type;

/** How much of an agent's cap is in use. */
export const agentStateUsageSchema = Schema.Struct({
	keys: Schema.Number,
	totalBytes: Schema.Number,
});

export type AgentStateUsage = typeof agentStateUsageSchema.Type;

/** One page of an agent's state, for the workspace UI. */
export const agentStatePageSchema = Schema.Struct({
	entries: Schema.Array(agentStateSchema),
	hasMore: Schema.Boolean,
	usage: agentStateUsageSchema,
});

export type AgentStatePage = typeof agentStatePageSchema.Type;

/** Payload a user submits to write one entry (key comes from the path). */
export const agentStateWriteSchema = Schema.Struct({
	value: agentStateValueSchema,
	purpose: agentStatePurposeSchema,
});

export type AgentStateWrite = typeof agentStateWriteSchema.Type;

/** Query parameters for listing an agent's state. */
export const agentStateListQuerySchema = Schema.Struct({
	keyPrefix: Schema.optional(agentStateKeySchema),
	after: Schema.optional(agentStateKeySchema),
});

export type AgentStateListQuery = typeof agentStateListQuerySchema.Type;
