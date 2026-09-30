import type { Agent, AgentState } from "@sugabots/contracts";
import { MAX_STATE_KEYS_PER_AGENT, MAX_STATE_TOTAL_BYTES_PER_AGENT } from "@sugabots/contracts";
import { useState } from "react";
import { useAgentState, useForgetAgentState, useWriteAgentState } from "@/lib/agent-state.ts";
import { failureMessage } from "@/lib/failure.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { SettingsAddRow, SettingsGroup, SettingsPage, SettingsRow } from "@/ui/settings-page.tsx";

/**
 * State the agent has authored, and a human affordance to add, edit or
 * remove entries. Entries the agent wrote are marked so; editing one is a
 * human write, which the agent's next turn can see through the source hint
 * it gets back from `recall`.
 */
export function AgentWorkspaceSettings({ agent }: { agent: Agent }) {
	const state = useAgentState(agent.id);
	const write = useWriteAgentState(agent.id);
	const forget = useForgetAgentState(agent.id);
	const [editing, setEditing] = useState<AgentState | "new" | undefined>();

	if (state.isError) {
		return (
			<SettingsPage title="Memory" description={`What ${agent.name} remembers between turns.`}>
				<Alert>{failureMessage(state.error)}</Alert>
			</SettingsPage>
		);
	}
	if (state.isPending || !state.data) return null;

	const { entries, usage, hasMore } = state.data;
	const keysNote = `${usage.keys} / ${MAX_STATE_KEYS_PER_AGENT} keys · ${formatBytes(usage.totalBytes)} / ${formatBytes(MAX_STATE_TOTAL_BYTES_PER_AGENT)}`;

	return (
		<SettingsPage
			title="Memory"
			description={`What ${agent.name} remembers between turns.`}
			headerAction={<Button onClick={() => setEditing("new")}>Add entry</Button>}
		>
			<SettingsGroup label="Entries" note={keysNote}>
				{entries.length === 0 ? (
					<SettingsRow label="No entries yet" />
				) : (
					entries.map((entry) => (
						<SettingsRow
							key={entry.key}
							label={entry.key}
							sub={`${entry.purpose} · ${entry.source === "human" ? "set by you" : "set by the agent"}`}
							chevron
							onClick={() => setEditing(entry)}
						/>
					))
				)}
				{hasMore && <SettingsRow label="More entries not shown" />}
				<SettingsAddRow onClick={() => setEditing("new")} label="Add entry" />
			</SettingsGroup>

			{editing !== undefined && (
				<EntryForm
					entry={editing === "new" ? undefined : editing}
					onCancel={() => setEditing(undefined)}
					onSave={async ({ key, value, purpose }) => {
						await write.mutateAsync({ key, value, purpose });
						setEditing(undefined);
					}}
					onDelete={
						editing === "new"
							? undefined
							: async (key) => {
									await forget.mutateAsync(key);
									setEditing(undefined);
								}
					}
					pending={write.isPending || forget.isPending}
				/>
			)}
		</SettingsPage>
	);
}

interface EntryFormProps {
	entry: AgentState | undefined;
	onCancel: () => void;
	onSave: (input: { key: string; value: unknown; purpose: string }) => Promise<void>;
	onDelete?: (key: string) => Promise<void>;
	pending: boolean;
}

function EntryForm({ entry, onCancel, onSave, onDelete, pending }: EntryFormProps) {
	const [key, setKey] = useState(entry?.key ?? "");
	const [valueText, setValueText] = useState(entry ? JSON.stringify(entry.value, null, 2) : '""');
	const [purpose, setPurpose] = useState(entry?.purpose ?? "");
	const [error, setError] = useState<string | undefined>();

	const submit = async () => {
		setError(undefined);
		if (!key.trim()) {
			setError("Key is required.");
			return;
		}
		if (!purpose.trim()) {
			setError("Purpose is required — one short sentence.");
			return;
		}
		let value: unknown;
		try {
			value = JSON.parse(valueText);
		} catch {
			setError("Value must be valid JSON.");
			return;
		}
		try {
			await onSave({ key: key.trim(), value, purpose: purpose.trim() });
		} catch (failure) {
			setError(failureMessage(failure));
		}
	};

	return (
		<div className="mt-6 flex flex-col gap-3 rounded-3xl bg-card p-5 ring-1 ring-foreground/10">
			<label className="flex flex-col gap-1 text-sm">
				<span className="font-semibold">Key</span>
				<input
					value={key}
					onChange={(event) => setKey(event.target.value)}
					readOnly={!!entry}
					className="rounded-md border border-foreground/20 bg-background px-3 py-2"
				/>
			</label>
			<label className="flex flex-col gap-1 text-sm">
				<span className="font-semibold">Purpose</span>
				<input
					value={purpose}
					onChange={(event) => setPurpose(event.target.value)}
					placeholder="One short sentence — why this entry exists"
					className="rounded-md border border-foreground/20 bg-background px-3 py-2"
				/>
			</label>
			<label className="flex flex-col gap-1 text-sm">
				<span className="font-semibold">Value (JSON)</span>
				<textarea
					value={valueText}
					onChange={(event) => setValueText(event.target.value)}
					rows={8}
					className="rounded-md border border-foreground/20 bg-background px-3 py-2 font-mono text-xs"
				/>
			</label>
			{error && <Alert>{error}</Alert>}
			<div className="flex flex-row justify-between gap-2">
				<div>
					{onDelete && entry && (
						<Button
							variant="destructive"
							onClick={() => {
								void onDelete(entry.key);
							}}
							disabled={pending}
						>
							Delete
						</Button>
					)}
				</div>
				<div className="flex flex-row gap-2">
					<Button variant="secondary" onClick={onCancel} disabled={pending}>
						Cancel
					</Button>
					<Button onClick={submit} disabled={pending}>
						{entry ? "Save" : "Add"}
					</Button>
				</div>
			</div>
		</div>
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
