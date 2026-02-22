# Contributing

## Scope

This repository focuses on deployment and operations for Serena on Cloudflare.
Changes to Serena core behavior should generally be proposed upstream at
`oraios/serena`.

## Development Workflow

1. Create a branch for your change.
2. Keep changes focused (deployment, docs, or operational fixes).
3. Update documentation when behavior changes.
4. Avoid committing secrets, account IDs, or local runtime state.

## Local Checks

```bash
pnpm install
pnpm run typecheck
```

If you modify runtime behavior, include a short validation note in your pull
request (for example, `initialize -> notifications/initialized -> tools/list`).

## Pull Requests

Please include:

- What changed
- Why it changed
- Any rollout or compatibility impact
- How you tested it
