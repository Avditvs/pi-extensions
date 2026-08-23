/**
 * Session Tools Extension
 *
 * Provides a /session-tools command that opens a tool selector to add or
 * remove tools for the current session only. Changes take effect immediately
 * but are NOT persisted to tools-config.json — they last only for the
 * lifetime of the pi process.
 *
 * Also provides a /list-tools command that displays every tool available
 * to Pi, including tools registered by extensions.
 *
 * Usage:
 * - `/session-tools`              - open the interactive tool selector
 * - `/session-tools <tool>`       - quickly toggle a single tool by name
 * - `/session-tools reset`        - revert to the default tool set from config
 * - `/session-tools reset preset` - revert to the active preset's tool set
 * - `/list-tools`                 - view all tools with active state
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

/** Module-scoped record of the active tools when the session started. */
let originalToolsAtSessionStart: string[] | undefined;

/** Tools defined by the active preset (if any). Updated via EventBus. */
let presetTools: string[] | undefined;

const DESCRIPTION_MAX_LENGTH = 80;

function truncateDescription(description: string): string {
	const singleLine = description.replace(/\s+/g, " ").trim();
	if (singleLine.length <= DESCRIPTION_MAX_LENGTH) return singleLine;
	return `${singleLine.slice(0, DESCRIPTION_MAX_LENGTH - 3)}...`;
}

