import { NodeRuntime } from "@effect/platform-node";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { nextOccurrence } from "@sugabots/core/conversations/routines/schedule";
import { layer as databaseLayer, query } from "@sugabots/core/database/database";
import { agent, pod, routine, workspace, workspaceMember } from "@sugabots/core/database/schema";
import { Ids } from "@sugabots/core/ids/ids";
import { AgentStateRepository } from "@sugabots/core/workspaces/agent-state/repository";
import { AgentRepository } from "@sugabots/core/workspaces/agents/agent-repository";
import { PodRepository } from "@sugabots/core/workspaces/pods/pod-repository";
import { and, eq, isNull } from "drizzle-orm";
import { DateTime, Effect, Layer } from "effect";

/**
 * One-shot setup for the Grapevine agent: creates the pod and agent
 * (idempotently) in the given workspace, seeds its panel state, refreshes
 * its prompt and model on re-run, and schedules the weekly-scan routine.
 * Run against a database that has already been through `bun run db:seed`.
 *
 *   bun --env-file .env packages/server/src/setup-grapevine.ts
 *
 * Env vars override the defaults:
 *   WORKSPACE_SLUG=dev POD_SLUG=aeo MODEL=claude-sonnet-4-5
 *   AGENT_NAME=Grapevine AGENT_HANDLE=grapevine-bot POD_NAME=AEO
 */

const WORKSPACE_SLUG = process.env.WORKSPACE_SLUG ?? "dev";
const POD_SLUG = process.env.POD_SLUG ?? "aeo";
const POD_NAME = process.env.POD_NAME ?? "AEO";
const MODEL = process.env.MODEL ?? "claude-sonnet-4-5";
const AGENT_NAME = process.env.AGENT_NAME ?? "Grapevine";
const AGENT_HANDLE = process.env.AGENT_HANDLE ?? "grapevine-bot";

const INSTRUCTIONS = `You are grapevine-bot. Your job is to track how often Suga (suga.app) is mentioned when people ask AI search engines about deploy platforms, and to notice when competitors get recommended over us.

Your reference data lives in your Memory under three keys:
- panel.prompts — an array of 40 prompts, each with slug, category, text
- panel.competitors — the six competitor brands. Each has { brand, slug, host }. \`slug\` is the safe identifier to use as an object key or Vega-Lite field name. \`brand\` is the human display name (e.g. "Fly.io").
- panel.own — Suga's own host and brand name

Read them with \`recall\` before you start a scan.

Every raw scan response lives in Memory too, under key scan.YYYY-MM-DD.<slug>, with purpose "Raw web_search result for <slug> on YYYY-MM-DD". Weekly rollups go under rollup.YYYY-MM-DD.

Two things you do:

**Run a weekly scan.** Say "starting scan for YYYY-MM-DD". For every prompt in panel.prompts (or the subset the user names), call web_search with the prompt text, then \`remember\` the answer summary + citations under scan.YYYY-MM-DD.<slug>. When you finish all prompts, compute a rollup: per-category share-of-voice for Suga and each competitor (key competitors by \`slug\`, not \`brand\`), top-cited hosts. \`remember\` it under rollup.YYYY-MM-DD with purpose "Aggregated share-of-voice + citations for the YYYY-MM-DD scan". Post a short digest summarising the week: Suga's overall SoV, top competitors (use \`brand\` for display), top cited hosts, and one paragraph on what shifted vs. the previous rollup. Include a chart via render_chart showing per-category SoV as a bar chart. Read the previous rollup with recall to compute WoW deltas.

**Answer ad-hoc questions.** When asked "how's my AEO this week?" or similar, read the latest rollup and give a headline paragraph, top competitors, and a bar-chart via render_chart. If asked about a specific category or competitor, filter the rollup accordingly. If asked about content ideas, look at prompts where Suga is absent or mentioned-not-recommended in the latest rollup — those are the gaps to write against.

**Chart field names.** When you build a chart, use \`slug\` values ("suga", "vercel", "flyio", "digitalocean") for object keys, fold field lists and Vega-Lite \`field:\` references — never \`brand\` strings, since a name like "Fly.io" contains a dot and Vega-Lite reads it as a nested path (Fly → io) and silently drops the series. If you want the legend to say "Fly.io" instead of "flyio", add a \`calculate\` transform that maps slug to brand (e.g. \`{ "as": "brand_label", "calculate": "{'suga': 'Suga', 'flyio': 'Fly.io', ...}[datum.brand]" }\`) and use the mapped field in \`encoding.color\`.

A scan takes a while: 40 prompts × one search each. The turn will segment; keep going until the panel is exhausted. If web_search returns nothing usable for a prompt, remember {"error": "no results"} under its scan.YYYY-MM-DD.<slug> and move on. Never guess.`;

