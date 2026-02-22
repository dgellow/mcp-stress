# mcp-stress

Stress testing tool for MCP (Model Context Protocol) servers.

## Install

```bash
# npm
npx mcp-stress <command>
npm install -g mcp-stress

# JSR / Deno
deno install -g -A --name mcp-stress jsr:@dgellow/mcp-stress/cli
```

## Commands

### run

Execute a stress test against an MCP server.

```bash
# Stdio transport (spawns the server)
mcp-stress run -d 30 -c 10 --tool echo -- node my-server.js

# HTTP transport
mcp-stress run -d 30 -c 10 --url http://localhost:3000/mcp

# Find max throughput (auto-scales concurrency)
mcp-stress run -p find-ceiling -d 120 -c 50 -- node my-server.js

# CI mode: JSON output + assertions
mcp-stress run --json --assert "p99 < 500ms" --assert "error_rate < 1%" -- node my-server.js

# Live browser dashboard
mcp-stress run --live -d 60 -c 10 -o results.ndjson -- node my-server.js

# Send exactly N requests (useful for debugging)
mcp-stress run -n 5 -v -- node my-server.js
```

**Options:**

| Flag                | Description                                                                       |
| ------------------- | --------------------------------------------------------------------------------- |
| `-p, --profile`     | Workload profile (default: `tool-flood`)                                          |
| `-d, --duration`    | Test duration in seconds (default: 10)                                            |
| `-n, --requests`    | Stop after N requests (overrides duration)                                        |
| `-c, --concurrency` | Peak concurrent workers (default: 1)                                              |
| `-t, --timeout`     | Request timeout in ms (default: 30000)                                            |
| `--tool`            | Target a specific tool by name                                                    |
| `--shape`           | Load shape: `constant`, `linear-ramp`, `exponential`, `step`, `spike`, `sawtooth` |
| `-o, --output`      | NDJSON output file path                                                           |
| `--live`            | Open real-time browser dashboard                                                  |
| `--json`            | Output JSON summary to stdout                                                     |
| `--assert`          | Threshold assertion, repeatable (e.g. `"p99 < 500ms"`)                            |
| `--seed`            | PRNG seed for reproducibility                                                     |
| `--sse`             | Use legacy HTTP+SSE transport (default: streamable-http)                          |
| `-v, --verbose`     | Log every request/response                                                        |

### chart

Generate an interactive HTML report from a previous run.

```bash
mcp-stress chart results.ndjson --open
```

### compare

Compare two test runs and detect regressions.

```bash
mcp-stress compare baseline.ndjson current.ndjson --open
mcp-stress compare baseline.ndjson current.ndjson --json --assert "p99_delta < 10%"
```

### diagnose

Probe server connectivity and protocol compliance.

```bash
mcp-stress diagnose -- node my-server.js
mcp-stress diagnose --url http://localhost:3000/mcp
```

### discover

Enumerate server capabilities (tools, resources, prompts).

```bash
mcp-stress discover -- node my-server.js
```

### profiles / shapes

List available workload profiles and load shapes.

```bash
mcp-stress profiles
mcp-stress shapes
```

## Transports

- **stdio** (default): Spawns the server as a subprocess. Use
  `-- command [args]`.
- **Streamable HTTP**: Connect to a running server. Use `--url`.
- **SSE** (legacy): Use `--url` with `--sse`.

## Output

All test data is written as NDJSON (newline-delimited JSON) with three event
types:

- `meta` — run parameters and configuration
- `request` — individual request results (method, latency, ok/error)
- `summary` — aggregate statistics

## Development

```bash
./scripts/lint     # Format check + type check
./scripts/test     # Run tests
./scripts/build    # Compile binary + npm packages
./scripts/start    # Run the CLI
```
