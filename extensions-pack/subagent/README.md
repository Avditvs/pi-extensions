# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
└── agents/              # Bundled agent definitions
    ├── default.md       # Default interactive preset
    ├── plan.md          # Planning interactive preset
    └── worker.md        # General-purpose (full capabilities)
```

## Installation

From the repository root, symlink the files:

```bash
# Symlink the extension pack.
mkdir -p ~/.pi/agent/extensions
ln -sf "$(pwd)/extensions-pack" ~/.pi/agent/extensions/extensions-pack

# Bundled profiles and workflow prompts are loaded automatically.
# No additional symlinks are required.
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Loads the bundled agents plus **user-level agents** from `~/.pi/agent/agents`. User agents override bundled agents with the same name.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Project agents override bundled and user agents with the same name. Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## Usage

### Single agent
```
Use worker to add input validation to API endpoints
```

### Parallel execution
```
Run two worker tasks in parallel: one to inspect models, one to inspect providers
```

### Chained workflow
```
Use a chain: first have worker inspect the read tool, then have plan propose improvements using {previous}
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status
- Returns each completed task's final output to the parent model, capped at 50 KB per task
- Returns failure diagnostics from stderr/error messages when a child exits before producing output

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are Markdown files with YAML frontmatter. The same user-level definitions power subagent dispatch and `/preset`:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
thinkingLevel: high
# Optional: omit it to inherit the active session model.
model: anthropic/claude-sonnet-4-5
---

System prompt for the agent goes here.
```

`thinkingLevel` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. When `model` or `thinkingLevel` is omitted, the subagent inherits that setting from the dispatching session. An unqualified model (for example `claude-sonnet-4-5`) remains passed to the subagent CLI for legacy compatibility. `/preset` retains that value but warns that a provider/model is required, because it cannot safely select a provider.

`/preset` automatically loads the bundled Markdown profiles and also loads definitions from `~/.pi/agent/agents`. Markdown agent definitions override a same-name legacy global `~/.pi/agent/presets.json` entry. Project-local `presets.json` is not loaded.

**Locations:**
- `extensions-pack/subagent/agents/*.md` - Bundled profiles (automatically available to `/preset`; symlink into `~/.pi/agent/agents` only to dispatch them as subagents)
- `~/.pi/agent/agents/*.md` - User-level (always loaded; also a `/preset` source)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`; never used by `/preset`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Bundled Agent Definitions

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `default` | Standard interactive preset | Inherits | read, bash, edit, write, todo, subagent |
| `plan` | Interactive planning preset | Inherits | read, grep, find, ls, todo |
| `worker` | General-purpose implementation | Inherits | default child tools |

You can add specialized dispatch agents under `~/.pi/agent/agents` or `.pi/agents`. See [Agent Definitions](#agent-definitions) for the Markdown format.

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
