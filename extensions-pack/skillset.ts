/**
 * Skillset Extension
 *
 * Provides a /skillset command that lets the user enable or disable individual
 * skills for the current session. Disabled skills are removed from the system
 * prompt's <available_skills> section and their /skill:name commands are
 * blocked, so the agent can neither see nor load them.
 *
 * The selection is NOT persisted to settings — it lasts only for the lifetime
 * of the pi process (it survives /new, like the preset extension).
 *
 * Usage:
 * - `/skillset`                - open the interactive skill selector
 * - `/skillset <name>`         - quickly toggle a single skill by name
 * - `/skillset enable <name>`  - enable a skill
 * - `/skillset disable <name>` - disable a skill
 * - `/skillset enable-all`     - enable every loaded skill
 * - `/skillset disable-all`    - disable every loaded skill
 */

import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

/** Skills disabled by the user. Module-scoped so the selection survives `/new`. */
const disabledSkills = new Set<string>();

/** Last known set of loaded skills, refreshed on every agent start. Used by
 * handlers whose context does not expose getSystemPromptOptions (e.g. input). */
let cachedSkills: Skill[] = [];

const DESCRIPTION_MAX_LENGTH = 80;

/** The intro pi puts before the skills XML in the assembled system prompt. */
const SKILLS_INTRO = "\n\nThe following skills provide specialized instructions for specific tasks.";

function truncateDescription(description: string): string {
	const singleLine = description.replace(/\s+/g, " ").trim();
	if (singleLine.length <= DESCRIPTION_MAX_LENGTH) return singleLine;
	return `${singleLine.slice(0, DESCRIPTION_MAX_LENGTH - 3)}...`;
}

/** Skills pi loaded for the current session. `getSystemPromptOptions` is only
 * available on command contexts; elsewhere we fall back to the cached list. */
type SkillSource = ExtensionContext & { getSystemPromptOptions?: () => BuildSystemPromptOptions };

function getLoadedSkills(ctx: SkillSource): Skill[] {
	return ctx.getSystemPromptOptions?.().skills ?? cachedSkills;
}

function isEnabled(skill: Skill): boolean {
	return !disabledSkills.has(skill.name);
}

/**
 * Rebuild the `<available_skills>` section of an assembled system prompt so it
 * only advertises the skills that are still enabled. Returns the prompt
 * unchanged when no skills are disabled or no section is present.
 */
function stripDisabledSkills(systemPrompt: string, loadedSkills: Skill[]): string {
	if (disabledSkills.size === 0 || loadedSkills.length === 0) return systemPrompt;

	const enabled = loadedSkills.filter(isEnabled);
	if (enabled.length === loadedSkills.length) return systemPrompt;

	// Prefer replacing the whole section (intro + XML); fall back to the XML
	// block alone if pi's intro wording ever changes.
	const introStart = systemPrompt.indexOf(SKILLS_INTRO);
	const tagStart = systemPrompt.indexOf("\n\n<available_skills>");
	const start = introStart >= 0 ? introStart : tagStart;
	const endTag = systemPrompt.indexOf("</available_skills>", start >= 0 ? start : 0);
	if (start < 0 || endTag < 0) return systemPrompt;
	const sectionEnd = endTag + "</available_skills>".length;

	// formatSkillsForPrompt re-adds its own intro; when we could not locate the
	// intro (fallback path) slice it off so the existing intro is not duplicated.
	const formatted = formatSkillsForPrompt(enabled);
	const replacement = introStart >= 0 ? formatted : formatted.slice(formatted.indexOf("\n\n<available_skills>"));

	return systemPrompt.slice(0, start) + replacement + systemPrompt.slice(sectionEnd);
}

/** Some hosts recreate extensions without disposing their old event listeners.
 * Only the newest instance may modify prompts or block input. */
type SkillsetExtensionLifecycle = { latestInstance: number };
type GlobalWithSkillsetExtensionLifecycle = typeof globalThis & {
	__piSkillsetExtensionLifecycle?: SkillsetExtensionLifecycle;
};
const globalWithSkillsetExtensionLifecycle = globalThis as GlobalWithSkillsetExtensionLifecycle;
const skillsetExtensionLifecycle = globalWithSkillsetExtensionLifecycle.__piSkillsetExtensionLifecycle ??
	(globalWithSkillsetExtensionLifecycle.__piSkillsetExtensionLifecycle = { latestInstance: 0 });