const PANEL_PROMPTS = [
	{
		slug: "deploy-docker-container-prod",
		category: "deploy-intent",
		text: "What's the easiest way to deploy a Docker container to production?",
	},
	{
		slug: "deploy-docker-compose-cloud",
		category: "deploy-intent",
		text: "How do I deploy a docker-compose app to the cloud?",
	},
	{
		slug: "best-fullstack-with-db",
		category: "deploy-intent",
		text: "Best platform to deploy a full-stack app with a database",
	},
	{
		slug: "easiest-web-app-no-servers",
		category: "deploy-intent",
		text: "Easiest way to deploy a web app without managing servers",
	},
	{
		slug: "host-postgres-cheap",
		category: "deploy-intent",
		text: "How do I host a PostgreSQL database alongside my app cheaply?",
	},
	{
		slug: "best-paas-small-teams-2026",
		category: "deploy-intent",
		text: "Best PaaS for small teams in 2026",
	},
	{
		slug: "nextjs-with-workers",
		category: "deploy-intent",
		text: "Where should I deploy a Next.js app that also has background workers?",
	},
	{
		slug: "fastapi-postgres-prod",
		category: "deploy-intent",
		text: "How can I deploy a FastAPI app with Postgres to production?",
	},
	{
		slug: "zero-downtime-container",
		category: "deploy-intent",
		text: "Simplest way to get zero-downtime deployments for a containerized app",
	},
	{
		slug: "dockerfile-free-tier",
		category: "deploy-intent",
		text: "Where can I deploy an app from a Dockerfile with a free tier?",
	},
	{
		slug: "heroku-like-for-docker",
		category: "deploy-intent",
		text: "Best Heroku-like platform for Docker containers",
	},
	{
		slug: "multi-service-together",
		category: "deploy-intent",
		text: "How do I deploy multiple services (API + frontend + database) together?",
	},
	{
		slug: "best-railway-alternatives",
		category: "alternatives",
		text: "What are the best Railway alternatives?",
	},
	{
		slug: "best-render-alternatives",
		category: "alternatives",
		text: "What are the best Render alternatives?",
	},
	{
		slug: "best-heroku-alt-2026",
		category: "alternatives",
		text: "Best Heroku alternative in 2026",
	},
	{
		slug: "fly-railway-render-vs",
		category: "alternatives",
		text: "Fly.io vs Railway vs Render — which should I pick?",
	},
	{
		slug: "cheaper-vercel-fullstack",
		category: "alternatives",
		text: "Cheaper alternative to Vercel for full-stack apps",
	},
	{
		slug: "railway-vs-suga",
		category: "alternatives",
		text: "Railway vs Suga — how do they compare?",
	},
	{
		slug: "is-suga-good-docker",
		category: "alternatives",
		text: "Is Suga (suga.app) a good platform for deploying Docker apps?",
	},
	{
		slug: "heroku-alt-free-tier",
		category: "alternatives",
		text: "Alternatives to Heroku with a free tier",
	},
	{
		slug: "best-do-app-platform-alt",
		category: "alternatives",
		text: "Best DigitalOcean App Platform alternative",
	},
	{
		slug: "migrate-from-heroku",
		category: "alternatives",
		text: "What platform should I migrate to from Heroku?",
	},
	{ slug: "host-mcp-server", category: "agent-mcp", text: "Where can I host an MCP server?" },
	{
		slug: "deploy-mcp-server-prod",
		category: "agent-mcp",
		text: "How do I deploy an MCP server to production?",
	},
	{
		slug: "host-long-running-ai-agent",
		category: "agent-mcp",
		text: "Best way to host a long-running AI agent",
	},
	{
		slug: "deploy-agent-workers-continuous",
		category: "agent-mcp",
		text: "Where should I deploy AI agent workers that run continuously?",
	},
	{
		slug: "host-langgraph-agent",
		category: "agent-mcp",
		text: "How do I host a LangGraph or agent backend?",
	},
	{
		slug: "ai-agents-persistent-state",
		category: "agent-mcp",
		text: "Best hosting for AI agents that need persistent state",
	},
	{
		slug: "deploy-openai-claude-web-service",
		category: "agent-mcp",
		text: "What's the best platform to deploy an OpenAI/Claude-powered agent as a web service?",
	},
	{
		slug: "scheduled-ai-jobs-cheap",
		category: "agent-mcp",
		text: "Where should I run scheduled AI jobs / background LLM workers cheaply?",
	},
	{
		slug: "paas-env-forking-preview",
		category: "features",
		text: "Which PaaS has environment forking or preview environments for Docker apps?",
	},
	{
		slug: "import-docker-compose-yml",
		category: "features",
		text: "Is there a platform that can import a docker-compose.yml and deploy it?",
	},
	{
		slug: "byoc-paas-options",
		category: "features",
		text: "What are the bring-your-own-cloud PaaS options?",
	},
	{
		slug: "paas-visual-canvas",
		category: "features",
		text: "Is there a PaaS with a visual infrastructure designer or canvas?",
	},
	{
		slug: "instant-rollback-containers",
		category: "features",
		text: "Which deploy platforms have instant rollback for containers?",
	},
	{
		slug: "managed-cdn-ddos-docker",
		category: "features",
		text: "Managed platform with built-in CDN and DDoS protection for Docker apps?",
	},
	{
		slug: "self-hosted-db-postgres-redis",
		category: "features",
		text: "Best options for a self-hosted database (Postgres/Redis) on a PaaS?",
	},
	{
		slug: "fastest-deploy-times",
		category: "features",
		text: "Which PaaS has the fastest deploy times?",
	},
	{
		slug: "paas-any-language-docker",
		category: "features",
		text: "Which PaaS supports any language via Docker?",
	},
	{
		slug: "paas-hatchet-background-jobs",
		category: "features",
		text: "How do I run Hatchet (or another background job queue) on a PaaS?",
	},
];

