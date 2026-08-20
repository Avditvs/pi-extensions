/**
 * Preset Extension
 *
 * Allows defining named presets that configure model, thinking level, tools,
 * and system prompt instructions. Presets are defined in JSON config files
 * and can be activated via CLI flag, /preset command, or Ctrl+Shift+U to cycle.
 *
 * Bundled Markdown agents and ~/.pi/agent/agents are the shared preset source.
 * A global ~/.pi/agent/presets.json is supported only for legacy presets that
 * do not have a Markdown agent with the same name. Project-local preset JSON
 * is intentionally not loaded.
 *
 * The active preset remains selected while Pi is running, including after
 * `/new`. The `default` Markdown agent or configured preset is used when Pi
 * starts without an active selection.
 *
 * Example presets.json:
 * ```json
 * {
 *   "plan": {
 *     "provider": "openai-codex",
 *     "model": "gpt-5.2-codex",
 *     "thinkingLevel": "high",
 *     "tools": ["read", "grep", "find", "ls"],
 *     "instructions": "You are in PLANNING MODE. Your job is to deeply understand the problem and create a detailed implementation plan.\n\nRules:\n- DO NOT make any changes. You cannot edit or write files.\n- Read files IN FULL (no offset/limit) to get complete context. Partial reads miss critical details.\n- Explore thoroughly: grep for related code, find similar patterns, understand the architecture.\n- Ask clarifying questions if requirements are ambiguous. Do not assume.\n- Identify risks, edge cases, and dependencies before proposing solutions.\n\nOutput:\n- Create a structured plan with numbered steps.\n- For each step: what to change, why, and potential risks.\n- List files that will be modified.\n- Note any tests that should be added or updated.\n\nWhen done, ask the user if they want you to:\n1. Write the plan to a markdown file (e.g., PLAN.md)\n2. Create a GitHub issue with the plan\n3. Proceed to implementation (they should switch to 'implement' preset)"
 *   },
 *   "implement": {
 *     "provider": "anthropic",
 *     "model": "claude-sonnet-4-5",
 *     "thinkingLevel": "high",
 *     "tools": ["read", "bash", "edit", "write"],
 *     "instructions": "You are in IMPLEMENTATION MODE. Your job is to make focused, correct changes.\n\nRules:\n- Keep scope tight. Do exactly what was asked, no more.\n- Read files before editing to understand current state.\n- Make surgical edits. Prefer edit over write for existing files.\n- Explain your reasoning briefly before each change.\n- Run tests or type checks after changes if the project has them (npm test, npm run check, etc.).\n- If you encounter unexpected complexity, STOP and explain the issue rather than hacking around it.\n\nIf no plan exists:\n- Ask clarifying questions before starting.\n- Propose what you'll do and get confirmation for non-trivial changes.\n\nAfter completing changes:\n- Summarize what was done.\n- Note any follow-up work or tests that should be added."
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi --preset plan` - start with plan preset
 * - `/preset` - show selector to switch presets mid-session
 * - `/preset implement` - switch to implement preset directly
 * - `/preset-config [name]` - show the active or named preset configuration
 * - `Ctrl+Shift+U` - cycle through presets
 *
 * CLI flags always override preset values.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, Markdown, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { discoverPresetAgents } from "./subagent/agents.ts";

// Preset configuration
interface Preset {
	/** Provider name (e.g., "anthropic", "openai") */
	provider?: string;
	/** Model ID (e.g., "claude-sonnet-4-5") */
	model?: string;
	/** Thinking level */
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Tools to enable (replaces default set) */
	tools?: string[];
	/** Instructions to use as the complete system prompt */
	instructions?: string;
}

interface PresetsConfig {
	[name: string]: Preset;
}

const THINKING_LEVELS = new Set<NonNullable<Preset["thinkingLevel"]>>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

// `/new` can recreate the extension's per-session state. Keep the user's
// selection at module scope so it remains available for the next session in
// the same Pi process. This is intentionally not persisted across restarts.
let rememberedPresetName: string | undefined;

