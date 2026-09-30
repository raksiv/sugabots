import { NodeRuntime } from "@effect/platform-node";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { layer as databaseLayer, query } from "@sugabots/core/database/database";
import { agent, pod, workspace, workspaceMember } from "@sugabots/core/database/schema";
import { Ids } from "@sugabots/core/ids/ids";
import { AgentRepository } from "@sugabots/core/workspaces/agents/agent-repository";
import { and, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

const WORKSPACE_SLUG = process.env.WORKSPACE_SLUG ?? "rk";
const POD_SLUG = process.env.POD_SLUG ?? "donkey";
const FROM = process.env.FROM ?? "memory-bot";
const TO = process.env.TO ?? "grapevine-bot";

const run = Effect.gen(function* () {
	const [ws] = yield* query((db) =>
		db.select().from(workspace).where(eq(workspace.slug, WORKSPACE_SLUG)).limit(1),
	);
	if (!ws) return yield* Effect.die(new Error(`Workspace '${WORKSPACE_SLUG}' not found`));

	const [pd] = yield* query((db) =>
		db
			.select()
			.from(pod)
			.where(and(eq(pod.workspaceId, ws.id), eq(pod.slug, POD_SLUG)))
			.limit(1),
	);
	if (!pd) return yield* Effect.die(new Error(`Pod '${POD_SLUG}' not found`));

	const [source] = yield* query((db) =>
		db
			.select({ id: agent.id, model: agent.model })
			.from(agent)
			.where(and(eq(agent.podId, pd.id), eq(agent.handle, FROM)))
			.limit(1),
	);
	if (!source?.model) {
		return yield* Effect.die(new Error(`Source agent '${FROM}' has no model set`));
	}

	const [target] = yield* query((db) =>
		db
			.select({ id: agent.id, model: agent.model })
			.from(agent)
			.where(and(eq(agent.podId, pd.id), eq(agent.handle, TO)))
			.limit(1),
	);
	if (!target) return yield* Effect.die(new Error(`Target agent '${TO}' not found`));

	if (target.model === source.model) {
		console.log(`${TO} already uses ${source.model}`);
		return;
	}

	const agents = yield* AgentRepository.Service;
	yield* agents.update(ws.id, target.id, { model: source.model }).pipe(
		Effect.catchTags({
			AgentNameTaken: () => Effect.die(new Error("unexpected")),
			AgentGone: () => Effect.die(new Error("target vanished")),
			SystemAgentImmutable: () => Effect.die(new Error("target is a system agent")),
		}),
	);
	console.log(`${TO} model: ${target.model ?? "none"} -> ${source.model}`);
}).pipe(
	// Impersonate any workspace member for the authorization the service expects.
	Effect.flatMap((result) =>
		query((db) => db.select().from(workspaceMember).limit(1)).pipe(Effect.as(result)),
	),
	CurrentActor.provide(
		CurrentActor.AuthenticatedUserId.vouchedFor("00000000-0000-0000-0000-000000000000"),
	),
);

run.pipe(
	Effect.scoped,
	Effect.provide(
		Layer.mergeAll(AgentRepository.layer).pipe(
			Layer.provideMerge(Layer.mergeAll(Ids.layer, databaseLayer)),
		),
	),
	NodeRuntime.runMain,
);
