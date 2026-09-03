<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README_CN.md">简体中文</a>
</p>

> [!IMPORTANT]
> **Unofficial — a community-driven exploration.** Step Pilot is a terminal coding agent CLI, forked and evolved independently by community contributors.

# Step Pilot

[![CI](https://github.com/Zi-Yi-Ming/step-pilot/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/Zi-Yi-Ming/step-pilot/actions/workflows/test.yml)

A terminal coding agent CLI optimized for **Step 3.7 Flash stability**. It ditches the heavy prompt stack and bloated context budget that make small models fail: a ~2000 char system prompt, tighter tool-result caps, and earlier compaction let Flash actually follow instructions — without giving up the agent loop, sub-agents, or plugin system when you need them.

## Why step-pilot

Small frontier models are fast and cheap, but they break under the weight of traditional agent scaffolding: long system prompts, runaway tool outputs, and lazy compression eat the context window before the real work starts.

step-pilot treats small-model instruction following as a first-class constraint:

- **~2000 char system prompt** — the smallest useful instruction set, not a kitchen-sink manifesto
- **Tool results capped at 400K chars** — stops one runaway command from drowning the model
- **Compaction triggers earlier, keeps less** — default trigger at 75% context, retains the last 6 messages during summary; user messages get a 20K token fidelity budget
- **Clearer tool contracts** — core tool descriptions rewritten for unambiguous instruction following

The point isn't to make Flash behave like a 700B model. It's to stop wasting its context on things that don't matter, so the instructions that do matter actually get followed.

## What it is

step-pilot is a terminal coding agent CLI. The model uses tools to read and write real files, run real commands, and spawn sub-agents; results feed back into the loop until the task is done.

It's built with **pi-tui** and speaks three protocols — Anthropic Messages, OpenAI Chat Completions, OpenAI Responses — so any compatible provider works out of the box. Step is the default and best-tested path.

## Quick start

First run is interactive — it walks you through API key, provider, and model selection. No manual config editing required.

Artifacts are distributed through GitHub Releases, not the npm public registry. Install the latest release tarball with npm:

```bash
npm i -g https://github.com/Zi-Yi-Ming/step-pilot/releases/latest/download/step-pilot.tgz
step-pilot
```

Requires Node.js >= 22. Without Node, grab the standalone executable for your platform from [Releases](https://github.com/Zi-Yi-Ming/step-pilot/releases/latest); to modify the code, install from source instead.

See [Quick start](./docs/en/quickstart.md) for installation and configuration details, and [Installation](./docs/en/installation.md) for the trade-offs between installation methods.

If you already have another AI agent at hand, [`skills/step-pilot-install/`](./skills/step-pilot-install/SKILL.md) is an install-instructions skill: clone the repo, point your agent at it, and it will know how to build, where to put the API key, and what to check when the build fails.

## Documentation

English documentation lives under [`docs/en/`](./docs/en/); the Chinese originals under [`docs/`](./docs/) are the source of truth.

| Document | Contents |
|----------|----------|
| [Quick start](./docs/en/quickstart.md) | Install, set the API key, first conversation |
| [Installation](./docs/en/installation.md) | Requirements, building from source, global command, upgrade and uninstall |
| [Configuration](./docs/en/configuration.md) | Every config.toml field, multi-protocol providers and model aliases, environment variables, data directories |
| [Interactive use](./docs/en/interactive.md) | TUI layout, slash commands, keybindings, the three permission tiers, plan mode, switching model and provider |
| [Tools](./docs/en/tools.md) | Parameters and behavioral limits of every built-in tool, parallel execution and result feedback |
| [Sub-agents and automation](./docs/en/agents.md) | spawn_agent, dynamic_workflow, autonomous goals, scheduled tasks, background tasks |
| [Session management](./docs/en/sessions.md) | Persistence, resuming, forking, context compaction, review, non-interactive output |
| [Skills, plugins, and MCP](./docs/en/skills-and-mcp.md) | SKILL.md format, loading precedence, plugins, MCP integration |
| [Hooks](./docs/en/hooks.md) | Running shell commands at five lifecycle events |
| [Step 3.7 Flash best practices](./docs/en/best-practices.md) | How to get the most out of step-pilot with small models |

## Development

Source layers: `config` → `provider` → `tools` → `agent` (the loop) → `tui-pi` (pi-tui) → `cli.ts` (entry); `main.ts` is only the bin bootstrap (sets NODE_ENV, then loads cli.js).

```bash
pnpm dev          # run directly with tsx, for interactive development
pnpm typecheck    # tsc in strict mode
pnpm test         # vitest
```

CI runs typecheck, build, and test on Ubuntu, Windows, and macOS. Development conventions and the rules for model integration are in [`AGENTS.md`](./AGENTS.md); the contribution process is in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Acknowledgements

Step Pilot is built on the pi open-source ecosystem — its TUI/agent shell uses [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi) (`packages/tui` of the pi repository) — and is forked from the stepfun-ai `Step-Realtime-CLI` step-code-pi exploration line. This project independently fixes upstream issues and re-tunes the agent for small models such as Step 3.7 Flash; it is not affiliated with, sponsored by, or endorsed by earendil-works, stepfun-ai, or any other third-party project. Third-party open-source license texts are collected under [`licenses/`](./licenses/) for compliance, with details in [`licenses/NOTICE.md`](./licenses/NOTICE.md).

## License

MIT, see [`LICENSE`](./LICENSE). Third-party acknowledgements and licenses are under [`licenses/`](./licenses/).
