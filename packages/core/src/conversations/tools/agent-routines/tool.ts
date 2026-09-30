import {
	MAX_CRON_EXPRESSION_CHARACTERS,
	MAX_ROUTINE_INSTRUCTIONS_CHARACTERS,
	MAX_ROUTINE_NAME_CHARACTERS,
	MAX_TIMEZONE_CHARACTERS,
} from "@sugabots/contracts";
import { tool } from "ai";
import { Effect, Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { AgentRoutines } from "../../../workspaces/agent-routines/agent-routines.ts";

export const SCHEDULE_TOOL = "schedule";
export const LIST_SCHEDULES_TOOL = "list_schedules";
export const UNSCHEDULE_TOOL = "unschedule";
export const RUN_SCHEDULE_TOOL = "run_schedule";

export interface RoutineToolOptions {
	readonly caller: AgentRoutines.Caller;
	readonly routines: Pick<AgentRoutines.Interface, "schedule" | "list" | "unschedule" | "runNow">;
	readonly run: RunEffect;
}

const nameSchema = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ROUTINE_NAME_CHARACTERS),
);
const instructionsSchema = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ROUTINE_INSTRUCTIONS_CHARACTERS),
);
const cronSchema = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_CRON_EXPRESSION_CHARACTERS),
);
const timezoneSchema = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_TIMEZONE_CHARACTERS),
);

/**
 * `schedule` — create a cron-triggered routine on this agent. When it
 * fires, the agent runs `instructions` in a fresh thread. Standard
 * five-field cron; the timezone is an IANA name.
 */
export function scheduleTool({ caller, routines, run }: RoutineToolOptions) {
	return tool({
		description:
			"Schedule a recurring task for yourself. Give it a name, the instructions to run when it fires, a five-field cron expression, and an IANA timezone. Returns the routine's id so you can `unschedule` it later.",
		inputSchema: Schema.Struct({
			name: nameSchema.annotate({ description: "Short name for the routine." }),
			instructions: instructionsSchema.annotate({
				description: "What you should do each time it fires.",
			}),
			cron: cronSchema.annotate({
				description: 'Five-field cron, e.g. "0 15 * * 1" for Mondays at 15:00.',
			}),
			timezone: timezoneSchema.annotate({
				description: 'IANA time zone, e.g. "UTC" or "America/Denver".',
			}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async (input) =>
			run(
				routines.schedule(caller, input).pipe(
					Effect.match({
						onSuccess: (routine) => ({
							ok: true as const,
							routineId: routine.id,
							nextRun: routine.trigger.kind === "cron" ? routine.trigger.nextScheduledAt : null,
						}),
						onFailure: (error) => ({
							ok: false as const,
							error:
								error._tag === "AgentRoutineNameTaken"
									? "A routine with that name already exists."
									: `Invalid schedule: ${error.reason}.`,
						}),
					}),
				),
			),
	});
}

/**
 * `list_schedules` — list the agent's own routines with their triggers and
 * instructions.
 */
export function listSchedulesTool({ caller, routines, run }: RoutineToolOptions) {
	return tool({
		description:
			"List the recurring routines you own, with each one's id, name, cron and next scheduled fire time.",
		inputSchema: Schema.Struct({}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async () =>
			run(
				routines.list(caller).pipe(
					Effect.map((all) =>
						all.map((routine) => ({
							id: routine.id,
							name: routine.name,
							instructions: routine.instructions,
							trigger: routine.trigger,
							state: routine.state,
						})),
					),
				),
			),
	});
}

/**
 * `unschedule` — cancel one of the agent's own routines by id. Idempotent.
 */
export function unscheduleTool({ caller, routines, run }: RoutineToolOptions) {
	return tool({
		description: "Cancel one of your own routines by id. Safe to call on a routine already gone.",
		inputSchema: Schema.Struct({
			routineId: Schema.String.annotate({
				description: "The routine's id, from `list_schedules`.",
			}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async ({ routineId }) =>
			run(routines.unschedule(caller, routineId).pipe(Effect.map((removed) => ({ removed })))),
	});
}

/**
 * `run_schedule` — fire one of the agent's own routines now, instead of
 * waiting for the next cron time. The scheduler polls every ~15 seconds,
 * so the run starts shortly after this returns. Useful for testing a
 * routine or firing it out of band.
 */
export function runScheduleTool({ caller, routines, run }: RoutineToolOptions) {
	return tool({
		description:
			"Fire one of your own routines now, without waiting for the cron. The scheduler picks it up within ~15 seconds and the run posts into the routine's usual thread. Returns whether the routine was nudged, is paused, or does not exist.",
		inputSchema: Schema.Struct({
			routineId: Schema.String.annotate({
				description: "The routine's id, from `list_schedules`.",
			}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async ({ routineId }) =>
			run(
				routines.runNow(caller, routineId).pipe(
					Effect.map((outcome) => {
						if (outcome === "nudged") return { ok: true as const };
						if (outcome === "disabled") {
							return { ok: false as const, error: "That routine is paused." };
						}
						return { ok: false as const, error: "No routine with that id." };
					}),
				),
			),
	});
}
