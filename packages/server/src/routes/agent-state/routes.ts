import { BadRequest } from "@sugabots/contracts/http";
import { AgentStateAdministration } from "@sugabots/core/workspaces/agent-state/administration";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const agentStateRoutes = HttpApiBuilder.group(ServerApi, "agentState", (handlers) =>
	Effect.gen(function* () {
		const administration = yield* AgentStateAdministration.Service;
		return handlers
			.handle("list", ({ params, query }) =>
				administration
					.list({ agentId: params.agentId, keyPrefix: query.keyPrefix, after: query.after })
					.pipe(asSessionUser, asHttpError(stateErrors)),
			)
			.handle("get", ({ params }) =>
				administration.get({ agentId: params.agentId, key: params.key }).pipe(
					Effect.flatMap((entry) =>
						entry
							? Effect.succeed(entry)
							: Effect.fail(new BadRequest({ message: "No entry under that key" })),
					),
					asSessionUser,
					asHttpError(stateErrors),
				),
			)
			.handle("write", ({ params, payload }) =>
				administration
					.write({
						agentId: params.agentId,
						key: params.key,
						value: payload.value,
						purpose: payload.purpose,
					})
					.pipe(asSessionUser, asHttpError(stateErrors)),
			)
			.handle("remove", ({ params }) =>
				administration.remove({ agentId: params.agentId, key: params.key }).pipe(
					Effect.map((removed) => ({ removed })),
					asSessionUser,
					asHttpError(stateErrors),
				),
			);
	}),
);

const stateErrors = {
	...refusals,
	AgentStateCapExceeded: BadRequest,
};
