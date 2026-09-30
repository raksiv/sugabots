import { useEffect, useRef, useState } from "react";
import embed, { type Result, type VisualizationSpec } from "vega-embed";

/**
 * Renders a Vega-Lite spec inline in a message. The agent produces the spec
 * through `render_chart`, and the tool call's output carries it here; when
 * the tool returned an error the card shows the reason instead of trying
 * to draw.
 *
 * The spec is re-drawn with a project-wide config every render: fonts,
 * axis/legend/title colours and a categorical palette read from the app's
 * CSS tokens, so charts match the surrounding UI in both themes. When the
 * theme changes we re-embed so the new tokens take effect.
 *
 * Vega-Embed's `actions` are hidden — this is a chat reply, not a chart
 * editor — and the container is cleaned up whenever the spec changes so
 * consecutive charts don't stack SVGs.
 */
export function ChartCard({ spec, caption }: { spec: unknown; caption?: string | null }) {
	const container = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | undefined>();
	const [themeVersion, setThemeVersion] = useState(0);

	// Re-embed when the app theme flips or the system's colour-scheme changes
	// (used when `data-theme="system"`), so the chart picks up the new tokens.
	useEffect(() => {
		const bump = () => setThemeVersion((v) => v + 1);
		const observer = new MutationObserver(bump);
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		media.addEventListener("change", bump);
		return () => {
			observer.disconnect();
			media.removeEventListener("change", bump);
		};
	}, []);

	useEffect(() => {
		const element = container.current;
		if (!element) return;
		let cancelled = false;
		let result: Result | undefined;
		element.innerHTML = "";
		setError(undefined);
		const themed = withProjectDefaults(spec, readThemeTokens(element));
		void embed(element, themed, { actions: false, renderer: "svg" })
			.then((outcome) => {
				if (cancelled) {
					outcome.finalize();
				} else {
					result = outcome;
				}
			})
			.catch((cause: unknown) => {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
			result?.finalize();
			element.innerHTML = "";
		};
	}, [spec, themeVersion]);

	return (
		<figure className="my-2 flex flex-col gap-1 rounded-2xl bg-card p-3 ring-1 ring-foreground/10">
			<div ref={container} className="w-full overflow-auto" />
			{error ? (
				<figcaption className="text-destructive text-xs">
					Could not render chart: {error}
				</figcaption>
			) : caption ? (
				<figcaption className="text-muted-foreground text-xs">{caption}</figcaption>
			) : null}
		</figure>
	);
}

/**
 * Reads the spec and caption out of a `render_chart` tool call's output.
 * Returns `undefined` when the call failed or is still running.
 */
export function chartFromToolCall(
	output: unknown,
): { spec: unknown; caption: string | null } | undefined {
	if (
		output &&
		typeof output === "object" &&
		"ok" in output &&
		output.ok === true &&
		"spec" in output
	) {
		const withCaption = "caption" in output ? (output as { caption: string | null }).caption : null;
		return { spec: (output as { spec: unknown }).spec, caption: withCaption };
	}
	return undefined;
}

type ThemeTokens = {
	foreground: string;
	mutedForeground: string;
	subtleForeground: string;
	border: string;
	borderStrong: string;
	primary: string;
	font: string;
};

/**
 * Reads project tokens as concrete colours (not `light-dark(...)` strings).
 * We resolve each token by writing it to a probe element's `color` and reading
 * the browser's computed rgb value — this collapses `light-dark()` and any
 * other CSS function the token wraps into a colour Vega can parse.
 */
function readThemeTokens(anchor: Element): ThemeTokens {
	const style = getComputedStyle(anchor);
	const probe = document.createElement("span");
	probe.style.position = "absolute";
	probe.style.visibility = "hidden";
	probe.style.pointerEvents = "none";
	anchor.appendChild(probe);
	const asColor = (varName: string, fallback: string) => {
		probe.style.color = "";
		probe.style.color = `var(${varName}, ${fallback})`;
		const resolved = getComputedStyle(probe).color;
		return resolved || fallback;
	};
	try {
		return {
			foreground: asColor("--foreground", "#111"),
			mutedForeground: asColor("--muted-foreground", "#666"),
			subtleForeground: asColor("--subtle-foreground", "#888"),
			border: asColor("--border", "#e5e5e5"),
			borderStrong: asColor("--border-strong", "#d4d4d4"),
			primary: asColor("--primary", "#4f5bd5"),
			font: style.getPropertyValue("--font-sans").trim() || "system-ui, sans-serif",
		};
	} finally {
		probe.remove();
	}
}

function withProjectDefaults(spec: unknown, tokens: ThemeTokens): VisualizationSpec {
	const base = spec && typeof spec === "object" ? (spec as Record<string, unknown>) : {};
	const injected: Record<string, unknown> = { ...base };
	injected.config = mergeConfig(projectConfig(tokens), base.config);
	return injected as VisualizationSpec;
}

function projectConfig(tokens: ThemeTokens) {
	const axisText = {
		labelColor: tokens.mutedForeground,
		titleColor: tokens.foreground,
		labelFont: tokens.font,
		titleFont: tokens.font,
		labelFontSize: 11,
		titleFontSize: 12,
		titleFontWeight: 500,
		titlePadding: 8,
		gridColor: tokens.border,
		gridOpacity: 0.6,
		domainColor: tokens.borderStrong,
		tickColor: tokens.borderStrong,
		labelPadding: 4,
	};
	return {
		background: "transparent",
		font: tokens.font,
		padding: 8,
		view: { stroke: null, continuousWidth: 380, continuousHeight: 220, discreteWidth: 380 },
		axis: axisText,
		axisX: { grid: false },
		axisY: { grid: true },
		legend: {
			labelColor: tokens.foreground,
			titleColor: tokens.foreground,
			labelFont: tokens.font,
			titleFont: tokens.font,
			labelFontSize: 11,
			titleFontSize: 11,
			titleFontWeight: 500,
			symbolSize: 80,
			symbolStrokeWidth: 2,
			rowPadding: 2,
		},
		title: {
			color: tokens.foreground,
			font: tokens.font,
			fontSize: 13,
			fontWeight: 600,
			anchor: "start",
			offset: 10,
		},
		// A categorical palette that carries on both the dark default and the
		// light theme. Primary leads; the rest are quieter accents chosen for
		// contrast against neighbours.
		range: {
			category: [
				tokens.primary,
				"oklch(0.70 0.14 55)",
				"oklch(0.66 0.14 200)",
				"oklch(0.64 0.15 335)",
				"oklch(0.62 0.15 30)",
				"oklch(0.66 0.14 150)",
			],
			ordinal: { scheme: "purples" },
		},
		mark: { color: tokens.primary },
		line: { strokeWidth: 2 },
		point: { size: 60, filled: true },
		area: { line: true, opacity: 0.35 },
		bar: { cornerRadiusEnd: 3 },
		rule: { color: tokens.borderStrong },
	};
}

function mergeConfig(base: Record<string, unknown>, override: unknown): Record<string, unknown> {
	if (!override || typeof override !== "object") return base;
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
		const existing = merged[key];
		if (
			existing &&
			value &&
			typeof existing === "object" &&
			typeof value === "object" &&
			!Array.isArray(existing) &&
			!Array.isArray(value)
		) {
			merged[key] = { ...(existing as object), ...(value as object) };
		} else {
			merged[key] = value;
		}
	}
	return merged;
}