function getPresetModel(preset: Preset): { provider: string; model: string } | undefined {
	if (preset.provider && preset.model) return { provider: preset.provider, model: preset.model };
	if (!preset.model) return undefined;

	const separator = preset.model.indexOf("/");
	if (separator <= 0 || separator === preset.model.length - 1) return undefined;
	return { provider: preset.model.slice(0, separator), model: preset.model.slice(separator + 1) };
}

function presetFromAgent(agent: ReturnType<typeof discoverPresetAgents>[number]): Preset {
	const preset: Preset = {
		tools: agent.tools,
		thinkingLevel: agent.thinkingLevel,
		instructions: agent.systemPrompt.trim() || undefined,
	};

	// Keep the original value so applyPreset can warn about an unqualified
	// Markdown model instead of silently treating it as absent.
	if (agent.model) preset.model = agent.model;
	return preset;
}

function validateLegacyPreset(name: string, value: unknown, filePath: string): Preset | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		console.warn(`Skipping invalid legacy preset "${name}" in ${filePath}: expected an object.`);
		return undefined;
	}

	const entry = value as Record<string, unknown>;
	const isString = (field: "provider" | "model" | "instructions") =>
		entry[field] === undefined || typeof entry[field] === "string";
	const validTools = entry.tools === undefined || (Array.isArray(entry.tools) && entry.tools.every((tool) => typeof tool === "string"));
	const validThinking = entry.thinkingLevel === undefined ||
		(typeof entry.thinkingLevel === "string" && THINKING_LEVELS.has(entry.thinkingLevel as Preset["thinkingLevel"]));
	if (!isString("provider") || !isString("model") || !isString("instructions") || !validTools || !validThinking) {
		console.warn(`Skipping invalid legacy preset "${name}" in ${filePath}: invalid field value.`);
		return undefined;
	}

	return {
		provider: entry.provider as string | undefined,
		model: entry.model as string | undefined,
		thinkingLevel: entry.thinkingLevel as Preset["thinkingLevel"],
		tools: entry.tools as string[] | undefined,
		instructions: entry.instructions as string | undefined,
	};
}

