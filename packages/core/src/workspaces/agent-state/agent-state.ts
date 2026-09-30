import type { AgentState } from "@sugabots/contracts";
import { and, eq } from "drizzle-orm";
import { Data, Effect } from "effect";
import type { Authorization } from "../../authorization/authorization.ts";
import type { PodPermission } from "../../authorization/permissions.ts";
import type * as schema from "../../database/schema.ts";
import { agentState } from "../../database/schema.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";

/** An entry on an agent in a workspace. */
export interface Scope {
	readonly workspaceId: string;
	readonly agentId: string;
}

/**
 * The scope of the agent's state, once the current actor may take
 * `permission` on that agent. Callers pass write permission for
 * `remember` / `forget`, read for `recall` / `recall_all`.
 */
export const scopeOf = (
	authorization: Authorization.Interface,
	agentId: string,
	permission: PodPermission,
) =>
	Effect.map(
		authorization.agent(agentId, permission),
		({ agent }): Scope => ({ workspaceId: agent.workspaceId, agentId: agent.id }),
	);

/** `scope`'s rows on `agent_state`. */
export const inScope = (scope: Scope) =>
	and(eq(agentState.workspaceId, scope.workspaceId), eq(agentState.agentId, scope.agentId));

/** DB row → contract shape, with timestamps as ISO strings. */
export function toAgentState(row: schema.AgentStateRow): AgentState {
	return {
		agentId: row.agentId,
		key: row.key,
		value: row.value,
		purpose: row.purpose,
		source: row.source,
		sourceUserId: row.sourceUserId,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

export class AgentStateKeyNotFound
	extends Data.TaggedError("AgentStateKeyNotFound")<{ readonly key: string }>
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`No entry under that key`;
	}
}

export class AgentStateCapExceeded
	extends Data.TaggedError("AgentStateCapExceeded")<{
		readonly limit: "keys" | "value_bytes" | "total_bytes";
		readonly cap: number;
		readonly current: number;
	}>
	implements UserFacing
{
	get userMessage() {
		if (this.limit === "keys") {
			return UserMessage.of`Full. Forget an entry before remembering another.`;
		}
		if (this.limit === "value_bytes") {
			return UserMessage.of`Value is too large for one entry.`;
		}
		return UserMessage.of`No room for that value. Free space by forgetting entries first.`;
	}
}
