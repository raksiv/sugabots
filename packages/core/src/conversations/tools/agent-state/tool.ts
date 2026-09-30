import {
	MAX_STATE_KEY_CHARACTERS,
	MAX_STATE_PURPOSE_CHARACTERS,
	MAX_STATE_VALUE_BYTES,
} from "@sugabots/contracts";
import { tool } from "ai";
import { Effect, Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { AgentStateService } from "../../../workspaces/agent-state/state.ts";

export const REMEMBER_TOOL = "remember";
export const RECALL_TOOL = "recall";
export const RECALL_ALL_TOOL = "recall_all";
export const FORGET_TOOL = "forget";

export interface StateToolOptions {
	readonly caller: AgentStateService.Caller;
	readonly state: Pick<AgentStateService.Interface, "remember" | "recall" | "recallAll" | "forget">;
	readonly run: RunEffect;
}

const keySchema = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_STATE_KEY_CHARACTERS),
);

const purposeSchema = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_STATE_PURPOSE_CHARACTERS),
);

/**
 * `remember` — write one key of the agent's own durable state. Overwrites
 * any prior value under that key. The `purpose` is what shows up in the
 * agent's memory panel and in `recall_all`, so it should be a short
 * sentence explaining why the entry exists. Values are JSON of any shape.
 */
export function rememberTool({ caller, state, run }: StateToolOptions) {
	return tool({
		description: `Save a piece of durable state under a key so you (and pod-mates who peek) can read it back on later turns. Overwrites the entry if the key was already set. Values are JSON of any shape but must serialise to at most ${MAX_STATE_VALUE_BYTES.toLocaleString()} bytes; the purpose is a short sentence explaining why this entry exists, shown to humans reviewing memory.`,
		inputSchema: Schema.Struct({
			key: keySchema.annotate({
				description: 'The stable name for this entry, e.g. "panel.competitors".',
			}),
			value: Schema.Unknown.annotate({
				description: "Any JSON value.",
			}),
			purpose: purposeSchema.annotate({
				description: "One short sentence: why this entry exists.",
			}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async ({ key, value, purpose }) =>
			run(
				state.remember(caller, { key, value, purpose, source: "agent", sourceUserId: null }).pipe(
					// Turn a domain error into an agent-facing string so the model can
					// choose to forget an old key and try again.
					Effect.match({
						onSuccess: () => ({ ok: true as const }),
						onFailure: (error) => ({
							ok: false as const,
							error:
								error.limit === "keys"
									? `Your memory is full (${error.current}/${error.cap} keys). Forget an entry first.`
									: error.limit === "value_bytes"
										? `Value is too large (${error.current} > ${error.cap} bytes). Shrink or split it.`
										: `Not enough room (${error.current}/${error.cap} bytes stored). Forget entries to free space.`,
						}),
					}),
				),
			),
	});
}

/**
 * `recall` — read one entry from the agent's own state, or from a pod-mate's
 * when `from` is given. The pod-mate is named by its id or handle. When
 * nothing matches (key absent, or the target isn't a pod-mate) the tool
 * returns `undefined` — the pod graph is not disclosed through the error.
 */
export function recallTool({ caller, state, run }: StateToolOptions) {
	return tool({
		description:
			"Read one durable-state entry. Without `from`, reads your own memory. With `from`, reads a pod-mate's memory by their agent id or handle. Returns the value, its purpose, the source ('agent' or 'human'), and when it was last updated. Returns nothing if the key isn't set or the pod-mate isn't reachable.",
		inputSchema: Schema.Struct({
			key: keySchema,
			from: Schema.optional(
				keySchema.annotate({
					description: "A pod-mate's agent id or handle to read from instead of your own memory.",
				}),
			),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async ({ key, from }) => (await run(state.recall(caller, key, from))) ?? null,
	});
}

/**
 * `recall_all` — list keys the agent (or a pod-mate) has stored, oldest key
 * first. Returns purposes and source flags, not values — call `recall` for
 * the value of one entry.
 */
export function recallAllTool({ caller, state, run }: StateToolOptions) {
	return tool({
		description:
			"List the keys you (or a pod-mate) have stored, with each entry's purpose, source and last-updated time. Values are not included; call `recall` for a specific value. Paginated by `after` (the last key seen), narrowed by `keyPrefix`.",
		inputSchema: Schema.Struct({
			keyPrefix: Schema.optional(
				keySchema.annotate({ description: "Only keys starting with this prefix." }),
			),
			after: Schema.optional(
				keySchema.annotate({
					description: "Continue the list past this key, exclusive.",
				}),
			),
			from: Schema.optional(
				keySchema.annotate({
					description: "A pod-mate's agent id or handle to list instead of your own memory.",
				}),
			),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async ({ keyPrefix, after, from }) =>
			run(state.recallAll(caller, { keyPrefix, after }, from)),
	});
}

/**
 * `forget` — remove one entry from the agent's own state. Idempotent: no
 * error when the key is already absent.
 */
export function forgetTool({ caller, state, run }: StateToolOptions) {
	return tool({
		description:
			"Remove one entry from your durable state. Safe to call on a key that isn't set — the tool simply reports whether anything was removed.",
		inputSchema: Schema.Struct({ key: keySchema }).pipe(
			Schema.toStandardSchemaV1,
			Schema.toStandardJSONSchemaV1,
		),
		execute: async ({ key }) => ({ removed: await run(state.forget(caller, key)) }),
	});
}
