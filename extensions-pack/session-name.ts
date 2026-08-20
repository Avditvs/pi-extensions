/**
 * Give sessions a short name automatically, while retaining /session-name for
 * users who want to choose a name themselves.
 *
 * Usage: /session-name [name] - set or show session name
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_AUTO_NAME_LENGTH = 48;
const MAX_TITLE_PROMPT_LENGTH = 4_000;
const TITLE_PROMPT_TRUNCATION_MARKER = "\n\n[First prompt truncated for title generation]";

// Terminal/control characters are not safe in session metadata. Check the raw
// model response before trim(), since trim() would otherwise hide some of them.
const UNSAFE_TITLE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const ANSI_ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/u;

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

function cleanGeneratedSessionName(response: string): string | undefined {
	if (UNSAFE_TITLE_CONTROL_CHARACTERS.test(response) || ANSI_ESCAPE_SEQUENCE.test(response)) return undefined;

	const raw = response.trim();
	if (!raw || /\r(?!\n)/u.test(raw) || /\n/gu.test(raw)) return undefined;

	let title = stripMarkdown(raw).replace(/\s+/gu, " ").trim();

	// Do not turn an explanation into a title just because it happens to fit the
	// length limit. These are common ways models ignore the title-only request.
	if (/^(?:here(?:'s| is)|sure[!,]?|the (?:session )?title is|(?:session )?title\s*[:=-]|a (?:concise )?(?:session )?title (?:could be|would be)|i(?:'d| would| can)|this (?:could be|is a))\b/iu.test(title)) {
		return undefined;
	}

	// Models occasionally wrap an otherwise valid title in quotes despite the
	// instruction. Remove only a matching outer pair, not meaningful punctuation.
	if ((title.startsWith('"') && title.endsWith('"')) || (title.startsWith("'") && title.endsWith("'"))) {
		title = title.slice(1, -1).trim();
	}

	return createAutoSessionName(title);
}

export default function (pi: ExtensionAPI) {
	// This is deliberately session-scoped state. A resumed, forked, or already
	// populated session must never be renamed from a later prompt.
	let canAutoName = false;
	let firstPrompt: string | undefined;
	let firstPromptGeneration = 0;
	let sessionGeneration = 0;
	let sessionIsShutDown = true;
	let pendingTitleController: AbortController | undefined;

	const isCurrentSession = (generation: number): boolean =>
		!sessionIsShutDown && generation === sessionGeneration;

	pi.on("session_start", async (_event, ctx) => {
		// Invalidate and cancel work belonging to the session that was replaced.
		pendingTitleController?.abort();
		pendingTitleController = undefined;
		const generation = ++sessionGeneration;
		sessionIsShutDown = false;
		firstPrompt = undefined;
		firstPromptGeneration = generation;

		// A session file can contain entries outside the current branch, and an
		// existing empty session still must not be renamed. New persisted
		// sessions defer creating their file until the first response, so the
		// file's existence distinguishes them from sessions selected at startup.
		const sessionFile = ctx.sessionManager.getSessionFile();
		const hasExistingSessionFile = sessionFile !== undefined && existsSync(sessionFile);
		// Keep the token capture adjacent to session_start: all asynchronous title
		// work must prove that it still belongs to this session before committing.
		canAutoName = isCurrentSession(generation) && !pi.getSessionName() && !hasExistingSessionFile;
	});

	pi.on("session_shutdown", async () => {
		sessionIsShutDown = true;
		++sessionGeneration;
		pendingTitleController?.abort();
		pendingTitleController = undefined;
		canAutoName = false;
		firstPrompt = undefined;
		firstPromptGeneration = 0;
	});

	// Capture the prompt before the agent starts, but wait until the run has
	// settled before writing session metadata, so retries and tool-driven turns
	// have completed.
	pi.on("before_agent_start", async (event) => {
		if (canAutoName && firstPrompt === undefined && !pi.getSessionName()) {
			firstPrompt = event.prompt;
			firstPromptGeneration = sessionGeneration;
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// Use the generation captured with the first prompt, rather than the
		// generation current when a delayed settled event happens to run.
		const generation = firstPromptGeneration;
		if (!isCurrentSession(generation) || !canAutoName || firstPrompt === undefined) return;
		if (pi.getSessionName()) return;

		const prompt = firstPrompt;
		// Keep the complete prompt for the deterministic local fallback, but cap
		// the context sent to the title model so an unusually large first turn
		// cannot create an unnecessarily large request.
		const promptGraphemes = splitGraphemes(prompt);
		const truncationMarkerLength = splitGraphemes(TITLE_PROMPT_TRUNCATION_MARKER).length;
		const titlePrompt = promptGraphemes.length <= MAX_TITLE_PROMPT_LENGTH
			? prompt
			: `${promptGraphemes.slice(0, Math.max(0, MAX_TITLE_PROMPT_LENGTH - truncationMarkerLength)).join("")}${TITLE_PROMPT_TRUNCATION_MARKER}`;
		// Consume the eligibility window before making the optional request. This
		// also prevents a later queued event from issuing a second request.
		canAutoName = false;
		firstPrompt = undefined;

		let name: string | undefined;
		try {
			// Only use the model active for this session. Falling back to the first
			// available registry model can cross provider or bypass scopes.
			const model = ctx.model;
			if (model && isCurrentSession(generation)) {
				const controller = new AbortController();
				pendingTitleController = controller;
				let timeout: ReturnType<typeof setTimeout> | undefined;
				const cancellationPromise = new Promise<never>((_, reject) => {
					controller.signal.addEventListener("abort", () => reject(new Error("Session title request cancelled")), { once: true });
				});
				const timeoutPromise = new Promise<never>((_, reject) => {
					timeout = setTimeout(() => {
						controller.abort();
						reject(new Error("Session title request timed out"));
					}, 15_000);
				});
				try {
					const response = await Promise.race([
						ctx.modelRegistry.complete(
							model,
							{
								messages: [{
									role: "user",
									content: [{
										type: "text",
										text: `Create a concise session title based on the user's first prompt below. Return only plain text: no Markdown, no quotes, and no explanation. The title must be no more than ${MAX_AUTO_NAME_LENGTH} graphemes.\n\nFirst prompt:\n${titlePrompt}`,
									}],
									timestamp: Date.now(),
								}],
							},
							{ maxTokens: 32, signal: controller.signal, cacheRetention: "none" },
						),
						timeoutPromise,
						cancellationPromise,
					]);
					// Anything other than a normal stop may contain only a partial
					// response (including an explicit abort).
					if (response.stopReason !== "stop") throw new Error("Incomplete session title response");
					const text = response.content
						.filter((content): content is { type: "text"; text: string } => content.type === "text")
						.map((content) => content.text)
						.join("\n");
					name = cleanGeneratedSessionName(text);
				} finally {
					if (timeout) clearTimeout(timeout);
					if (pendingTitleController === controller) pendingTitleController = undefined;
				}
			}
		} catch {
			// Model, auth, cancellation, and request failures all use the local
			// deterministic title instead.
			name = undefined;
		}

		// The request may have completed after shutdown or a session replacement.
		// Do not even read session metadata unless this run still owns the session.
		if (!isCurrentSession(generation)) return;
		name ??= createAutoSessionName(prompt);
		if (!isCurrentSession(generation)) return;
		const currentName = pi.getSessionName();
		if (!isCurrentSession(generation)) return;
		if (name && !currentName) pi.setSessionName(name);
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
