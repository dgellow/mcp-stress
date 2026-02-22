# mcp-stress

## Scripts

- `./scripts/format` — format all files (deno fmt)
- `./scripts/lint` — format check + type check (deno fmt --check, deno check)
- `./scripts/test` — run tests (deno test)
- `./scripts/build [platform]` — deno compile + npm build (auto-detects
  platform, or pass e.g. `linux-x64`)
- `./scripts/start` — run the CLI

Always use these scripts instead of running deno commands directly.
