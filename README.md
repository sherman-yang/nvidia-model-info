# NVIDIA Model Info Dashboard

Local dashboard for exploring the free models exposed through `build.nvidia.com`.

The app fetches the active model catalog, pulls each endpoint's model card from the public NGC catalog API to populate `Context Limit` and `Labels`, flattens every metadata field into sortable table columns, and lets you probe live capabilities such as latency, max output tokens, and tool calling support.

## Highlights

- Shows only models that appear active and usable.
- Removes duplicate model IDs before metadata loading and rendering.
- Fetches model metadata for every listed model and renders it as a sortable table.
- Keeps the most useful columns pinned on the left: `Live Ping`, `Model ID`, `Publisher`, `Labels`, `Context Limit`, `Max Output`, `Latency (ms)`, `Tool Support`, and `Tested At`.
- `Context Limit` and `Labels` are read from `model_specs.json`, populated from `build.nvidia.com` model cards via the public NGC catalog API. See [docs/MODEL_CARD_FETCH.md](docs/MODEL_CARD_FETCH.md).
- Supports global search, `Exclude Inactive/Error`, and `Tool Support` filtering.
- Probes live model behavior from the UI:
  - `Ping` re-tests one model.
  - `Test Displayed Models` tests displayed models that do not already have a complete live result.
  - `Shift + Click` on `Test Displayed Models` forces a full re-test of all displayed rows.
  - Backend probe requests are globally paced and automatically back off on `429 Too Many Requests`.
  - Tool support probing tries multiple request variants, classifies explicit unsupported-tool responses, and retries accepted-but-truncated responses with a larger completion budget before giving up.
- Right-click any row to open a copyable cURL API example for that model.
- On first load, when `model_specs.json` is empty, the dashboard automatically runs `Force Refresh Data` so the user lands on a fully populated table.
- `Force Refresh Data` drops all saved test results, clears backend caches, reloads the model list from NVIDIA, and re-pulls every model card from `build.nvidia.com`.

## Quick Start

1. Install [Node.js](https://nodejs.org/) 18 or later.
2. Export your NVIDIA key in the shell:

```bash
export NVIDIA_API_KEY="your_nvidia_api_key"
```

3. Start the app:

```bash
./start.sh
```

4. The server starts on `http://localhost:4920` by default and attempts to open the dashboard in your default browser.

## Main Controls

| Control | Behavior |
| --- | --- |
| Search | Filters rows by substring match across all visible values. |
| Exclude Inactive/Error | Hides rows whose live test state is `Error` or `Inactive`. |
| Tool Support | Shows only rows that have been tested and confirmed to support tool calling. |
| Ping | Re-tests one model and updates cached results. |
| Test Displayed Models | Tests displayed models that are still missing a complete live test result. |
| Shift + Click on Test Displayed Models | Forces a re-test of every displayed row. |
| Stop Testing | Cancels the running batch test. |
| Force Refresh Data | Clears all saved test data and backend cache, fetches a fresh model list, and re-pulls every model card from `build.nvidia.com`. Reloads the page when done. |

## What The Live Test Actually Detects

Each live test can perform up to three NVIDIA API requests:

1. A small chat completion request to confirm availability and measure latency.
2. An oversized `max_tokens` probe to detect the output-token limit. Skipped when `model_specs.json` already provides `maxOutputTokens` for this model. `Context Limit` is never probed live — it always comes from `model_specs.json`.
3. An adaptive tool-calling probe that tries multiple compatible request shapes and can retry truncated accepted responses with a larger `max_tokens` value.

`Tool Support` is intentionally three-state:

- blank: not tested yet
- `true`: tool calling was observed
- `false`: the probe completed and concluded either that tool fields are explicitly unsupported or that accepted requests still never emitted tool calls

If NVIDIA rate-limits a probe, the row shows `Rate Limited` instead of being cached as a normal failure. Inconclusive tool support probes stay blank so they can be retried later. Hover the `Tool Support` cell to inspect the saved reason summary for `false` or inconclusive rows.

The right-click popover intentionally keeps only the hosted OpenAI-compatible cURL example. On `2026-04-14`, `https://integrate.api.nvidia.com/v1/messages` returned `404`, so the hosted endpoint used by this dashboard does not currently expose the Anthropic-compatible path that Claude Code requires.

## Configuration

The runtime reads the API key only from `NVIDIA_API_KEY`. It does not use `.env`.

Optional backend environment variables:

- `PORT` default `4920`
- `MAX_CONCURRENCY` default `12`
- `REQUEST_TIMEOUT_MS` default `20000`
- `CACHE_TTL_MS` default `300000`
- `PROBE_RATE_LIMIT_RPM` default `40` — the only knob that controls the rate of NVIDIA probes. `60000 / value` is the minimum gap between any two outgoing requests. NVIDIA's free-tier cap is 40 RPM; matching it gives full throughput. Lower it if you start seeing 429s.
- `PROBE_MIN_INTERVAL_MS` default derived from `PROBE_RATE_LIMIT_RPM` (= `1500ms` at 40 RPM)
- `PROBE_TIMEOUT_MS` default `15000`
- `TOOL_SUPPORT_TIMEOUT_MS` default `25000`
- `PROBE_MAX_429_RETRIES` default `2`
- `PROBE_429_BACKOFF_MS` default `10000`
- `POPULATE_CONCURRENCY` default `6` — concurrent model-card fetches during populate
- `POPULATE_TIMEOUT_MS` default `20000` — per-request timeout for populate fetches
- `NGC_BASE` default `https://api.ngc.nvidia.com/v2` — base URL for the NGC catalog API
- `BUILD_ORG` default `qc69jvmznzxy` — orgName for the build.nvidia.com tenant
- `PROBE_TRACE` set to `1` to log a `[probe-trace <ISO>] <purpose> → <modelId>` line for every NVIDIA probe. Useful for verifying the rate-limit pacing.

## CLI

- `npm start` — launch the dashboard server.
- `npm run check` — syntax-check the server and frontend JavaScript.
- `npm run populate-specs` — re-pull every model card from build.nvidia.com and rewrite `model_specs.json`. Same effect as the in-app `Force Refresh Data`, useful in CI / cron / one-off workflows.

## Repository Docs

- [USAGE.md](USAGE.md)
- [REQUIREMENTS.md](REQUIREMENTS.md)
- [IMPLEMENTATION.md](IMPLEMENTATION.md)
- [TESTING.md](TESTING.md)
- [docs/MODEL_CARD_FETCH.md](docs/MODEL_CARD_FETCH.md)
