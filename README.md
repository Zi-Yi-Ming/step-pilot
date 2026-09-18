<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README_CN.md">简体中文</a>
</p>

> [!IMPORTANT]
> **Unofficial — a community-driven exploration.** Step Pilot originated from a snapshot of `stepfun-ai/Step-Realtime-CLI` (`step-code-explore-pi` at `db7dd58`, 2026-08-21) and has been independently maintained and substantially evolved since 2026-09-02.

# Step Pilot

> **A lightweight terminal coding agent built around Step models, with an observable and recovery-oriented agent harness.**

Step Pilot is a terminal coding agent. The model uses tools to read and write real files, run real commands, and iterate until the task is done — with the failure, recovery and verification steps visible instead of hidden.

## Design philosophy

> Model capability is only one part of an effective coding agent. Step Pilot explores **how far a lightweight model can go when paired with a purpose-built harness**.

Lightweight models such as Step 3.7 Flash are fast and cheap, but they break under traditional agent scaffolding: long system prompts, runaway tool output, and lazy compaction eat the context window before the real work starts. So Step Pilot treats the harness as the product:

| Harness concern | What Step Pilot actually does |
|-----------------|-------------------------------|
| Context | ~2000-char system prompt; tool results capped at 400K chars; compaction at 75% with a 20K-token fidelity budget for user messages |
| Recovery | Hard `maxIterations` ceiling, staged turn warnings, no-progress detection, structured error feedback back to the model |
| Verification | Completion is not accepted from the model — `step mission verify` runs the acceptance commands and records the evidence |
| Observability | Every run emits structured events (`wire.jsonl`); the same events feed the benchmark |
| Safety | Three permission tiers, with confirmation required for high-risk commands by default |

Every mechanism above maps to a module in `src/`. Details in [harness](./docs/en/harness.md).

## Features

- **Terminal UI** built on pi-tui — streaming output, tool activity, diffs, expandable results
- **Streaming** model output with real-time tool feedback (graceful fallback when a provider cannot stream)
- **Tool use** — filesystem, shell, search, web, tasks, plus sub-agents when you need them
- **Context engineering** — result caps, preprocessing and compaction, so context stays a budget rather than a log
- **Iterative repair** — failures return as structured feedback the model acts on, not as a blind retry
- **Verification** — an independent verifier plus evidence bundles; completion has to be earned
- **Sessions** — persistent, resumable, forkable, with non-interactive `stream-json` output
- **Traces** — structured events for every run, reusable for analysis
- **Benchmark mode** — run local tasks and measure what the harness actually changes

## Quick start

First run is interactive — it walks you through API key, provider, and model selection. No manual config editing required.

Artifacts are distributed through GitHub Releases, not the npm public registry. Install the latest release tarball with npm:

```bash
npm i -g https://github.com/Zi-Yi-Ming/step-pilot/releases/latest/download/step-pilot.tgz
step-pilot
```

