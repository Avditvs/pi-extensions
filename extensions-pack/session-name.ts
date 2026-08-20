/**
 * Give sessions a short name automatically, while retaining /session-name for
 * users who want to choose a name themselves.
 *
 * Usage: /session-name [name] - set or show session name
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_AUTO_NAME_LENGTH = 48;

type GraphemeSegmenter = {
	segment(input: string): Iterable<{ segment: string }>;
};

/** Split text into grapheme clusters, with a conservative fallback. */
function splitGraphemes(value: string): string[] {
	const Segmenter = (
		Intl as typeof Intl & {
			Segmenter?: new (
				locales?: string | string[],
				options?: { granularity?: string },
			) => GraphemeSegmenter;
		}
	).Segmenter;

	if (Segmenter) {
		try {
			return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(value), ({ segment }) => segment);
		} catch {
			// Fall through for runtimes with an incomplete or unavailable ICU.
		}
	}

	return splitGraphemesFallback(value);
}

/**
 * Cover the common extended-grapheme cases when ICU segmentation is not
 * available. This keeps combining marks, emoji modifiers, ZWJ sequences, and
 * regional-indicator pairs together while remaining compatible with older
 * Node runtimes.
 */
function splitGraphemesFallback(value: string): string[] {
	const codePoints = Array.from(value);
	const graphemes: string[] = [];
	let index = 0;

	let isMark: (value: string) => boolean;
	try {
		const markPattern = new RegExp("^\\p{Mark}$", "u");
		isMark = (codePoint) => markPattern.test(codePoint);
	} catch {
		isMark = () => false;
	}

	while (index < codePoints.length) {
		let grapheme = codePoints[index++];
		const firstCodePoint = grapheme.codePointAt(0) ?? 0;

		// A flag is a pair of regional indicators.
		if (firstCodePoint >= 0x1f1e6 && firstCodePoint <= 0x1f1ff && index < codePoints.length) {
			const nextCodePoint = codePoints[index].codePointAt(0) ?? 0;
			if (nextCodePoint >= 0x1f1e6 && nextCodePoint <= 0x1f1ff) {
				grapheme += codePoints[index++];
			}
		}

		while (index < codePoints.length) {
			const next = codePoints[index];
			const nextCodePoint = next.codePointAt(0) ?? 0;
			const isExtend =
				isMark(next) ||
				(nextCodePoint >= 0xfe00 && nextCodePoint <= 0xfe0f) ||
				(nextCodePoint >= 0xe0100 && nextCodePoint <= 0xe01ef) ||
				(nextCodePoint >= 0x1f3fb && nextCodePoint <= 0x1f3ff) ||
				(nextCodePoint >= 0xe0020 && nextCodePoint <= 0xe007f);

			if (isExtend) {
				grapheme += next;
				index++;
				continue;
			}

			// Keep the next character attached after a zero-width joiner.
			if (nextCodePoint === 0x200d && index + 1 < codePoints.length) {
				grapheme += next + codePoints[index + 1];
				index += 2;
				continue;
			}
			break;
		}

		graphemes.push(grapheme);
	}

	return graphemes;
}

/** Remove common Markdown formatting while keeping the text users can read. */
function stripMarkdown(value: string): string {
	return value
		// Images must be handled before links because their syntax starts with `![`.
		.replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
		.replace(/\[([^\]]+)\]\[[^\]]*\]/gu, "$1")
		.replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gu, "$1")
		.replace(/<[^>]+>/gu, "")
		.replace(/```[^\n]*\n?/gu, "")
		.replace(/`([^`]+)`/gu, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gmu, "")
		.replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/gmu, "")
		.replace(/^\s{0,3}>\s?/gmu, "")
		.replace(/^\s*(?:\*\s*){3,}$/gmu, "")
		// Remove emphasis/strike delimiters only when they surround text, rather
		// than changing ordinary characters such as snake_case identifiers.
		.replace(/(^|[\s([{])(\*{2}|_{2}|~{2})(?=\S)(.*?)\2(?=$|[\s)\]}.,!?])/gmu, "$1$3")
		.replace(/(^|[\s([{])([*_~])(?=\S)(.*?)\2(?=$|[\s)\]}.,!?])/gmu, "$1$3")
		.replace(/(^|[\s([{])([*_~])\2(?=$|[\s)\]}.,!?])/gmu, "$1");
}

/** Create a stable, local plain-text title without making another model request. */
export function createAutoSessionName(prompt: string): string | undefined {
	const normalized = stripMarkdown(prompt).replace(/\s+/gu, " ").trim();
	if (!normalized) return undefined;

	const graphemes = splitGraphemes(normalized);
	if (graphemes.length <= MAX_AUTO_NAME_LENGTH) return normalized;

	// Reserve one grapheme for the ellipsis and avoid splitting grapheme clusters.
	const shortened = graphemes.slice(0, MAX_AUTO_NAME_LENGTH - 1).join("").trimEnd();
	const lastSpace = shortened.lastIndexOf(" ");
	const readable = lastSpace > 0 ? shortened.slice(0, lastSpace) : shortened;
	return `${readable}…`;
}

export default function (pi: ExtensionAPI) {
	// This is deliberately session-scoped state. A resumed, forked, or already
	// populated session must never be renamed from a later prompt.
	let canAutoName = false;
	let firstPrompt: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		firstPrompt = undefined;

		// A session file can contain entries outside the current branch, and an
		// existing empty session still must not be renamed. New persisted
		// sessions defer creating their file until the first response, so the
		// file's existence distinguishes them from sessions selected at startup.
		const sessionFile = ctx.sessionManager.getSessionFile();
		const hasExistingSessionFile = sessionFile !== undefined && existsSync(sessionFile);
		canAutoName = !pi.getSessionName() && !hasExistingSessionFile;
	});

	// Capture the prompt before the agent starts, but wait until the run has
	// settled before writing session metadata, so retries and tool-driven turns
	// have completed.
	pi.on("before_agent_start", async (event) => {
		if (canAutoName && firstPrompt === undefined && !pi.getSessionName()) {
			firstPrompt = event.prompt;
		}
	});

	pi.on("agent_settled", async () => {
		if (!canAutoName || firstPrompt === undefined || pi.getSessionName()) return;

		const name = createAutoSessionName(firstPrompt);
		canAutoName = false;
		firstPrompt = undefined;
		if (name) pi.setSessionName(name);
	});

	pi.registerCommand("session-name", {
		description: "Set or show session name (usage: /session-name [new name])",
		handler: async (args, ctx) => {
			const name = args.trim();

			if (name) {
				pi.setSessionName(name);
				ctx.ui.notify(`Session named: ${name}`, "info");
			} else {
				const current = pi.getSessionName();
				ctx.ui.notify(current ? `Session: ${current}` : "No session name set", "info");
			}
		},
	});
}
