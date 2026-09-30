export * as AgentStateService from "./state.ts";

import {
	type AgentStateRecall,
	type AgentStateSummary,
	MAX_STATE_KEYS_PER_AGENT,
	MAX_STATE_TOTAL_BYTES_PER_AGENT,
	MAX_STATE_VALUE_BYTES,
	STATE_LIST_PAGE_SIZE,
} from "@sugabots/contracts";
import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { type Database, query, serviceOperations } from "../../database/database.ts";
import { agent } from "../../database/schema.ts";
import { AgentStateCapExceeded, type Scope } from "./agent-state.ts";
import { AgentStateRepository } from "./repository.ts";

/**
 * State operations that respect caps, tag writes with their source, and
 * enforce the pod boundary on cross-agent reads.
 *
 * `caller` is the agent asking. When the caller reads their own state, the
 * scope is theirs. When they read a pod-mate's, the service checks the
 * target belongs to the same pod (via the `agent` table) before touching
 * `agent_state`; on failure the read looks the same as an absent key — the
 * pod graph does not leak through the answer.
 */
export interface Caller {
	readonly workspaceId: string;
	readonly agentId: string;
	/** Null for system agents; cross-agent reads are refused when either side is null. */
	readonly podId: string | null;
}

export interface Interface {
	readonly remember: (
		caller: Caller,
		entry: {
			readonly key: string;
			readonly value: unknown;
			readonly purpose: string;
			readonly source: "agent" | "human";
			readonly sourceUserId: string | null;
		},
	) => Effect.Effect<void, AgentStateCapExceeded>;
	readonly recall: (
		caller: Caller,
		key: string,
		from?: string,
	) => Effect.Effect<AgentStateRecall | undefined>;
	readonly recallAll: (
		caller: Caller,
		options: { readonly keyPrefix?: string; readonly after?: string },
		from?: string,
	) => Effect.Effect<{
		readonly entries: readonly AgentStateSummary[];
		readonly hasMore: boolean;
	}>;
	readonly forget: (caller: Caller, key: string) => Effect.Effect<boolean>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/AgentStateService",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("AgentStateService");
	const repository = yield* AgentStateRepository.Service;

	/** The scope the caller may reach, given a target agent (self or pod-mate). */
	const scopeFor = (
		caller: Caller,
		targetHandleOrId: string | undefined,
	): Effect.Effect<Scope | undefined, never, Database> =>
		Effect.gen(function* () {
			if (!targetHandleOrId || targetHandleOrId === caller.agentId) {
				return { workspaceId: caller.workspaceId, agentId: caller.agentId };
			}
			const callerPodId = caller.podId;
			if (!callerPodId) return undefined;
			// Only a crew agent in the same pod is visible. `agent_pod_id_idx`
			// covers this look-up.
			const [target] = yield* query((db) =>
				db
					.select({ id: agent.id, workspaceId: agent.workspaceId })
					.from(agent)
					.where(
						and(
							eq(agent.id, targetHandleOrId),
							eq(agent.workspaceId, caller.workspaceId),
							eq(agent.podId, callerPodId),
						),
					)
					.limit(1),
			);
			if (!target) return undefined;
			return { workspaceId: target.workspaceId, agentId: target.id };
		});

	const toRecall = (row: {
		key: string;
		value: unknown;
		purpose: string;
		source: "agent" | "human";
		updatedAt: Date;
	}): AgentStateRecall => ({
		key: row.key,
		value: row.value,
		purpose: row.purpose,
		source: row.source,
		updatedAt: row.updatedAt.toISOString(),
	});

	const toSummary = (row: {
		key: string;
		purpose: string;
		source: "agent" | "human";
		updatedAt: Date;
	}): AgentStateSummary => ({
		key: row.key,
		purpose: row.purpose,
		source: row.source,
		updatedAt: row.updatedAt.toISOString(),
	});

	return Service.of({
		remember: (caller, entry) =>
			operation(
				"remember",
				Effect.gen(function* () {
					const scope: Scope = { workspaceId: caller.workspaceId, agentId: caller.agentId };
					// Serialised size of just this value, and total-including-this if it
					// is a new key.
					const valueBytes = byteSize(entry.value);
					if (valueBytes > MAX_STATE_VALUE_BYTES) {
						return yield* new AgentStateCapExceeded({
							limit: "value_bytes",
							cap: MAX_STATE_VALUE_BYTES,
							current: valueBytes,
						});
					}
					const existing = yield* repository.get(scope, entry.key);
					const usage = yield* repository.usage(scope);
					const nextKeys = existing ? usage.keys : usage.keys + 1;
					if (nextKeys > MAX_STATE_KEYS_PER_AGENT) {
						return yield* new AgentStateCapExceeded({
							limit: "keys",
							cap: MAX_STATE_KEYS_PER_AGENT,
							current: usage.keys,
						});
					}
					const nextTotal =
						usage.totalBytes - (existing ? byteSize(existing.value) : 0) + valueBytes;
					if (nextTotal > MAX_STATE_TOTAL_BYTES_PER_AGENT) {
						return yield* new AgentStateCapExceeded({
							limit: "total_bytes",
							cap: MAX_STATE_TOTAL_BYTES_PER_AGENT,
							current: usage.totalBytes,
						});
					}
					yield* repository.upsert(scope, entry);
				}),
			),

		recall: (caller, key, from) =>
			operation(
				"recall",
				Effect.gen(function* () {
					const scope = yield* scopeFor(caller, from);
					if (!scope) return undefined;
					const row = yield* repository.get(scope, key);
					if (!row) return undefined;
					return toRecall(row);
				}),
			),

		recallAll: (caller, { keyPrefix, after }, from) =>
			operation(
				"recallAll",
				Effect.gen(function* () {
					const scope = yield* scopeFor(caller, from);
					if (!scope) return { entries: [], hasMore: false };
					// One over the page size to detect "more".
					const rows = yield* repository.list(scope, {
						keyPrefix,
						after,
						limit: STATE_LIST_PAGE_SIZE + 1,
					});
					const hasMore = rows.length > STATE_LIST_PAGE_SIZE;
					return {
						entries: rows.slice(0, STATE_LIST_PAGE_SIZE).map(toSummary),
						hasMore,
					};
				}),
			),

		forget: (caller, key) =>
			operation(
				"forget",
				repository.remove({ workspaceId: caller.workspaceId, agentId: caller.agentId }, key),
			),
	});
});

export const layer = Layer.effect(Service, make).pipe(Layer.provide(AgentStateRepository.layer));

/**
 * A no-op state service, for cases that never touch state (tests, offline
 * scripts). `remember` and `forget` are silent no-ops; `recall` and
 * `recallAll` return nothing.
 */
export const none: Interface = {
	remember: () => Effect.void,
	recall: () => Effect.succeed(undefined),
	recallAll: () => Effect.succeed({ entries: [], hasMore: false }),
	forget: () => Effect.succeed(false),
};

/** UTF-8 byte length of the JSON form of `value`. */
function byteSize(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}
