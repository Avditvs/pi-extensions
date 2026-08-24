import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import gitCheckpoint from "./git-checkpoint.ts";
import permissionGate from "./permission-gate.ts";
import preset from "./preset.ts";
import protectedPaths from "./protected-paths.ts";
import sessionName from "./session-name.ts";
import sessionTools from "./session-tools.ts";
import subagent from "./subagent/index.ts";
import todo from "./todo.ts";

/**
 * Load all extensions in this pack from the single auto-discovered entry point.
 *
 * Pi discovers extension files directly and index.ts files one directory
 * below the extensions directory, but it does not
 * recursively discover TypeScript files inside a linked directory. Keeping
 * the individual examples as modules and composing them here lets the whole
 * pack be installed with one symlink.
 */
export default function (pi: ExtensionAPI): void {
	permissionGate(pi);
	protectedPaths(pi);
	todo(pi);
	preset(pi);
	gitCheckpoint(pi);
	sessionName(pi);
	sessionTools(pi);
	subagent(pi);
}