// `slug` is the safe key to use in memory and chart fields (Vega-Lite treats
// dots in field names as nested paths). `brand` stays as the pretty display
// name for chart legends and text.
const PANEL_COMPETITORS = [
	{ brand: "Railway", slug: "railway", host: "railway.app" },
	{ brand: "Render", slug: "render", host: "render.com" },
	{ brand: "Fly.io", slug: "flyio", host: "fly.io" },
	{ brand: "Heroku", slug: "heroku", host: "heroku.com" },
	{ brand: "Vercel", slug: "vercel", host: "vercel.com" },
	{ brand: "DigitalOcean", slug: "digitalocean", host: "digitalocean.com" },
];

const PANEL_OWN = { brand: "Suga", host: "suga.app" };

const ROUTINE_NAME = "weekly-scan";
const ROUTINE_CRON = "0 15 * * 1";
const ROUTINE_TIMEZONE = "UTC";
const ROUTINE_INSTRUCTIONS = `Run the weekly grapevine scan.

Use today's date as the scan date. Read panel.prompts. For every prompt, call web_search with its text, then \`remember\` the answer summary + citations under scan.YYYY-MM-DD.<slug>.

Once every prompt is remembered, compute a rollup: per-category share of voice for Suga and each competitor from panel.competitors, top-cited hosts. Remember it as rollup.YYYY-MM-DD (purpose: "Aggregated share-of-voice + citations for the YYYY-MM-DD scan"). Read the previous rollup for WoW deltas.

Post a digest as your reply: Suga's overall SoV, top 3 competitors, top 4 cited hosts, and one paragraph on what shifted vs. last week. Include a bar chart via render_chart of per-category SoV.`;