Requires Node.js >= 22. Without Node, grab the standalone executable for your platform from [Releases](https://github.com/Zi-Yi-Ming/step-pilot/releases/latest); to modify the code, install from source instead.

Common entry points:

```bash
step-pilot                              # interactive TUI
step-pilot "fix the failing tests"      # run one task and exit
step-pilot --model step-3.7-flash       # override the model
step-pilot -y                           # yolo: no confirmations
step-pilot -p "task" --output-format stream-json   # non-interactive, CI-friendly
step-pilot session list                 # list sessions
step-pilot -r                           # resume a session
```

See [Quick start](./docs/en/quickstart.md) for installation and configuration details, and [Installation](./docs/en/installation.md) for the trade-offs between installation methods.

If you already have another AI agent at hand, [`skills/step-pilot-install/`](./skills/step-pilot-install/SKILL.md) is an install-instructions skill: clone the repo, point your agent at it, and it will know how to build, where to put the API key, and what to check when the build fails.

## Example

A real run, not a mock-up. Task `cascading-fix-001` plants three independent bugs across three files — each test run reveals the next one. Model `step-3.7-flash`, executed 2026-09-18.

```
> Debug the failing test suite. There are 3 independent bugs across 3 source files.
> Run 'npx vitest run' after each fix to reveal the next bug.

→ list_dir                       inspect repository
→ read_file  parser.ts           locate bugs
→ read_file  filter.ts
→ read_file  formatter.ts
✓ edit_file  parser.ts           fix JSON parser
→ bash       npx vitest run
✗ 2 failed                       ✓ parses json | × filters active | × formats output
✓ edit_file  filter.ts           fix active filter
→ bash       npx vitest run
✗ 1 failed                       ✓ parses json | ✓ filters active | × formats output
✓ edit_file  formatter.ts        fix HTML formatter
→ bash       npx vitest run
✓ 3 passed                       Test Files 1 passed | Tests 3 passed (3)

Completed
  Turns: 10    Tool calls: 13    Recovered tool errors: 2    Elapsed: 42.2s
  Verification: 1 passed / 0 failed
```

The progression is the point: the agent does not declare success — it runs the tests, reads the failure, patches, and re-runs, three times.

**No token count is shown here on purpose.** Step's protocols always report `reasoning_tokens: 0` and thinking consumption is not observable; the provider-reported input/output/total figures for this run contradict each other. Rather than publish a number we cannot stand behind, we publish what the harness measures. See [benchmark](./docs/en/benchmark.md).

Raw result: [`benchmark/results/demo-cascading-fix.json`](./benchmark/results/demo-cascading-fix.json).

## Architecture

```
        User
         ↓
        TUI  (pi-tui)
         ↓
   Agent Runtime
   ├── Context Manager      result caps, preprocessing, compaction
   ├── Planner              goals, tasks, todos, plan mode
   ├── Tool Registry        36 modules, permission-gated
   ├── Recovery             iteration ceiling, no-progress, structured errors
   ├── Verification         post-green, Mission verifier + evidence
   └── Session / Trace      snapshot + append-only wire.jsonl
         ↓
     Provider  (Step / OpenAI Chat / Responses / Anthropic)
         ↓
      Step Model
```

Source layers: `config` → `provider` → `tools` → `agent` (the loop) → `tui-pi` → `cli.ts`; `main.ts` is only the bin bootstrap. Full module boundaries in [architecture](./docs/en/architecture.md).

## Documentation

English documentation lives under [`docs/en/`](./docs/en/); the Chinese originals under `docs/` are the source of truth.

| Document | Contents |
|----------|----------|
| [Quick start](./docs/en/quickstart.md) | Install, set the API key, first conversation |
| [Installation](./docs/en/installation.md) | Requirements, building from source, global command, upgrade and uninstall |
| [Configuration](./docs/en/configuration.md) | Every config.toml field, multi-protocol providers and model aliases, environment variables, data directories |
| [Architecture](./docs/en/architecture.md) | Module boundaries, layers, data flow, boundaries not to break |
| [Harness](./docs/en/harness.md) | Context management, retry, recovery, verification, traces — the core of this project |
| [Interactive use](./docs/en/interactive.md) | TUI layout, slash commands, keybindings, the three permission tiers, plan mode |
| [Tools](./docs/en/tools.md) | Parameters and behavioral limits of every built-in tool |
| [Session management](./docs/en/sessions.md) | Persistence, resuming, forking, compaction, non-interactive output |
| [Mission](./docs/en/mission.md) | Recoverable, auditable tasks: fact chain, checkpoints, recovery, independent verifier |
| [Benchmark](./docs/en/benchmark.md) | Running tasks, recorded metrics, and why historical numbers are not citable |
| [Troubleshooting](./docs/en/troubleshooting.md) | Symptoms, causes and fixes |
| [Sub-agents and automation](./docs/en/agents.md) | spawn_agent, dynamic_workflow, autonomous goals, background tasks |
| [Skills, plugins, and MCP](./docs/en/skills-and-mcp.md) | SKILL.md format, plugins, MCP integration |
| [Hooks](./docs/en/hooks.md) | Running shell commands at five lifecycle events |
| [Step 3.7 Flash best practices](./docs/en/best-practices.md) | Getting the most out of Step Pilot with small models |

## Development

```bash
pnpm dev          # run directly with tsx, for interactive development
pnpm typecheck    # tsc in strict mode
pnpm test         # vitest
pnpm benchmark run --runs 1   # run the local benchmark
```

CI runs typecheck, build, and test on Ubuntu, Windows, and macOS. Development conventions and the rules for model integration are in [`AGENTS.md`](./AGENTS.md); the contribution process is in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Acknowledgements

Step Pilot is built on the pi open-source ecosystem — its TUI/agent shell uses [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi) (`packages/tui` of the pi repository) — and originated from a snapshot of the stepfun-ai `Step-Realtime-CLI` `step-code-explore-pi` exploration branch. This project independently fixes upstream issues and re-tunes the agent for small models such as Step 3.7 Flash; it is not affiliated with, sponsored by, or endorsed by earendil-works, stepfun-ai, or any other third-party project. Third-party open-source license texts are collected under [`licenses/`](./licenses/) for compliance, with details in [`licenses/NOTICE.md`](./licenses/NOTICE.md).

## License

MIT, see [`LICENSE`](./LICENSE). Third-party acknowledgements and licenses are under [`licenses/`](./licenses/).
