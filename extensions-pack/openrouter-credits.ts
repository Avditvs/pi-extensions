/**
 * Report OpenRouter spend for the current day and the remaining account credits.
 *
 * Usage: /credits
 *
 * Reads the OpenRouter credential from auth.json (OAuth-minted key or API key),
 * falling back to OPENROUTER_API_KEY, then queries the OpenRouter REST API:
 *   - GET /credits for account-wide total_credits and total_usage
 *   - GET /key     for usage_daily (spend since the UTC day boundary)
 *
 * OpenRouter keys usage_daily to the UTC calendar day, not the local day, so the
 * status labels the exact UTC date the figure covers to avoid any ambiguity.
 *
 * The footer status refreshes on every new session and every 10 turns.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const KEY_URL = "https://openrouter.ai/api/v1/key";
const REQUEST_TIMEOUT_MS = 10_000;
const STATUS_KEY = "openrouter-credits";
const REFRESH_EVERY_TURNS = 10;

interface OpenRouterCredits {
	totalCredits: number;
	totalUsage: number;
}

interface CreditSnapshot {
	utcDaily: number;
	remaining: number;
}

interface StoredCredential {
	type?: string;
	access?: string;
	key?: string;
}

/** Pick the bearer token from a stored credential, accepting OAuth or API key shapes. */
function extractApiKey(credential: unknown): string | undefined {
	if (typeof credential !== "object" || credential === null) return undefined;
	const stored = credential as StoredCredential;
	const token = stored.access ?? stored.key;
	return typeof token === "string" && token.length > 0 ? token : undefined;
}

/** Read the OpenRouter credential stored by pi in auth.json. */
async function readStoredApiKey(): Promise<string | undefined> {
	try {
		const raw = await readFile(join(getAgentDir(), "auth.json"), "utf8");
		const store = JSON.parse(raw) as { openrouter?: unknown };
		return extractApiKey(store.openrouter);
	} catch {
		return undefined;
	}
}

/**
 * Resolve the OpenRouter API key that pi itself uses, preferring the credential
 * stored in auth.json and falling back to OPENROUTER_API_KEY. Preferring the
 * environment would report usage for a different key than the one making requests.
 */
async function resolveApiKey(): Promise<string | undefined> {
	return (await readStoredApiKey()) ?? process.env.OPENROUTER_API_KEY;
}

async function fetchJson<T>(url: string, apiKey: string): Promise<T> {
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`OpenRouter API returned HTTP ${response.status}`);
	return (await response.json()) as T;
}

async function fetchCredits(apiKey: string): Promise<OpenRouterCredits> {
	const body = await fetchJson<{ data: { total_credits: number; total_usage: number } }>(CREDITS_URL, apiKey);
	return { totalCredits: body.data.total_credits, totalUsage: body.data.total_usage };
}

async function fetchDailyUsage(apiKey: string): Promise<number> {
	const body = await fetchJson<{ data: { usage_daily: number } }>(KEY_URL, apiKey);
	return body.data.usage_daily;
}

async function fetchSnapshot(apiKey: string): Promise<CreditSnapshot> {
	const [credits, utcDaily] = await Promise.all([fetchCredits(apiKey), fetchDailyUsage(apiKey)]);
	return { utcDaily, remaining: credits.totalCredits - credits.totalUsage };
}

function formatUsd(amount: number): string {
	return `$${amount.toFixed(4)}`;
}

/** UTC calendar day that usage_daily currently covers, e.g. "2026-09-28". */
function formatUtcDay(now: Date = new Date()): string {
	return `${now.toISOString().slice(0, 10)} UTC`;
}

function formatStatus(snapshot: CreditSnapshot): string {
	return `⬡ ${formatUsd(snapshot.remaining)} · ${formatUtcDay()} ${formatUsd(snapshot.utcDaily)}`;
}

export default function (pi: ExtensionAPI): void {
	let turnCount = 0;

	/** Refresh the footer status, keeping the last known value on transient failures. */
	const refreshStatus = async (ctx: ExtensionContext): Promise<void> => {
		const apiKey = await resolveApiKey();
		if (!apiKey) return;

		try {
			const snapshot = await fetchSnapshot(apiKey);
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", formatStatus(snapshot)));
		} catch {
			// Keep the last known status; a later refresh will retry.
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		turnCount = 0;
		await refreshStatus(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		turnCount += 1;
		if (turnCount % REFRESH_EVERY_TURNS !== 0) return;
		await refreshStatus(ctx);
	});

	pi.registerCommand("credits", {
		description: "Show OpenRouter's UTC-day spend and remaining credits",
		handler: async (_args, ctx) => {
			const apiKey = await resolveApiKey();
			if (!apiKey) {
				ctx.ui.notify("No OpenRouter credentials found. Run /login openrouter or set OPENROUTER_API_KEY.", "error");
				return;
			}

			try {
				const snapshot = await fetchSnapshot(apiKey);
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", formatStatus(snapshot)));
				ctx.ui.notify(
					`OpenRouter — ${formatUtcDay()} ${formatUsd(snapshot.utcDaily)} · remaining ${formatUsd(snapshot.remaining)}`,
					"info",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not fetch OpenRouter credits: ${message}`, "error");
			}
		},
	});
}