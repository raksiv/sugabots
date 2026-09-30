export * as AgentStateRepository from "./repository.ts";

import { and, asc, eq, gt, like, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { query, serviceOperations } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { agentState } from "../../database/schema.ts";
import { inScope, type Scope } from "./agent-state.ts";

/**
 * The only writer of `agent_state`. Bare CRUD with pagination and a usage
 * roll-up; caps and source tagging live in `AgentStateService`.
 */
export interface Interface {
	readonly get: (scope: Scope, key: string) => Effect.Effect<schema.AgentStateRow | undefined>;
	/**
	 * Rows ordered by key. `after` is the last key seen; `keyPrefix` narrows to
	 * keys starting with the prefix.
	 */
	readonly list: (
		scope: Scope,
		options: { readonly keyPrefix?: string; readonly after?: string; readonly limit: number },
	) => Effect.Effect<readonly schema.AgentStateRow[]>;
	/** Upserts by (agentId, key). Returns the persisted row. */
	readonly upsert: (
		scope: Scope,
		entry: {
			readonly key: string;
			readonly value: unknown;
			readonly purpose: string;
			readonly source: "agent" | "human";
			readonly sourceUserId: string | null;
		},
	) => Effect.Effect<schema.AgentStateRow>;
	/** Removes one key. `false` when nothing was there. */
	readonly remove: (scope: Scope, key: string) => Effect.Effect<boolean>;
	/**
	 * How many keys and how many bytes of serialised `value` this agent holds.
	 * `totalBytes` is the sum of `octet_length((value)::text)` — the same shape
	 * a client budget sees, portable across drivers.
	 */
	readonly usage: (
		scope: Scope,
	) => Effect.Effect<{ readonly keys: number; readonly totalBytes: number }>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/AgentStateRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("AgentStateRepository");
	return Service.of({
		get: (scope, key) =>
			operation(
				"get",
				Effect.map(
					query((db) =>
						db
							.select()
							.from(agentState)
							.where(and(inScope(scope), eq(agentState.key, key)))
							.limit(1),
					),
					([row]) => row,
				),
			),

		list: (scope, { keyPrefix, after, limit }) =>
			operation(
				"list",
				query((db) => {
					const conditions = [inScope(scope)];
					if (keyPrefix) conditions.push(like(agentState.key, `${keyPrefix}%`));
					if (after) conditions.push(gt(agentState.key, after));
					return db
						.select()
						.from(agentState)
						.where(and(...conditions))
						.orderBy(asc(agentState.key))
						.limit(limit);
				}),
			),

		upsert: (scope, entry) =>
			operation(
				"upsert",
				Effect.map(
					query((db) =>
						db
							.insert(agentState)
							.values({
								workspaceId: scope.workspaceId,
								agentId: scope.agentId,
								key: entry.key,
								value: entry.value,
								purpose: entry.purpose,
								source: entry.source,
								sourceUserId: entry.sourceUserId,
							})
							.onConflictDoUpdate({
								target: [agentState.agentId, agentState.key],
								set: {
									value: entry.value,
									purpose: entry.purpose,
									source: entry.source,
									sourceUserId: entry.sourceUserId,
								},
							})
							.returning(),
					),
					// insert...returning always yields a row when there is no conflict
					// path that skips it; onConflictDoUpdate updates, so a row is written
					// either way.
					([row]) => row as schema.AgentStateRow,
				),
			),

		remove: (scope, key) =>
			operation(
				"remove",
				Effect.map(
					query((db) =>
						db
							.delete(agentState)
							.where(and(inScope(scope), eq(agentState.key, key)))
							.returning({ id: agentState.id }),
					),
					(rows) => rows.length > 0,
				),
			),

		usage: (scope) =>
			operation(
				"usage",
				Effect.map(
					query((db) =>
						db
							.select({
								keys: sql<string>`count(*)::text`,
								totalBytes: sql<string>`coalesce(sum(octet_length(${agentState.value}::text)), 0)::text`,
							})
							.from(agentState)
							.where(inScope(scope)),
					),
					([row]) => ({
						keys: Number(row?.keys ?? 0),
						totalBytes: Number(row?.totalBytes ?? 0),
					}),
				),
			),
	});
});

export const layer = Layer.effect(Service, make);
