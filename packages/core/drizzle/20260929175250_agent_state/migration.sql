CREATE TABLE "agent_state" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"purpose" text NOT NULL,
	"source" text NOT NULL,
	"source_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_state_source_check" CHECK ("source" in ('agent', 'human')),
	CONSTRAINT "agent_state_source_user_check" CHECK (("source" = 'human') = ("source_user_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_state_agent_key_idx" ON "agent_state" ("agent_id","key");--> statement-breakpoint
CREATE INDEX "agent_state_agent_id_idx" ON "agent_state" ("agent_id");--> statement-breakpoint
ALTER TABLE "agent_state" ADD CONSTRAINT "agent_state_source_user_id_user_id_fkey" FOREIGN KEY ("source_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "agent_state" ADD CONSTRAINT "agent_state_agent_workspace_fkey" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "agent"("id","workspace_id") ON DELETE CASCADE;