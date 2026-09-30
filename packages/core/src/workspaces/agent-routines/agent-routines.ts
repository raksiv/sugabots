export * as AgentRoutines from "./agent-routines.ts";

import type { Routine } from "@sugabots/contracts";
import { and, eq, isNull } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import { toRoutine } from "../../conversations/routines/routine.ts";
import {
	type InvalidRoutineSchedule,
	nextOccurrence,
} from "../../conversations/routines/schedule.ts";
import { query, serviceOperations } from "../../database/database.ts";
import { routine } from "../../database/schema.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";

/**
 * Agent-facing routine operations, for the `schedule`, `list_schedules`
 * and `unschedule` tools. Unlike `Routines`, these are called from inside
 * a turn: the agent's identity comes from the caller, no session actor
 * applies, and routines land with `createdById = null` so the row still
 * survives a workspace's people coming and going.
 *
 * Kept intentionally small — creates, lists and soft-deletes cron
 * routines. Anything richer (webhook triggers, manual runs, secret
 * rotation) belongs on the human-facing `Routines` service instead.
 */
export interface Caller {
	readonly workspaceId: string;
	readonly agentId: string;
}

export interface Interface {
	readonly schedule: (
		caller: Caller,
		input: {
			readonly name: string;
			readonly instructions: string;
			readonly cron: string;
			readonly timezone: string;
		},
	) => Effect.Effect<Routine, InvalidRoutineSchedule | AgentRoutineNameTaken>;
	readonly list: (caller: Caller) => Effect.Effect<readonly Routine[]>;
	readonly unschedule: (caller: Caller, routineId: string) => Effect.Effect<boolean>;
	/**
	 * Nudges an existing routine to fire on the scheduler's next poll (within
	 * ~15 seconds) by resetting its `nextScheduledAt` to now. Returns `true`
	 * when the routine was nudged, `false` when there is no such routine on
	 * this agent, and `disabled` when the routine exists but is paused.
	 *
	 * Nudging rather than starting an execution keeps this service free of
	 * thread / workflow dependencies; the actual run is opened by the same
	 * path that opens weekly runs, so its history is indistinguishable from
	 * a scheduled fire.
	 */
	readonly runNow: (
		caller: Caller,
		routineId: string,
	) => Effect.Effect<"nudged" | "disabled" | "not_found">;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/AgentRoutines",
) {}

export class AgentRoutineNameTaken
	extends Data.TaggedError("AgentRoutineNameTaken")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`A routine with that name already exists`;
	}
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("AgentRoutines");

	return Service.of({
		schedule: (caller, input) =>
			operation(
				"schedule",
				Effect.gen(function* () {
					const now = yield* DateTime.nowAsDate;
					const next = yield* nextOccurrence(input.cron, input.timezone, now);
					const existing = yield* query((db) =>
						db
							.select({ id: routine.id })
							.from(routine)
							.where(
								and(
									eq(routine.workspaceId, caller.workspaceId),
									eq(routine.agentId, caller.agentId),
									eq(routine.name, input.name),
									isNull(routine.deletedAt),
								),
							)
							.limit(1),
					);
					if (existing.length > 0) return yield* new AgentRoutineNameTaken();
					const [row] = yield* query((db) =>
						db
							.insert(routine)
							.values({
								workspaceId: caller.workspaceId,
								agentId: caller.agentId,
								createdById: null,
								name: input.name,
								instructions: input.instructions,
								triggerKind: "cron",
								cronExpression: input.cron,
								cronTimezone: input.timezone,
								nextScheduledAt: next,
								webhookSecretDigest: null,
								state: "enabled",
							})
							.returning(),
					);
					if (!row) return yield* Effect.die(new Error("routine insert returned no row"));
					return toRoutine(row);
				}),
			),

		list: (caller) =>
			operation(
				"list",
				Effect.map(
					query((db) =>
						db
							.select()
							.from(routine)
							.where(
								and(
									eq(routine.workspaceId, caller.workspaceId),
									eq(routine.agentId, caller.agentId),
									isNull(routine.deletedAt),
								),
							),
					),
					(rows) => rows.map(toRoutine),
				),
			),

		unschedule: (caller, routineId) =>
			operation(
				"unschedule",
				Effect.gen(function* () {
					const now = yield* DateTime.nowAsDate;
					const [removed] = yield* query((db) =>
						db
							.update(routine)
							.set({ deletedAt: now, state: "paused", nextScheduledAt: null })
							.where(
								and(
									eq(routine.id, routineId),
									eq(routine.workspaceId, caller.workspaceId),
									eq(routine.agentId, caller.agentId),
									isNull(routine.deletedAt),
								),
							)
							.returning({ id: routine.id }),
					);
					return removed !== undefined;
				}),
			),

		runNow: (caller, routineId) =>
			operation(
				"runNow",
				Effect.gen(function* () {
					const [existing] = yield* query((db) =>
						db
							.select({ id: routine.id, state: routine.state })
							.from(routine)
							.where(
								and(
									eq(routine.id, routineId),
									eq(routine.workspaceId, caller.workspaceId),
									eq(routine.agentId, caller.agentId),
									isNull(routine.deletedAt),
								),
							)
							.limit(1),
					);
					if (!existing) return "not_found" as const;
					if (existing.state !== "enabled") return "disabled" as const;
					const now = yield* DateTime.nowAsDate;
					yield* query((db) =>
						db.update(routine).set({ nextScheduledAt: now }).where(eq(routine.id, routineId)),
					);
					return "nudged" as const;
				}),
			),
	});
});

export const layer = Layer.effect(Service, make);

/** No-op service for tests. */
export const none: Interface = {
	schedule: () => Effect.die(new Error("Test tried to schedule a routine")),
	list: () => Effect.succeed([]),
	unschedule: () => Effect.succeed(false),
	runNow: () => Effect.succeed("not_found"),
};
