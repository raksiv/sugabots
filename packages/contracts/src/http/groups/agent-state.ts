import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	agentStateKeySchema,
	agentStateListQuerySchema,
	agentStatePageSchema,
	agentStateSchema,
	agentStateWriteSchema,
} from "../../agent-state.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

const agent = { agentId: uuidSchema };
const entry = { agentId: uuidSchema, key: agentStateKeySchema };

/**
 * Read, write and delete one agent's durable state. Reads need `agent.read`;
 * writes and deletes need `agent.update`. Writes always tag the row as
 * human-sourced.
 */
export class AgentStateApi extends HttpApiGroup.make("agentState")
	.add(
		HttpApiEndpoint.get("list", "/agents/:agentId/state", {
			params: agent,
			query: agentStateListQuerySchema,
			success: agentStatePageSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("get", "/agents/:agentId/state/:key", {
			params: entry,
			success: agentStateSchema,
			error: refused,
		}),
		HttpApiEndpoint.put("write", "/agents/:agentId/state/:key", {
			params: entry,
			payload: agentStateWriteSchema,
			success: agentStateSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.delete("remove", "/agents/:agentId/state/:key", {
			params: entry,
			success: Schema.Struct({ removed: Schema.Boolean }).pipe(HttpApiSchema.status(200)),
			error: refused,
		}),
	)
	.middleware(Session) {}
