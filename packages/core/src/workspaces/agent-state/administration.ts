export * as AgentStateAdministration from "./administration.ts";

import {
	type AgentState,
	MAX_STATE_KEYS_PER_AGENT,
	MAX_STATE_TOTAL_BYTES_PER_AGENT,
	MAX_STATE_VALUE_BYTES,
	STATE_LIST_PAGE_SIZE,
} from "@sugabots/contracts";
import { Context, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { serviceOperations } from "../../database/database.ts";
import { AgentStateCapExceeded, type Scope, toAgentState } from "./agent-state.ts";
import { AgentStateRepository } from "./repository.ts";

/**
 * HTTP-facing state operations: full-row reads (with `sourceUserId` visible),
 * human writes tagged with the acting user, and deletes. Each method
 * authorises the current actor against the target agent — `agent.read` for
 * `list` / `get`, `agent.update` for `write` / `remove` — before touching
 * `agent_state`.
 */
export interface Interface {
	readonly list: (input: {
		readonly agentId: string;
		readonly keyPrefix?: string;
		readonly after?: string;
	}) => Effect.Effect<
		{
			readonly entries: readonly AgentState[];
			readonly hasMore: boolean;
			readonly usage: { readonly keys: number; readonly totalBytes: number };
		},
		AuthorizationDenied,
		CurrentActor.Service
	>;
	readonly get: (input: {
		readonly agentId: string;
		readonly key: string;
	}) => Effect.Effect<AgentState | undefined, AuthorizationDenied, CurrentActor.Service>;
	readonly write: (input: {
		readonly agentId: string;
		readonly key: string;
		readonly value: unknown;
		readonly purpose: string;
	}) => Effect.Effect<
		AgentState,
		AgentStateCapExceeded | AuthorizationDenied,
		CurrentActor.Service
	>;
	readonly remove: (input: {
		readonly agentId: string;
		readonly key: string;
	}) => Effect.Effect<boolean, AuthorizationDenied, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/AgentStateAdministration",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("AgentStateAdministration");
	const authorization = yield* Authorization.Service;
	const repository = yield* AgentStateRepository.Service;

	const scopeAndActor = (agentId: string, permission: "agent.read" | "agent.update") =>
		Effect.map(authorization.agent(agentId, permission), (standing) => ({
			scope: {
				workspaceId: standing.agent.workspaceId,
				agentId: standing.agent.id,
			} satisfies Scope,
			actor: standing.actor,
		}));

	return Service.of({
		list: (input) =>
			operation(
				"list",
				Effect.gen(function* () {
					const { scope } = yield* scopeAndActor(input.agentId, "agent.read");
					const rows = yield* repository.list(scope, {
						keyPrefix: input.keyPrefix,
						after: input.after,
						limit: STATE_LIST_PAGE_SIZE + 1,
					});
					const usage = yield* repository.usage(scope);
					const hasMore = rows.length > STATE_LIST_PAGE_SIZE;
					return {
						entries: rows.slice(0, STATE_LIST_PAGE_SIZE).map(toAgentState),
						hasMore,
						usage,
					};
				}),
			),

		get: (input) =>
			operation(
				"get",
				Effect.gen(function* () {
					const { scope } = yield* scopeAndActor(input.agentId, "agent.read");
					const row = yield* repository.get(scope, input.key);
					return row ? toAgentState(row) : undefined;
				}),
			),

		write: (input) =>
			operation(
				"write",
				Effect.gen(function* () {
					const { scope, actor } = yield* scopeAndActor(input.agentId, "agent.update");
					const valueBytes = byteSize(input.value);
					if (valueBytes > MAX_STATE_VALUE_BYTES) {
						return yield* new AgentStateCapExceeded({
							limit: "value_bytes",
							cap: MAX_STATE_VALUE_BYTES,
							current: valueBytes,
						});
					}
					const existing = yield* repository.get(scope, input.key);
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
					const row = yield* repository.upsert(scope, {
						key: input.key,
						value: input.value,
						purpose: input.purpose,
						source: "human",
						sourceUserId: actor.userId,
					});
					return toAgentState(row);
				}),
			),

		remove: (input) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const { scope } = yield* scopeAndActor(input.agentId, "agent.update");
					return yield* repository.remove(scope, input.key);
				}),
			),
	});
});

export const layer = Layer.effect(Service, make).pipe(
	Layer.provide(AgentStateRepository.layer),
	Layer.provide(Authorization.layer),
);

/** UTF-8 byte length of the JSON form of `value`. */
function byteSize(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}
