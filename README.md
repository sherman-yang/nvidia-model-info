# NVIDIA Model Info Dashboard

A local web dashboard for the free NVIDIA NIM models exposed at
[build.nvidia.com](https://build.nvidia.com).

It pulls the live model catalog from NVIDIA's API, enriches every entry with
the publisher-stated `Context Limit` and `Labels` parsed from each model card,
and lets you live-probe latency, output-token limits, and tool-calling support
from the UI — all paced by a single global rate limiter that holds at exactly
NVIDIA's 40 RPM free-tier cap.

## Features

- **Full catalog** — fetches `/v1/models`, flattens metadata into a sortable
  table, removes duplicates, hides retired or disabled rows.
- **Pinned columns** — `Live Ping`, `Model ID`, `Publisher`, `Labels`,
  `Context Limit`, `Max Output`, `Latency (ms)`, `Tool Support`, `Tested At`.
- **Search & filter** — substring search across every cell with OR semantics
  (space-separated terms; a row matches when any term appears in any column),
  plus checkboxes for "Exclude Inactive/Error" and "Tool Support only".
- **Live probing** — `Ping` per row or `Test Displayed Models` for a batch.
  Probes detect availability + latency, the output-token limit, and tool
  calling support (multiple request shapes, with retry on length-cutoff).
- **Single 40 RPM rate limiter** — every NVIDIA call goes through one global
  reservation gate (`60000 / PROBE_RATE_LIMIT_RPM` ms minimum gap). 132-model
  full-batch run: 496 probes, peak 60-second window = 40 (= cap), zero
  violations. See [TESTING.md](TESTING.md) for the methodology.
- **Model-card backed specs** — `Context Limit`, `Labels`, and the right-click
  popover's `Use case` come from
  [`model_specs.json`](model_specs.json), regenerated from the public NGC
  catalog API. See [docs/MODEL_CARD_FETCH.md](docs/MODEL_CARD_FETCH.md).
- **First-run automation** — when `model_specs.json` is empty, the dashboard
  fires `Force Refresh Data` automatically so the user lands on a populated
  table with no clicks.
- **Right-click usage examples** — copyable cURL snippet, link to the
  build.nvidia.com model card, and the publisher's stated use case.
- **Honest no-key fallback** — without `NVIDIA_API_KEY` the dashboard still
  loads the catalog and model cards (NGC is unauthenticated), but Live Ping /
  Test Displayed Models are disabled and an in-page banner tells the user how
  to set the key.

## Quick start

```bash
# 1. Install Node.js 18+
node --version

# 2. Get an API key from build.nvidia.com → "Get API Key"
export NVIDIA_API_KEY="nvapi-..."

# 3. Run
git clone <this-repo>
cd nvidia-model-info
./start.sh
```

The server listens on `http://localhost:4920` and tries to open it in your
default browser. On the very first launch the dashboard auto-populates
`model_specs.json` from build.nvidia.com (~30 s) before applying the default
`agentic` search filter.

## Controls

| Control | Behavior |
| --- | --- |
| Search | Defaults to `agentic` after startup data loading. Substring match across every visible cell. |
| Exclude Inactive/Error | Hides rows whose live test state is `Error` or `Inactive`. |
| Tool Support | Keeps only rows confirmed to return tool calls. |
| Ping / Re-test | Single-row live probe. Disabled without an API key. |
| Test Displayed Models | Batch-tests displayed rows missing a complete result. Disabled without an API key. |
| Shift + Click on Test Displayed Models | Force re-test every displayed row. |
| Stop Testing | Cancels the running batch test. |
| Force Refresh Data | Resets the probe cache, reloads `/v1/models`, re-pulls every model card from build.nvidia.com, then reloads the table. Always works (no API key needed). |

## What a live test actually does

`GET /api/test-model?model=<id>` performs up to three sequential probes:

1. **Availability + latency** — minimal `chat/completions` call, status 200
   means the model is up. Latency measured server-side.
2. **Output-token limit** — sends `max_tokens: 99999999` and parses the
   resulting error for the cap. Skipped when `model_specs.json` already
   supplies `maxOutputTokens`. `Context Limit` is never probed live; it comes
   from `model_specs.json` only.
3. **Tool support** — tries `tools` only, `tool_choice: "auto"`, forced
   `tool_choice`, and legacy `functions`/`function_call` in turn. Marks
   `true` only when a tool call is observed; marks `false` only on explicit
   unsupported errors or when accepted requests never emit a tool call (with
   one length-cutoff retry). Stays blank on rate-limit / timeout / server
   error so the row remains retryable.

The single global rate limiter holds the gap between any two outgoing probes
to ≥ `60000 / PROBE_RATE_LIMIT_RPM` ms (1500 ms at the default 40 RPM). On
`429 Too Many Requests` it honors NVIDIA's `Retry-After`, otherwise applies an
exponential 10s/20s/40s backoff. The backoff also shifts the global slot, so
every queued probe pauses together.

## Architecture

```
┌──────────────────────────┐    ┌────────────────────────────┐
│  Browser (public/app.js) │◀──▶│  Express server            │
│  - sortable table        │    │  (nvidia-model-server-info)│
│  - search & filters      │    │  - /api/models-with-meta   │
│  - right-click popover   │    │  - /api/test-model         │
│  - batch test runner     │    │  - /api/populate-specs     │
└──────────────────────────┘    │  - reserveProbeSlot ↓      │
                                └────┬───────────────────────┘
                                     │ ≤40 RPM (1500ms gap)
                                     ▼
                  ┌─────────────────────────────────────┐
                  │  NVIDIA Integrate API               │
                  │  - /v1/models   (no auth)           │
                  │  - /v1/chat/completions  (auth req) │
                  └─────────────────────────────────────┘

                  ┌─────────────────────────────────────┐
                  │  NGC Catalog API (no auth)          │
                  │  - /v2/search/catalog/resources/    │
                  │    ENDPOINT                         │
                  │  - /v2/endpoints/{org}/{name}       │
                  └─────────────────────────────────────┘
```

`model_specs.json` is the persisted output of populating from the NGC catalog
and is committed to the repo.

## Configuration

The API key is read **only** from the `NVIDIA_API_KEY` environment variable.
`.env` files are intentionally not loaded — keep secrets in your shell.

| Variable | Default | Notes |
| --- | --- | --- |
| `NVIDIA_API_KEY` | _(required for live probes)_ | Without it, catalog + populate still work; live probing is disabled. |
| `PORT` | `4920` | |
| `MAX_CONCURRENCY` | `12` | Parallel metadata fetches when loading the catalog. |
| `REQUEST_TIMEOUT_MS` | `20000` | Generic HTTP timeout. |
| `CACHE_TTL_MS` | `300000` | In-memory model-table cache TTL. |
| `PROBE_RATE_LIMIT_RPM` | `40` | The single rate-limit knob. `60000 / value` is the minimum gap between any two NVIDIA probes. Lower it only if you see 429s. |
| `PROBE_MIN_INTERVAL_MS` | derived | Override the gap directly if you need to. |
| `PROBE_TIMEOUT_MS` | `15000` | Per-probe timeout. |
| `TOOL_SUPPORT_TIMEOUT_MS` | `25000` | Per tool-support probe timeout. |
| `PROBE_MAX_429_RETRIES` | `2` | In-place retries on 429. |
| `PROBE_429_BACKOFF_MS` | `10000` | Base backoff (doubled per retry, overridden by `Retry-After`). |
| `POPULATE_CONCURRENCY` | `6` | Concurrent model-card fetches during populate. |
| `POPULATE_TIMEOUT_MS` | `20000` | Per-request timeout for populate fetches. |
| `NGC_BASE` | `https://api.ngc.nvidia.com/v2` | NGC catalog API base. |
| `BUILD_ORG` | `qc69jvmznzxy` | orgName for the build.nvidia.com tenant. |
| `PROBE_TRACE` | _(off)_ | Set to `1` to log every probe with a timestamp; used for verifying rate-limit pacing. |

## CLI

```bash
npm start               # launch the dashboard server
npm run check           # syntax-check server and frontend JavaScript
npm run populate-specs  # rebuild model_specs.json from build.nvidia.com
```

`populate-specs` does the same thing as the in-app `Force Refresh Data`
button. Useful in CI, cron, or for headless environments.

## Documentation

- [USAGE.md](USAGE.md) — user guide.
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — architecture, data flow, file map.
- [REQUIREMENTS.md](REQUIREMENTS.md) — functional and technical requirements.
- [TESTING.md](TESTING.md) — manual test plan, including rate-limit verification.
- [docs/MODEL_CARD_FETCH.md](docs/MODEL_CARD_FETCH.md) — how `model_specs.json`
  is generated, the NGC catalog API endpoints used, slug-mapping quirks, and
  the regex pattern set with worked examples.

## License

MIT. See [package.json](package.json).
