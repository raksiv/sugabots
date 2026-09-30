import type { AgentStateWrite } from "@sugabots/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

/**
 * Hooks for an agent's durable state — the workspace UI's view into what the
 * agent has been remembering. Reads need `agent.read`; writes and deletes
 * need `agent.update`, tagged as human-sourced on the server side.
 */

const listKey = (agentId: string) => ["agent-state", agentId] as const;

export function useAgentState(agentId: string | undefined) {
	return useQuery({
		queryKey: listKey(agentId ?? ""),
		queryFn: agentId
			? ({ signal }) =>
					Effect.runPromise(client.api.agentState.list({ params: { agentId }, query: {} }), {
						signal,
					})
			: undefined,
		enabled: agentId !== undefined,
	});
}

export function useWriteAgentState(agentId: string) {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: ({ key, ...payload }: { key: string } & AgentStateWrite) =>
			Effect.runPromise(client.api.agentState.write({ params: { agentId, key }, payload })),
		onSuccess: () => queries.invalidateQueries({ queryKey: listKey(agentId) }),
	});
}

export function useForgetAgentState(agentId: string) {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: (key: string) =>
			Effect.runPromise(client.api.agentState.remove({ params: { agentId, key } })),
		onSuccess: () => queries.invalidateQueries({ queryKey: listKey(agentId) }),
	});
}
