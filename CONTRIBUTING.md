# Contributing to Step Pilot

Thanks for your interest in improving Step Pilot.

## Code of Conduct

Be respectful and constructive. We're here to make the tool better for everyone.

## How to contribute

1. Fork the repo and create a feature branch from `main`.
2. Make the smallest change that solves the problem.
3. Run `pnpm typecheck` and `pnpm test` before opening a PR.
4. In the PR description, explain the change, why it's needed, and how you validated it.

## Development setup

```bash
pnpm install
pnpm dev
```

## Reporting bugs

Use the bug report template and include:
- OS and Node version
- CLI invocation and config (`~/.step-pilot/config.toml`, redacted)
- Exact error output and steps to reproduce

## Feature requests

Use the feature request template. For larger changes, open an issue first to discuss direction before writing code.

## Style rules

- Keep diffs focused; avoid unrelated refactors.
- Prefer explicit, readable code over cleverness.
- When changing user-facing behavior, update docs and i18n strings together.