export default function sessionToolsExtension(pi: ExtensionAPI): void {
	// ── Snapshot original tools when a session starts ──────────────
	pi.on("session_start", async () => {
		originalToolsAtSessionStart = pi.getActiveTools();
	});

	// ── Listen for preset changes via EventBus ─────────────────────
	pi.events.on("preset:applied", (data: unknown) => {
		const event = data as { name: string; tools?: string[] } | undefined;
		presetTools = event?.tools;
	});

	// ── Status indicator helper ────────────────────────────────────
	function updateStatus(ctx: ExtensionContext): void {
		const activeTools = pi.getActiveTools();
		if (originalToolsAtSessionStart) {
			const added = activeTools.filter((t) => !originalToolsAtSessionStart!.includes(t));
			const removed = originalToolsAtSessionStart.filter((t) => !activeTools.includes(t));
			if (added.length > 0 || removed.length > 0) {
				const parts: string[] = [];
				if (added.length > 0) parts.push(`+${added.length}`);
				if (removed.length > 0) parts.push(`-${removed.length}`);
				ctx.ui.setStatus("session-tools", ctx.ui.theme.fg("accent", `tools:${parts.join(" ")}`));
				return;
			}
		}
		ctx.ui.setStatus("session-tools", undefined);
	}

	// ── Tool selector UI ───────────────────────────────────────────
	async function showToolSelector(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/session-tools requires interactive mode", "error");
			return;
		}

		const allTools = pi.getAllTools().sort((left, right) => left.name.localeCompare(right.name));

		const activeTools = new Set(pi.getActiveTools());
		const toggleState = new Map<string, boolean>(
			allTools.map((t) => [t.name, activeTools.has(t.name)]),
		);

		/** Build a fresh list of select items reflecting the current toggle state. */
		function buildItems(): SelectItem[] {
			const items: SelectItem[] = [];

			// Quick actions
			items.push({
				value: "__select_all__",
				label: "[ Select All ]",
				description: "Enable every available tool",
			});
			items.push({
				value: "__deselect_all__",
				label: "[ Deselect All ]",
				description: "Disable every tool",
			});
			items.push({
				value: "__reset_preset__",
				label: "[ Reset to Active Preset ]",
				description: presetTools?.length
					? `Restore to preset's ${presetTools.length} tool(s)`
					: "No active preset with tools defined",
			});

			// Separator
			items.push({
				value: "__separator__",
				label: "─".repeat(30),
				description: "",
			});

			// Toggle items for each tool
			for (const tool of allTools) {
				const isActive = toggleState.get(tool.name) ?? false;
				items.push({
					value: tool.name,
					label: isActive ? `✓ ${tool.name}` : `○ ${tool.name}`,
					description: truncateDescription(tool.description ?? "No description available."),
				});
			}

			// Done item
			const activeCount = Array.from(toggleState.values()).filter(Boolean).length;
			items.push({
				value: "__done__",
				label: `[ Done — ${activeCount} of ${allTools.length} tools active ]`,
				description: "Close selector and apply changes",
			});

			return items;
		}

		/** Apply the current toggle state to the active tools. */
		function applyTools(): void {
			const enabled = Array.from(toggleState.entries())
				.filter(([, active]) => active)
				.map(([name]) => name);
			pi.setActiveTools(enabled);
			updateStatus(ctx);
		}

		/** Apply preset tools to the toggle state. */
		function applyPresetToToggleState(): void {
			if (presetTools && presetTools.length > 0) {
				for (const [name] of toggleState) {
					toggleState.set(name, presetTools.includes(name));
				}
			}
		}

		await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			const border = new DynamicBorder((str) => theme.fg("accent", str));
			const headerText = new Text(theme.fg("accent", theme.bold("Session Tools")), 1, 0);
			const subtitleText = new Text(
				theme.fg("muted", "Toggle tools on/off for this session. Changes are not saved to config."),
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

			// Create the select list — we'll replace it when items change.
			let selectList = new SelectList(buildItems(), Math.min(buildItems().length, 16), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			/** Rebuild the select list with fresh items, keeping the selected index. */
			function rebuildSelectList(): void {
				const selectedIndex = selectList.getSelectedItem()
					? buildItems().findIndex((item) => item.value === selectList.getSelectedItem()!.value)
					: -1;

				const newSelectList = new SelectList(buildItems(), Math.min(buildItems().length, 16), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});

				// Wire up callbacks
				newSelectList.onSelect = selectList.onSelect;
				newSelectList.onCancel = selectList.onCancel;

				// Preserve selected index if possible
				if (selectedIndex >= 0) {
					newSelectList.setSelectedIndex(selectedIndex);
				}

				// Swap in the container
				container.removeChild(selectList);
				container.addChild(newSelectList);
				selectList = newSelectList;
				container.invalidate();
				tui.requestRender();
			}

			// Wire up callbacks
			selectList.onSelect = (item) => {
				if (item.value === "__select_all__") {
					for (const [name] of toggleState) {
						toggleState.set(name, true);
					}
					rebuildSelectList();
					return;
				}

				if (item.value === "__deselect_all__") {
					for (const [name] of toggleState) {
						toggleState.set(name, false);
					}
					rebuildSelectList();
					return;
				}

				if (item.value === "__reset_preset__") {
					applyPresetToToggleState();
					rebuildSelectList();
					return;
				}

				if (item.value === "__separator__") {
					return;
				}

				if (item.value === "__done__") {
					applyTools();
					done(null);
					return;
				}

				// Toggle individual tool
				const current = toggleState.get(item.value) ?? false;
				toggleState.set(item.value, !current);
				rebuildSelectList();
			};

			selectList.onCancel = () => {
				applyTools();
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

		ctx.ui.notify("Session tools updated", "info");
	}

	// ── /list-tools command (read-only view) ───────────────────────
	pi.registerCommand("list-tools", {
		description: "List all available tools with active state",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/list-tools requires interactive mode", "error");
				return;
			}

			const tools = pi.getAllTools().sort((left, right) => left.name.localeCompare(right.name));
			const activeTools = new Set(pi.getActiveTools());
			const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
			const items: SelectItem[] = tools.map((tool) => ({
				value: tool.name,
				label: activeTools.has(tool.name) ? `✓ ${tool.name}` : `○ ${tool.name}`,
				description: truncateDescription(tool.description ?? "No description available."),
			}));

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Available Tools")), 1, 0));

				const selectList = new SelectList(items, Math.min(items.length, 12), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});
				let descriptionExpanded = false;
				const descriptionTitle = new Text("", 1, 0);
				const descriptionText = new Text("", 1, 0);

				const updateExpandedDescription = () => {
					const selectedItem = selectList.getSelectedItem();
					const tool = selectedItem ? toolByName.get(selectedItem.value) : undefined;
					if (descriptionExpanded && selectedItem && tool) {
						descriptionTitle.setText(theme.fg("accent", theme.bold(`Description: ${tool.name}`)));
						descriptionText.setText(tool.description ?? "No description available.");
					} else {
						descriptionTitle.setText("");
						descriptionText.setText("");
					}
				};

				selectList.onSelect = () => done();
				selectList.onCancel = () => done();
				selectList.onSelectionChange = () => {
					descriptionExpanded = false;
					updateExpandedDescription();
				};

				container.addChild(selectList);
				container.addChild(descriptionTitle);
				container.addChild(descriptionText);
				container.addChild(new Text(theme.fg("dim", "↑↓ navigate • ctrl+e expand description • enter or esc close")));
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
							descriptionExpanded = !descriptionExpanded;
							updateExpandedDescription();
							tui.requestRender();
							return;
						}

						selectList.handleInput(data);
						tui.requestRender();
					},
				};
			});
		},
	});

	// ── /session-tools command ─────────────────────────────────────
	pi.registerCommand("session-tools", {
		description: "Add or remove tools for the current session only",
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();

			if (trimmed === "reset") {
				if (originalToolsAtSessionStart) {
					pi.setActiveTools(originalToolsAtSessionStart);
					ctx.ui.notify("Session tools reset to default config", "info");
				} else {
					ctx.ui.notify("No session snapshot to reset to", "warning");
				}
				updateStatus(ctx);
				return;
			}

			if (trimmed === "reset preset") {
				if (presetTools && presetTools.length > 0) {
					pi.setActiveTools(presetTools);
					ctx.ui.notify(`Session tools reset to active preset (${presetTools.length} tools)`, "info");
				} else {
					ctx.ui.notify("No active preset with tools defined", "warning");
				}
				updateStatus(ctx);
				return;
			}

			if (trimmed) {
				const allToolNames = pi.getAllTools().map((t) => t.name);
				const toolName = allToolNames.find((n) => n.toLowerCase() === trimmed);
				if (!toolName) {
					ctx.ui.notify(`Unknown tool "${trimmed}". Use /session-tools to open the selector.`, "error");
					return;
				}

				const activeTools = new Set(pi.getActiveTools());
				const isActive = activeTools.has(toolName);

				if (isActive) {
					activeTools.delete(toolName);
					ctx.ui.notify(`Tool "${toolName}" removed from session`, "info");
				} else {
					activeTools.add(toolName);
					ctx.ui.notify(`Tool "${toolName}" added to session`, "info");
				}

				pi.setActiveTools(Array.from(activeTools));
				updateStatus(ctx);
				return;
			}

			await showToolSelector(ctx);
		},
	});
}