const setup = Effect.gen(function* () {
	// Find the workspace; the pod is created if it does not exist.
	const [ws] = yield* query((db) =>
		db.select().from(workspace).where(eq(workspace.slug, WORKSPACE_SLUG)).limit(1),
	);
	if (!ws) {
		return yield* Effect.die(
			new Error(`Workspace '${WORKSPACE_SLUG}' not found — run 'bun run db:seed' first`),
		);
	}

	// Pick any member of the workspace to attribute the seed to. In a personal
	// workspace this is one person, so the choice is trivial.
	const [member] = yield* query((db) =>
		db.select().from(workspaceMember).where(eq(workspaceMember.workspaceId, ws.id)).limit(1),
	);
	if (!member) {
		return yield* Effect.die(new Error(`Workspace '${WORKSPACE_SLUG}' has no members`));
	}

	const pods = yield* PodRepository.Service;
	const agents = yield* AgentRepository.Service;
	const state = yield* AgentStateRepository.Service;

	const [existingPod] = yield* query((db) =>
		db
			.select()
			.from(pod)
			.where(and(eq(pod.workspaceId, ws.id), eq(pod.slug, POD_SLUG)))
			.limit(1),
	);
	const pd =
		existingPod ??
		(yield* pods.create(ws.id, {
			creatorId: member.userId,
			name: POD_NAME,
			slug: POD_SLUG,
		}));
	console.log(existingPod ? `pod ${POD_SLUG} exists` : `pod ${POD_SLUG} created`);

	// Create the agent if it does not exist, and update it if it does. Model
	// choice is best-effort: if the workspace has not enabled the given model,
	// the agent is still created and the user can pick another in the UI.
	const [existing] = yield* query((db) =>
		db
			.select()
			.from(agent)
			.where(
				and(eq(agent.workspaceId, ws.id), eq(agent.podId, pd.id), eq(agent.handle, AGENT_HANDLE)),
			)
			.limit(1),
	);
	let agentId: string;
	if (existing) {
		agentId = existing.id;
		yield* query((db) =>
			db.update(agent).set({ prompt: INSTRUCTIONS, model: MODEL }).where(eq(agent.id, agentId)),
		);
		console.log(`agent @${AGENT_HANDLE} exists (${agentId}) — refreshed prompt, model, and state`);
	} else {
		const created = yield* agents
			.create(ws.id, {
				createdById: member.userId,
				agent: {
					podId: pd.id,
					name: AGENT_NAME,
					handle: AGENT_HANDLE,
					description: "Weekly AI-visibility tracker for Suga",
					color: "green",
					face: "pill",
					model: MODEL,
					prompt: INSTRUCTIONS,
				},
			})
			.pipe(
				Effect.catchTags({
					AgentNameTaken: () =>
						Effect.die(new Error(`Agent name '${AGENT_NAME}' taken but not found by lookup`)),
					PodOutsideWorkspace: () =>
						Effect.die(new Error(`Pod '${POD_SLUG}' is not in workspace '${WORKSPACE_SLUG}'`)),
				}),
			);
		agentId = created.id;
		console.log(`agent @${AGENT_HANDLE} created (${agentId})`);
	}

	// Seed state — three entries, human-sourced, idempotent (upsert).
	const scope = { workspaceId: ws.id, agentId };
	yield* state.upsert(scope, {
		key: "panel.prompts",
		value: PANEL_PROMPTS,
		purpose: "The 40 prompts to run each weekly scan.",
		source: "human",
		sourceUserId: member.userId,
	});
	yield* state.upsert(scope, {
		key: "panel.competitors",
		value: PANEL_COMPETITORS,
		purpose: "Brands to detect in scan results.",
		source: "human",
		sourceUserId: member.userId,
	});
	yield* state.upsert(scope, {
		key: "panel.own",
		value: PANEL_OWN,
		purpose: "Suga's own identity for the scanner.",
		source: "human",
		sourceUserId: member.userId,
	});

	console.log(
		`state seeded: panel.prompts (${PANEL_PROMPTS.length} prompts), panel.competitors (${PANEL_COMPETITORS.length} brands), panel.own`,
	);

	// Ensure the weekly-scan routine exists. Direct insert rather than through
	// Routines.create — that path requires a session actor. The routine lands
	// with createdById null, which the schema explicitly allows.
	const [existingRoutine] = yield* query((db) =>
		db
			.select({ id: routine.id })
			.from(routine)
			.where(
				and(
					eq(routine.workspaceId, ws.id),
					eq(routine.agentId, agentId),
					eq(routine.name, ROUTINE_NAME),
					isNull(routine.deletedAt),
				),
			)
			.limit(1),
	);
	if (existingRoutine) {
		console.log(`routine '${ROUTINE_NAME}' already scheduled`);
	} else {
		const now = yield* DateTime.nowAsDate;
		const nextRun = yield* nextOccurrence(ROUTINE_CRON, ROUTINE_TIMEZONE, now);
		yield* query((db) =>
			db.insert(routine).values({
				workspaceId: ws.id,
				agentId,
				createdById: null,
				name: ROUTINE_NAME,
				instructions: ROUTINE_INSTRUCTIONS,
				triggerKind: "cron",
				cronExpression: ROUTINE_CRON,
				cronTimezone: ROUTINE_TIMEZONE,
				nextScheduledAt: nextRun,
				webhookSecretDigest: null,
				state: "enabled",
			}),
		);
		console.log(
			`routine '${ROUTINE_NAME}' scheduled: ${ROUTINE_CRON} ${ROUTINE_TIMEZONE} (next fire ${nextRun.toISOString()})`,
		);
	}

	console.log(
		`open https://sugabots.localhost/${WORKSPACE_SLUG}/settings/pods/${POD_SLUG}/agents/${AGENT_HANDLE}`,
	);
}).pipe(
	CurrentActor.provide(
		// The seed acts as no one in particular; state writes above pass the
		// member's userId explicitly rather than relying on a session.
		CurrentActor.AuthenticatedUserId.vouchedFor("00000000-0000-0000-0000-000000000000"),
	),
);

setup.pipe(
	Effect.scoped,
	Effect.provide(
		Layer.mergeAll(AgentRepository.layer, AgentStateRepository.layer, PodRepository.layer).pipe(
			Layer.provideMerge(Layer.mergeAll(Ids.layer, databaseLayer)),
		),
	),
	NodeRuntime.runMain,
);
