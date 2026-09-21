# Pi Extensions Pack

A collection of extensions for [pi](https://pi.dev/), composed behind one auto-discovered entry point. Install the pack with a single symlink to make the included commands, tools, safeguards, and workflows available in pi.

## Included extensions

- **Permission gate** — asks for confirmation before configured dangerous shell commands run.
- **Protected paths** — helps prevent accidental edits to protected files.
- **Todo** — provides an in-session todo list and the `/todos` command.
- **Session tools** — enables or disables individual tools for the session through `/session-tools`.
- **Presets** — loads agent presets, switches between them, and supports `/preset` and `/preset-config`.
- **Skillset** — enables or disables individual skills for the session through `/skillset`.
- **Git checkpoint** — creates git checkpoints during a session.
- **Automatic session naming** — names new sessions from the first prompt while retaining `/session-name [name]` for explicit names.
- **Subagents** — delegates work to isolated pi processes with single, parallel, and chained workflows.

The pack is composed by [`extensions-pack/index.ts`](extensions-pack/index.ts), which is the only entry point pi needs to discover.

## Requirements

- [pi](https://pi.dev/) installed and available on `PATH`.
- A checkout of this repository.
- A Unix-like shell for the symlink commands below.

## Installation

From the repository root, link the extension pack into pi's extension directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn "$(pwd)/extensions-pack" ~/.pi/agent/extensions/extensions-pack
```

Pi will load `extensions-pack/index.ts` through the symlink. Restart pi after creating the link or changing extension files.

### Bundled subagent profiles

The bundled profiles are `default`, `plan`, and `worker`. They are available both to `/preset` and to the `subagent` tool automatically when the extension pack is loaded; no additional symlinks are required. See [`extensions-pack/subagent/README.md`](extensions-pack/subagent/README.md) for the subagent security model and detailed usage.

## Usage

After installation, use pi normally. The pack adds these notable commands:

```text
/session-name                 Show the current session name
/session-name Refactor auth   Set a session name
/todos                       Show todos for the current branch
/session-tools              Open the interactive tool selector
/session-tools <tool>       Toggle a single tool by name
/session-tools reset        Revert to the default tool set from config
/session-tools reset preset Revert to the active preset's tool set
/preset                      Choose an agent preset
/preset worker               Activate the worker preset
/preset-config               Show the active preset configuration
/preset-config worker        Show a named preset configuration
/skillset                    Browse and toggle skills
/skillset pdf-tools          Toggle a single skill by name
/skillset disable brave-search
/skillset enable-all         Re-enable every skill
```

Subagents can be requested in natural language, for example:

```text
Use worker to inspect the authentication flow
Run two worker tasks in parallel: one to inspect models, one to inspect providers
Use a chain: first have worker inspect the read tool, then have plan propose improvements
```

## Presets

A preset configures the model (provider + model), thinking level, available tools, and extra system-prompt instructions. The pack's preset extension activates them:

- `/preset` — interactive selector
- `/preset <name>` — switch directly
- `/preset-config [name]` — show the active or a named preset configuration
- `Ctrl+Shift+U` — cycle through presets
- `pi --preset <name>` — start pi with a preset

CLI flags always override preset values. The active preset survives `/new` but not a pi restart.

### Preset sources

Presets are resolved from, in override order:

1. **Bundled Markdown agents** in `extensions-pack/subagent/agents/` — always available to `/preset`.
2. **User Markdown agents** in `~/.pi/agent/agents/` — override bundled agents with the same name.
3. **Legacy global JSON presets** in `~/.pi/agent/presets.json` — only used when no Markdown agent has the same name.

Project-local JSON presets are never loaded, and project-local Markdown agents under `.pi/agents` are only dispatched as subagents (never used by `/preset`). See [`.pi/presets.json`](.pi/presets.json) for an example legacy configuration.

### Markdown agent format

Markdown agent files are shared between `/preset` and the `subagent` tool:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
thinkingLevel: high
model: provider/model   # optional; omit to inherit the session model
---

System prompt for the agent goes here.
```

`thinkingLevel` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. `model` should be a qualified `provider/model` pair; an unqualified model is kept for subagent dispatch but `/preset` warns that a provider is required.

### Legacy JSON format

`~/.pi/agent/presets.json` entries look like:

```json
{
  "research": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "thinkingLevel": "high",
    "tools": ["read", "grep", "web_search"],
    "instructions": "You are in research mode..."
  }
}
```

## Configuration

Project-local profiles under `.pi/agents` are only loaded when a subagent request explicitly enables the `project` or `both` scope. Treat project-local profiles as repository-controlled instructions and only enable them for trusted repositories.

Pi's normal configuration and model settings remain responsible for authentication and provider selection.

## Repository layout

```text
.pi/
└── presets.json             # Example preset configuration
extensions-pack/
├── index.ts                 # Pack entry point
├── session-name.ts          # Automatic and manual session naming
├── session-tools.ts         # Session-scoped tool selector
├── subagent/                # Isolated subagent dispatch and profiles
└── ...                      # Individual extensions
README.md
```

## Development

The source is TypeScript and is intended to run through pi's extension loader. Keep extensions small and compose new modules in `extensions-pack/index.ts` so the pack remains installable with a single symlink.

To add an extension:

1. Add a focused module under `extensions-pack/`.
2. Export and invoke it from `extensions-pack/index.ts`.
3. Update this README with its user-facing commands or configuration.
4. Restart pi and verify the extension in a test session.