export default function skillsetExtension(pi: ExtensionAPI) {
	const instance = ++skillsetExtensionLifecycle.latestInstance;
	const isCurrentInstance = () => instance === skillsetExtensionLifecycle.latestInstance;

	function updateStatus(ctx: ExtensionContext): void {
		const skills = getLoadedSkills(ctx);
		if (skills.length > 0 && disabledSkills.size > 0) {
			const enabledCount = skills.filter(isEnabled).length;
			ctx.ui.setStatus("skillset", ctx.ui.theme.fg("warning", `skills:${enabledCount}/${skills.length}`));
		} else {
			ctx.ui.setStatus("skillset", undefined);
		}
	}

	/** List unknown names among the requested ones for error messages. */
	function unknownSkillNames(names: string[], loadedSkills: Skill[]): string[] {
		const known = new Set(loadedSkills.map((s) => s.name));
		return names.filter((name) => !known.has(name));
	}

	/** Commit a new disabled set and refresh status + notifications. */
	function applyDisabledSkills(next: Iterable<string>, ctx: ExtensionContext, loadedSkills: Skill[]): void {
		disabledSkills.clear();
		for (const name of next) disabledSkills.add(name);
		updateStatus(ctx);
		if (disabledSkills.size === 0) {
			ctx.ui.notify("All skills enabled", "info");
		} else {
			ctx.ui.notify(
				`${loadedSkills.length - disabledSkills.size} of ${loadedSkills.length} skills enabled`,
				"info",
			);
		}
	}

	/** Skill selector UI modeled on /session-tools. */
	async function showSkillSelector(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/skillset requires interactive mode", "error");
			return;
		}

		const loadedSkills = [...getLoadedSkills(ctx)].sort((left, right) => left.name.localeCompare(right.name));

		if (loadedSkills.length === 0) {
			ctx.ui.notify("No skills loaded. Add skills to ~/.pi/agent/skills or .pi/skills.", "warning");
			return;
		}

		// Draft state so Esc can cancel out of a half-made selection.
		const toggleState = new Map<string, boolean>(loadedSkills.map((s) => [s.name, isEnabled(s)]));

		/** Build a fresh list of select items reflecting the current toggle state. */
		function buildItems(): SelectItem[] {
			const items: SelectItem[] = [];

			items.push({
				value: "__enable_all__",
				label: "[ Enable All ]",
				description: "Enable every loaded skill",
			});
			items.push({
				value: "__disable_all__",
				label: "[ Disable All ]",
				description: "Disable every loaded skill",
			});

			items.push({
				value: "__separator__",
				label: "─".repeat(30),
				description: "",
			});

			for (const skill of loadedSkills) {
				const active = toggleState.get(skill.name) ?? false;
				items.push({
					value: skill.name,
					label: active ? `✓ ${skill.name}` : `○ ${skill.name}`,
					description: truncateDescription(skill.description),
				});
			}

			const enabledCount = [...toggleState.values()].filter(Boolean).length;
			items.push({
				value: "__done__",
				label: `[ Done — ${enabledCount} of ${loadedSkills.length} skills enabled ]`,
				description: "Close selector and apply changes",
			});

			return items;
		}

		/** Commit the draft state as the session's disabled set. */
		function applySelection(): void {
			const disabled = [...toggleState.entries()].filter(([, active]) => !active).map(([name]) => name);
			applyDisabledSkills(disabled, ctx, loadedSkills);
		}

		await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			const border = new DynamicBorder((str) => theme.fg("accent", str));
			const headerText = new Text(theme.fg("accent", theme.bold("Skills")), 1, 0);
			const subtitleText = new Text(
				theme.fg("muted", "Toggle skills on/off for this session. Changes are not saved to config."),
				1,
				0,
			);
			const footerText = new Text(
				theme.fg("dim", "↑↓ navigate • enter toggle • / filter • esc close & apply"),
				1,
				0,
			);

			container.addChild(border);
			container.addChild(headerText);
			container.addChild(subtitleText);

			/** Create a themed SelectList. */
			function makeSelectList(items: SelectItem[]): SelectList {
				return new SelectList(items, Math.min(items.length, 16), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});
			}

			// Store the index where the select list lives in children[] so we
			// can replace it in-place (addChild always appends).
			const selectListIndex = container.children.length;
			let selectList = makeSelectList(buildItems());

			/** Rebuild the select list in-place, preserving the selected item. */
			function rebuildSelectList(): void {
				const selectedItem = selectList.getSelectedItem();
				const selectedIndex = selectedItem
					? buildItems().findIndex((item) => item.value === selectedItem.value)
					: -1;

				const newSelectList = makeSelectList(buildItems());
				newSelectList.onSelect = selectList.onSelect;
				newSelectList.onCancel = selectList.onCancel;
				if (selectedIndex >= 0) {
					newSelectList.setSelectedIndex(selectedIndex);
				}

				// Replace the select list in-place so children order is preserved.
				container.children[selectListIndex] = newSelectList;
				selectList = newSelectList;
				container.invalidate();
				tui.requestRender();
			}

			// Wire up callbacks
			selectList.onSelect = (item) => {
				if (item.value === "__enable_all__") {
					for (const [name] of toggleState) toggleState.set(name, true);
					rebuildSelectList();
					return;
				}

				if (item.value === "__disable_all__") {
					for (const [name] of toggleState) toggleState.set(name, false);
					rebuildSelectList();
					return;
				}

				if (item.value === "__separator__") {
					return;
				}

				if (item.value === "__done__") {
					applySelection();
					done(null);
					return;
				}

				// Toggle individual skill
				toggleState.set(item.value, !(toggleState.get(item.value) ?? false));
				rebuildSelectList();
			};

			selectList.onCancel = () => {
				applySelection();
				done(null);
			};

			container.addChild(selectList);
			container.addChild(footerText);
			container.addChild(border);

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});
	}

	// ── Remove disabled skills from the system prompt ──────────────
	pi.on("before_agent_start", async (event) => {
		if (!isCurrentInstance()) return;

		cachedSkills = event.systemPromptOptions.skills ?? [];
		const systemPrompt = stripDisabledSkills(event.systemPrompt, cachedSkills);
		if (systemPrompt !== event.systemPrompt) {
			return { systemPrompt };
		}
	});

	// ── Block /skill:name commands for disabled skills ─────────────
	pi.on("input", async (event, ctx) => {
		if (!isCurrentInstance() || disabledSkills.size === 0) return;

		const match = /^\/skill:([\w-]+)/.exec(event.text);
		if (!match) return;

		const loadedSkills = getLoadedSkills(ctx);
		const skill = loadedSkills.find((s) => s.name === match[1]);
		if (!skill || isEnabled(skill)) return;

		ctx.ui.notify(`Skill "${skill.name}" is disabled. Enable it with /skillset ${skill.name}.`, "warning");
		return { action: "handled" };
	});

	// ── /skillset command ─────────────────────────────────────────
	pi.registerCommand("skillset", {
		description: "Enable or disable skills for the current session",
		handler: async (args, ctx) => {
			const loadedSkills = getLoadedSkills(ctx);
			const input = args.trim();
			const [first, ...rest] = input.length > 0 ? input.split(/\s+/) : [];

			if (!first) {
				await showSkillSelector(ctx);
				updateStatus(ctx);
				return;
			}

			if (first === "enable-all" || first === "disable-all") {
				if (loadedSkills.length === 0) {
					ctx.ui.notify("No skills loaded. Add skills to ~/.pi/agent/skills or .pi/skills.", "warning");
					return;
				}
				const next = first === "disable-all" ? loadedSkills.map((s) => s.name) : [];
				applyDisabledSkills(next, ctx, loadedSkills);
				return;
			}

			if ((first === "enable" || first === "disable") && rest.length > 0) {
				const unknown = unknownSkillNames(rest, loadedSkills);
				if (unknown.length > 0) {
					ctx.ui.notify(`Unknown skill(s): ${unknown.join(", ")}`, "error");
					return;
				}
				for (const name of rest) {
					if (first === "disable") disabledSkills.add(name);
					else disabledSkills.delete(name);
				}
				updateStatus(ctx);
				ctx.ui.notify(
					first === "disable" ? `Disabled skill(s): ${rest.join(", ")}` : `Enabled skill(s): ${rest.join(", ")}`,
					"info",
				);
				return;
			}

			// `/skillset <name>` toggles a single skill
			const unknown = unknownSkillNames([first], loadedSkills);
			if (unknown.length > 0) {
				ctx.ui.notify(`Unknown skill "${first}". Use /skillset to open the selector.`, "error");
				return;
			}

			if (disabledSkills.has(first)) {
				disabledSkills.delete(first);
				ctx.ui.notify(`Skill "${first}" enabled`, "info");
			} else {
				disabledSkills.add(first);
				ctx.ui.notify(`Skill "${first}" disabled`, "info");
			}
			updateStatus(ctx);
		},
	});

	// ── Refresh the status indicator when a session starts ────────
	pi.on("session_start", async (_event, ctx) => {
		if (!isCurrentInstance()) return;
		updateStatus(ctx);
	});
}
