import { tool } from "ai";
import { Schema } from "effect";

export const RENDER_CHART_TOOL = "render_chart";

/**
 * `render_chart` — draw a Vega-Lite chart inline in the reply. The tool
 * records the spec on the `tool_call` and echoes it back on success; the
 * web UI recognises the tool key and renders the spec instead of the
 * usual "used render_chart" chip.
 *
 * Charts should read from pre-computed rollups, not raw journal data: the
 * inline spec's data should be small. The tool caps the whole spec at
 * `MAX_SPEC_BYTES` so an agent cannot accidentally dump a large journal
 * into a chart.
 */
const MAX_SPEC_BYTES = 100_000;

export function renderChartTool() {
	return tool({
		description: `Draw a chart inline in your reply, from a Vega-Lite v5 spec. Include the spec's inline data — do not reference a URL. Keep specs small (\`data.values\` at most a few hundred rows, spec under ${MAX_SPEC_BYTES.toLocaleString()} bytes). Best used against pre-computed aggregates you've read from state or the journal, not raw entries. The chart appears where you call this tool in the reply.

Style: the app applies a theme (font, palette, axis and legend colours), so do not set colours or fonts yourself. Set \`width: "container"\` so the chart fills its card (the card is often much wider than the default 380px), pair it with \`"autosize": { "type": "fit", "contains": "padding" }\`, and give an explicit numeric \`height\` around 240. Use plain field names — letters, digits, underscores — and set human titles via \`encoding.<channel>.title\`; a field name with a space, dot, or percent sign can silently drop the encoding. Prefer a single \`mark\` or \`layer\` at the top level over \`hconcat\`/\`vconcat\` unless comparing side-by-side. For line charts, prefer curves — set \`mark: { "type": "line", "interpolate": "monotone", "point": true }\` so trends read as gentle waves and each data point is marked.

Time-like axes: when the x-axis represents dates or weeks, encode it as \`type: "temporal"\` (with dates like "2026-08-24") rather than \`type: "nominal"\`, otherwise Vega-Lite sorts labels alphabetically and the order breaks ("Sep 7" lands after "Sep 21"). If you must use short display labels like "Aug 24", keep the underlying data as ISO dates and set \`axis: { format: "%b %d" }\`, or add an explicit \`sort\` array on the channel.

Encodings should stay simple: keep each channel a plain \`{ type, field, title }\` object. Do not use \`condition\` blocks inside encodings unless you also declare a matching \`params\` entry (a selection) or write the condition as \`{ "test": "datum.x === '...'", "value": ... }\` — a bare \`{ condition: { equal: ..., field: ... } }\` is not valid Vega-Lite and crashes the renderer. To highlight one series (e.g. Suga) differently, use a \`layer\`: one layer for all series with the default look, a second layer filtered to the one series with the overridden mark. Skip \`strokeDash\`, \`opacity\` and \`size\` conditions unless you need them — a clear, plain line chart reads better than one dressed up with rules it half-implements.`,
		inputSchema: Schema.Struct({
			spec: Schema.Unknown.annotate({
				description: "A Vega-Lite v5 spec object with inline data.",
			}),
			caption: Schema.optional(
				Schema.String.check(Schema.isMaxLength(280)).annotate({
					description: "Optional one-line caption shown under the chart.",
				}),
			),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async ({ spec, caption }) => {
			// Some models stringify the spec even though the schema asks for an
			// object. Accept both — parse a string, keep an object as is.
			let parsed: unknown = spec;
			if (typeof spec === "string") {
				try {
					parsed = JSON.parse(spec);
				} catch {
					return {
						ok: false as const,
						error: "Spec must be a Vega-Lite object (JSON), not an arbitrary string.",
					};
				}
			}
			const bytes = Buffer.byteLength(JSON.stringify(parsed) ?? "null", "utf8");
			if (bytes > MAX_SPEC_BYTES) {
				return {
					ok: false as const,
					error: `Spec is too large (${bytes} > ${MAX_SPEC_BYTES} bytes). Aggregate before charting.`,
				};
			}
			if (!parsed || typeof parsed !== "object") {
				return { ok: false as const, error: "Spec must be a Vega-Lite object." };
			}
			// Rough shape check — a Vega-Lite view has one of these.
			const hasView =
				"mark" in parsed ||
				"layer" in parsed ||
				"hconcat" in parsed ||
				"vconcat" in parsed ||
				"concat" in parsed ||
				"facet" in parsed ||
				"repeat" in parsed ||
				"spec" in parsed;
			if (!hasView) {
				return {
					ok: false as const,
					error:
						"Spec must be a Vega-Lite view (needs a mark, layer, concat, facet, repeat or spec).",
				};
			}
			return { ok: true as const, spec: parsed, caption: caption ?? null };
		},
	});
}