function loadLegacyPresets(filePath: string): PresetsConfig {
	if (!existsSync(filePath)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			console.warn(`Failed to load legacy presets from ${filePath}: expected a JSON object.`);
			return {};
		}
		const presets: PresetsConfig = {};
		for (const [name, value] of Object.entries(parsed)) {
			const preset = validateLegacyPreset(name, value, filePath);
			if (preset) presets[name] = preset;
		}
		return presets;
	} catch (error) {
		console.warn(`Failed to load legacy presets from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
}

/** Load Markdown presets first; legacy global JSON only contributes new names. */
function loadPresets(): PresetsConfig {
	const agentPresets = Object.fromEntries(discoverPresetAgents().map((agent) => [agent.name, presetFromAgent(agent)]));
	const legacyPresets = loadLegacyPresets(join(getAgentDir(), "presets.json"));
	return { ...legacyPresets, ...agentPresets };
}

interface OriginalState {
	model: Model<Api> | undefined;
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	tools: string[];
}

export default function presetExtension(pi: ExtensionAPI) {
	let presets: PresetsConfig = {};
	let activePresetName: string | undefined = rememberedPresetName;
	let activePreset: Preset | undefined;
	let originalState: OriginalState | undefined;

	// Register --preset CLI flag
	pi.registerFlag("preset", {
		description: "Preset configuration to use",
		type: "string",
	});

	/**
	 * Apply a preset configuration.
	 */
	async function applyPreset(name: string, preset: Preset, ctx: ExtensionContext): Promise<boolean> {
		// Snapshot state before the first preset is applied (i.e. only when transitioning from no-preset)
		if (activePresetName === undefined) {
			originalState = {
				model: ctx.model,
				thinkingLevel: pi.getThinkingLevel(),
				tools: pi.getActiveTools(),
			};
		}

		// Apply an optional qualified provider/model. Legacy unqualified models
		// remain valid for subagents, but a preset cannot select a provider safely.
		const presetModel = getPresetModel(preset);
		if (preset.model && !presetModel) {
			ctx.ui.notify(
				`Preset "${name}": Model "${preset.model}" has no provider; use provider/model or set both provider and model.`,
				"warning",
			);
		}
		if (presetModel) {
			const model = ctx.modelRegistry.find(presetModel.provider, presetModel.model);
			if (model) {
				const success = await pi.setModel(model);
				if (!success) {
					ctx.ui.notify(`Preset "${name}": No API key for ${presetModel.provider}/${presetModel.model}`, "warning");
				}
			} else {
				ctx.ui.notify(`Preset "${name}": Model ${presetModel.provider}/${presetModel.model} not found`, "warning");
			}
		}

		// Apply thinking level if specified
		if (preset.thinkingLevel) {
			pi.setThinkingLevel(preset.thinkingLevel);
		}

		// Apply tools if specified
		if (preset.tools && preset.tools.length > 0) {
			const allToolNames = pi.getAllTools().map((t) => t.name);
			const validTools = preset.tools.filter((t) => allToolNames.includes(t));
			const invalidTools = preset.tools.filter((t) => !allToolNames.includes(t));

			if (invalidTools.length > 0) {
				ctx.ui.notify(`Preset "${name}": Unknown tools: ${invalidTools.join(", ")}`, "warning");
			}

			if (validTools.length > 0) {
				pi.setActiveTools(validTools);
			}
		}

		// Store active preset for system prompt injection and for the next `/new`
		// session. Do this in one place so every activation path behaves alike.
		activePresetName = name;
		activePreset = preset;
		rememberedPresetName = name;

		return true;
	}

	/**
	 * Reload preset configuration so changes are visible without restarting Pi.
	 */
	function refreshPresets(ctx: ExtensionContext): void {
		presets = loadPresets();
		if (activePresetName) {
			activePreset = presets[activePresetName];
		}
	}

	/**
	 * Build description string for a preset.
	 */
	function buildPresetDescription(preset: Preset): string {
		const parts: string[] = [];

		const presetModel = getPresetModel(preset);
		if (presetModel) {
			parts.push(`${presetModel.provider}/${presetModel.model}`);
		}
		if (preset.thinkingLevel) {
			parts.push(`thinking:${preset.thinkingLevel}`);
		}
		if (preset.tools) {
			parts.push(`tools:${preset.tools.join(",")}`);
		}
		if (preset.instructions) {
			const truncated =
				preset.instructions.length > 30 ? `${preset.instructions.slice(0, 27)}...` : preset.instructions;
			parts.push(`"${truncated}"`);
		}

		return parts.join(" | ");
	}

	/**
	 * Show preset selector UI using custom SelectList component.
	 */
	async function showPresetSelector(ctx: ExtensionContext): Promise<void> {
		refreshPresets(ctx);
		const presetNames = Object.keys(presets);

		if (presetNames.length === 0) {
			ctx.ui.notify(
				`No presets defined. Add Markdown agents to ${join(getAgentDir(), "agents")} or legacy presets to ${join(getAgentDir(), "presets.json")}.`,
				"warning",
			);
			return;
		}

		// Build select items with descriptions
		const items: SelectItem[] = presetNames.map((name) => {
			const preset = presets[name];
			const isActive = name === activePresetName;
			return {
				value: name,
				label: isActive ? `${name} (active)` : name,
				description: buildPresetDescription(preset),
			};
		});

		// Add "None" option to clear preset
		items.push({
			value: "(none)",
			label: "(none)",
			description: "Clear active preset, restore defaults",
		});

		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			// Header
			container.addChild(new Text(theme.fg("accent", theme.bold("Select Preset"))));

			// SelectList with themed styling
			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			let promptExpanded = false;
			const promptTitle = new Text("", 1, 0);
			const promptText = new Text("", 1, 0);

			const updateExpandedPrompt = () => {
				const selectedItem = selectList.getSelectedItem();
				const preset = selectedItem ? presets[selectedItem.value] : undefined;
				if (promptExpanded && selectedItem && preset?.instructions) {
					promptTitle.setText(theme.fg("accent", theme.bold(`Custom prompt: ${selectedItem.value}`)));
					promptText.setText(preset.instructions);
				} else {
					promptTitle.setText("");
					promptText.setText("");
				}
			};

			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			selectList.onSelectionChange = () => {
				promptExpanded = false;
				updateExpandedPrompt();
			};

			container.addChild(selectList);
			container.addChild(promptTitle);
			container.addChild(promptText);

			// Footer hint
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • ctrl+e expand prompt • enter select • esc cancel")));

			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					if (matchesKey(data, "ctrl+e")) {
						const selectedItem = selectList.getSelectedItem();
						const preset = selectedItem ? presets[selectedItem.value] : undefined;
						if (preset?.instructions) {
							promptExpanded = !promptExpanded;
							updateExpandedPrompt();
							tui.requestRender();
						}
						return;
					}

					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!result) return;

		if (result === "(none)") {
			// Clear preset and restore original state
			activePresetName = undefined;
			activePreset = undefined;
			rememberedPresetName = undefined;
			if (originalState) {
				if (originalState.model) {
					await pi.setModel(originalState.model);
				}
				pi.setThinkingLevel(originalState.thinkingLevel);
				pi.setActiveTools(originalState.tools);
			} else {
				pi.setActiveTools(["read", "bash", "edit", "write"]);
			}
			ctx.ui.notify("Preset cleared, defaults restored", "info");
			updateStatus(ctx);
			return;
		}

		const preset = presets[result];
		if (preset) {
			await applyPreset(result, preset, ctx);
			ctx.ui.notify(`Preset "${result}" activated`, "info");
			updateStatus(ctx);
		}
	}

	/**
	 * Update status indicator.
	 */
	function updateStatus(ctx: ExtensionContext) {
		if (activePresetName) {
			ctx.ui.setStatus("preset", ctx.ui.theme.fg("accent", `preset:${activePresetName}`));
		} else {
			ctx.ui.setStatus("preset", undefined);
		}
	}

	function getPresetOrder(): string[] {
		return Object.keys(presets).sort();
	}

	async function cyclePreset(ctx: ExtensionContext): Promise<void> {
		refreshPresets(ctx);
		const presetNames = getPresetOrder();
		if (presetNames.length === 0) {
			ctx.ui.notify(
				`No presets defined. Add Markdown agents to ${join(getAgentDir(), "agents")} or legacy presets to ${join(getAgentDir(), "presets.json")}.`,
				"warning",
			);
			return;
		}

		const cycleList = ["(none)", ...presetNames];
		const currentName = activePresetName ?? "(none)";
		const currentIndex = cycleList.indexOf(currentName);
		const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % cycleList.length;
		const nextName = cycleList[nextIndex];

		if (nextName === "(none)") {
			activePresetName = undefined;
			activePreset = undefined;
			rememberedPresetName = undefined;
			if (originalState) {
				if (originalState.model) {
					await pi.setModel(originalState.model);
				}
				pi.setThinkingLevel(originalState.thinkingLevel);
				pi.setActiveTools(originalState.tools);
			} else {
				pi.setActiveTools(["read", "bash", "edit", "write"]);
			}
			ctx.ui.notify("Preset cleared, defaults restored", "info");
			updateStatus(ctx);
			return;
		}

		const preset = presets[nextName];
		if (!preset) return;

		await applyPreset(nextName, preset, ctx);
		ctx.ui.notify(`Preset "${nextName}" activated`, "info");
		updateStatus(ctx);
	}

	function formatPresetConfiguration(name: string, preset: Preset): string {
		const lines = [`## ${name}${name === activePresetName ? " (active)" : ""}`, ""];

		if (preset.provider !== undefined) lines.push(`- **Provider:** ${preset.provider}`);
		if (preset.model !== undefined) lines.push(`- **Model:** ${preset.model}`);
		if (preset.thinkingLevel !== undefined) lines.push(`- **Thinking level:** ${preset.thinkingLevel}`);
		if (preset.tools !== undefined) lines.push(`- **Tools:** ${preset.tools.join(", ") || "(none)"}`);

		if (preset.instructions !== undefined) {
			lines.push("", "### Instructions", preset.instructions || "(empty)");
		}

		if (lines.length === 2) lines.push("(no configuration overrides)");
		return lines.join("\n");
	}

	async function showPresetConfiguration(args: string, ctx: ExtensionContext): Promise<void> {
		refreshPresets(ctx);
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/preset-config requires interactive mode", "error");
			return;
		}

		if (Object.keys(presets).length === 0) {
			ctx.ui.notify(
				`No presets defined. Add Markdown agents to ${join(getAgentDir(), "agents")} or legacy presets to ${join(getAgentDir(), "presets.json")}.`,
				"warning",
			);
			return;
		}

		const requestedName = args.trim();
		if (requestedName && !presets[requestedName]) {
			const available = Object.keys(presets).sort().join(", ");
			ctx.ui.notify(`Unknown preset "${requestedName}". Available: ${available}`, "error");
			return;
		}

		const names = requestedName
			? [requestedName]
			: activePresetName
				? [activePresetName]
				: Object.keys(presets).sort();
		const content = names.map((name) => formatPresetConfiguration(name, presets[name]!)).join("\n\n");

		await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
			const container = new Container();
			const border = new DynamicBorder((str) => theme.fg("accent", str));

			container.addChild(border);
			container.addChild(new Text(theme.fg("accent", theme.bold("Preset Configuration")), 1, 0));
			container.addChild(new Markdown(content, 1, 0, getMarkdownTheme()));
			container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0));
			container.addChild(border);

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
						done();
					}
				},
			};
		});
	}

	pi.registerShortcut(Key.ctrlShift("u"), {
		description: "Cycle presets",
		handler: async (ctx) => {
			await cyclePreset(ctx);
		},
	});

	// Register /preset command
	pi.registerCommand("preset", {
		description: "Switch preset configuration",
		handler: async (args, ctx) => {
			refreshPresets(ctx);
			// If preset name provided, apply directly
			if (args?.trim()) {
				const name = args.trim();
				const preset = presets[name];

				if (!preset) {
					const available = Object.keys(presets).join(", ") || "(none defined)";
					ctx.ui.notify(`Unknown preset "${name}". Available: ${available}`, "error");
					return;
				}

				await applyPreset(name, preset, ctx);
				ctx.ui.notify(`Preset "${name}" activated`, "info");
				updateStatus(ctx);
				return;
			}

			// Otherwise show selector
			await showPresetSelector(ctx);
		},
	});

	// Register /preset-config command
	pi.registerCommand("preset-config", {
		description: "Show preset configuration (usage: /preset-config [name])",
		handler: async (args, ctx) => {
			await showPresetConfiguration(args, ctx);
		},
	});

	// Replace Pi's assembled system prompt with the active preset instructions.
	pi.on("before_agent_start", async () => {
		if (activePreset?.instructions) {
			return {
				systemPrompt: activePreset.instructions,
			};
		}
	});

	// Initialize on session start
	pi.on("session_start", async (_event, ctx) => {
		// Keep the active preset in memory so it survives `/new`, but not a Pi restart.
		// `rememberedPresetName` also covers hosts that recreate this extension on
		// session creation.
		activePresetName = rememberedPresetName ?? activePresetName;
		originalState = undefined;

		// Load bundled/user Markdown presets and legacy global JSON presets.
		presets = loadPresets();

		// Check for --preset flag
		const presetFlag = pi.getFlag("preset");
		if (typeof presetFlag === "string" && presetFlag) {
			const preset = presets[presetFlag];
			if (preset) {
				await applyPreset(presetFlag, preset, ctx);
				ctx.ui.notify(`Preset "${presetFlag}" activated`, "info");
			} else {
				const available = Object.keys(presets).join(", ") || "(none defined)";
				ctx.ui.notify(`Unknown preset "${presetFlag}". Available: ${available}`, "warning");
			}
		}

		// Keep the active preset across `/new`; use the configured default otherwise.
		if (!presetFlag) {
			const currentPreset = activePresetName ? presets[activePresetName] : undefined;
			const defaultPreset = presets.default;

			if (activePresetName && currentPreset) {
				await applyPreset(activePresetName, currentPreset, ctx);
			} else if (defaultPreset) {
				await applyPreset("default", defaultPreset, ctx);
			}
		}

		updateStatus(ctx);
	});
}
