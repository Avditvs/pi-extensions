/**
 * List Tools Extension
 *
 * Provides a /list-tools command that displays every tool available to Pi,
 * including tools registered by extensions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

const DESCRIPTION_MAX_LENGTH = 80;

function truncateDescription(description: string): string {
	const singleLine = description.replace(/\s+/g, " ").trim();
	if (singleLine.length <= DESCRIPTION_MAX_LENGTH) return singleLine;
	return `${singleLine.slice(0, DESCRIPTION_MAX_LENGTH - 3)}...`;
}

export default function listToolsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("list-tools", {
		description: "List all available tools",
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
				label: activeTools.has(tool.name) ? `${tool.name} (active)` : tool.name,
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
}
