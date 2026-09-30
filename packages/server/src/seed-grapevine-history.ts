import { NodeRuntime } from "@effect/platform-node";
import { layer as databaseLayer, query } from "@sugabots/core/database/database";
import { agent, agentState, pod, workspace, workspaceMember } from "@sugabots/core/database/schema";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

/**
 * Seed a handful of fabricated weekly rollups so grapevine-bot can draw a
 * real-looking SoV line chart before we have five Mondays of actual data.
 * Idempotent. Delete the fakes with `DELETE FROM agent_state WHERE agent_id
 * = ... AND key LIKE 'rollup.2026-08-%' OR key LIKE 'rollup.2026-09-0%' OR
 * key LIKE 'rollup.2026-09-1%' OR key LIKE 'rollup.2026-09-2%'` when the
 * real routine has accumulated enough history to make them redundant.
 */

const WORKSPACE_SLUG = process.env.WORKSPACE_SLUG ?? "dev";
const POD_SLUG = process.env.POD_SLUG ?? "aeo";
const AGENT_HANDLE = process.env.AGENT_HANDLE ?? "grapevine-bot";

const CATEGORIES = ["deploy-intent", "alternatives", "agent-mcp", "features"] as const;
// Slug is the safe key for state, journal entries and Vega-Lite field names.
// A dot in a brand like "Fly.io" would be read as a nested path by Vega-Lite.
const COMPETITORS = [
	"railway",
	"render",
	"flyio",
	"heroku",
	"vercel",
	"digitalocean",
] as const;

// Five weekly rollups ending before the real 2026-09-29 scan. Numbers drift
// plausibly week to week — Suga a scrappy 0–3%, Vercel biggest, Heroku next.
const WEEKS: {
	date: string;
	overallSuga: number;
	overall: Record<(typeof COMPETITORS)[number], number>;
	byCategorySuga: Record<(typeof CATEGORIES)[number], number>;
}[] = [
	{
		date: "2026-08-24",
		overallSuga: 0.5,
		overall: { railway: 8, render: 7, flyio: 6, heroku: 10, vercel: 14, digitalocean: 4 },
		byCategorySuga: { "deploy-intent": 0, alternatives: 1, "agent-mcp": 1.5, features: 0 },
	},
	{
		date: "2026-08-31",
		overallSuga: 1.2,
		overall: { railway: 9, render: 8, flyio: 5, heroku: 12, vercel: 12, digitalocean: 5 },
		byCategorySuga: { "deploy-intent": 0.5, alternatives: 2, "agent-mcp": 2, features: 0 },
	},
	{
		date: "2026-09-07",
		overallSuga: 0.8,
		overall: { railway: 8, render: 7, flyio: 7, heroku: 11, vercel: 15, digitalocean: 6 },
		byCategorySuga: { "deploy-intent": 0, alternatives: 1, "agent-mcp": 2.5, features: 0 },
	},
	{
		date: "2026-09-14",
		overallSuga: 1.8,
		overall: { railway: 7, render: 8, flyio: 6, heroku: 13, vercel: 13, digitalocean: 4 },
		byCategorySuga: { "deploy-intent": 0.5, alternatives: 2.5, "agent-mcp": 3.5, features: 0.5 },
	},
	{
		date: "2026-09-21",
		overallSuga: 1.3,
		overall: { railway: 9, render: 8.5, flyio: 5, heroku: 10, vercel: 14, digitalocean: 3 },
		byCategorySuga: { "deploy-intent": 0, alternatives: 2, "agent-mcp": 3, features: 0 },
	},
];

function rollupFor(week: (typeof WEEKS)[number]) {
	const categories: Record<
		string,
		{
			total_prompts: number;
			suga_mentions: number;
			suga_sov_pct: number;
			competitors: Record<string, { mentions: number; sov_pct: number }>;
		}
	> = {};
	for (const category of CATEGORIES) {
		categories[category] = {
			total_prompts: 10,
			suga_mentions: Math.round(week.byCategorySuga[category] / 10),
			suga_sov_pct: week.byCategorySuga[category],
			competitors: Object.fromEntries(
				COMPETITORS.map((brand) => [
					brand,
					{
						mentions: Math.round((week.overall[brand] * 0.9) / 10),
						sov_pct: Number((week.overall[brand] * (0.85 + Math.random() * 0.3)).toFixed(1)),
					},
				]),
			),
		};
	}
	return {
		scan_date: week.date,
		prompts_scanned: 40,
		prompts_total: 40,
		categories,
		overall: {
			suga_sov_pct: week.overallSuga,
			competitors: Object.fromEntries(COMPETITORS.map((brand) => [brand, week.overall[brand]])),
		},
		top_cited_hosts: [
			{ host: "docs.docker.com", count: 12 },
			{ host: "stackoverflow.com", count: 9 },
			{ host: "vercel.com", count: 7 },
			{ host: "heroku.com", count: 6 },
			{ host: "railway.app", count: 5 },
			{ host: "fly.io", count: 4 },
			{ host: "render.com", count: 4 },
		],
		prev_rollup_exists: true,
		woe_deltas: null,
		_seeded: true,
	};
}

const seed = Effect.gen(function* () {
	const [ws] = yield* query((db) =>
		db.select().from(workspace).where(eq(workspace.slug, WORKSPACE_SLUG)).limit(1),
	);
	if (!ws) return yield* Effect.die(new Error(`Workspace '${WORKSPACE_SLUG}' not found`));
	const [pd] = yield* query((db) =>
		db.select().from(pod).where(and(eq(pod.workspaceId, ws.id), eq(pod.slug, POD_SLUG))).limit(1),
	);
	if (!pd) return yield* Effect.die(new Error(`Pod '${POD_SLUG}' not found`));
	const [gv] = yield* query((db) =>
		db
			.select({ id: agent.id })
			.from(agent)
			.where(and(eq(agent.podId, pd.id), eq(agent.handle, AGENT_HANDLE)))
			.limit(1),
	);
	if (!gv) return yield* Effect.die(new Error("grapevine-bot not found"));
	const [member] = yield* query((db) =>
		db.select().from(workspaceMember).where(eq(workspaceMember.workspaceId, ws.id)).limit(1),
	);
	if (!member) return yield* Effect.die(new Error("no member"));

	for (const week of WEEKS) {
		const rollup = rollupFor(week);
		yield* query((db) =>
			db
				.insert(agentState)
				.values({
					workspaceId: ws.id,
					agentId: gv.id,
					key: `rollup.${week.date}`,
					value: rollup,
					purpose: `[SEEDED FAKE] Aggregated share-of-voice + citations for the ${week.date} scan`,
					source: "human",
					sourceUserId: member.userId,
				})
				.onConflictDoUpdate({
					target: [agentState.agentId, agentState.key],
					set: {
						value: rollup,
						purpose: `[SEEDED FAKE] Aggregated share-of-voice + citations for the ${week.date} scan`,
					},
				}),
		);
		console.log(
			`seeded rollup.${week.date}  suga=${week.overallSuga}%  vercel=${week.overall.vercel}%`,
		);
	}
	console.log(
		"\nDone. Ask grapevine-bot to draw a SoV line chart across the last six rollups.",
	);
});

seed.pipe(Effect.provide(databaseLayer), NodeRuntime.runMain);
