# NVIDIA Model Info Dashboard

Local dashboard for exploring the free models exposed through `build.nvidia.com`.

The app fetches the active model catalog, loads per-model metadata, flattens every metadata field into sortable table columns, and lets you probe live capabilities such as latency, context length, max output tokens, and tool calling support.

## Highlights

- Shows only models that appear active and usable.
- Fetches model metadata for every listed model and renders it as a sortable table.
- Keeps the most useful columns pinned on the left: `Live Ping`, `Model ID`, `Publisher`, `Context Limit`, `Max Output`, `Latency (ms)`, `Tool Support`, and `Tested At`.
- Supports global search, `Exclude Inactive/Error`, and `Tool Support` filtering.
- Probes live model behavior from the UI:
  - `Ping` re-tests one model.
  - `Test Displayed Models` tests displayed models that do not already have a complete live result.
  - `Shift + Click` on `Test Displayed Models` forces a full re-test of all displayed rows.
  - Backend probe requests are globally paced and automatically back off on `429 Too Many Requests`.
  - Tool support probing tries multiple request variants before giving up.
- Right-click any row to open copyable cURL, Python, and JavaScript API examples for that model.
- `Force Refresh Data` drops all saved test results, clears backend caches, and reloads the model list from NVIDIA with no cache reuse.

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
| Force Refresh Data | Clears all saved test data and backend cache, then fetches a fresh model list and metadata snapshot. |

## What The Live Test Actually Detects

Each live test can perform up to three NVIDIA API requests:

1. A small chat completion request to confirm availability and measure latency.
2. An oversized `max_tokens` request to infer `contextLength` and `maxOutputTokens` from the API response or error text.
3. A forced `tools` request to check whether the model returns tool calls.

`Tool Support` is intentionally three-state:

- blank: not tested yet
- `true`: tool calling was observed
- `false`: tool support probe completed and no tool call support was confirmed

If NVIDIA rate-limits a probe, the row shows `Rate Limited` instead of being cached as a normal failure. Inconclusive tool support probes stay blank so they can be retried later.

## Configuration

The runtime reads the API key only from `NVIDIA_API_KEY`. It does not use `.env`.

Optional backend environment variables:

- `PORT` default `4920`
- `MAX_CONCURRENCY` default `12`
- `REQUEST_TIMEOUT_MS` default `20000`
- `CACHE_TTL_MS` default `300000`
- `PROBE_RATE_LIMIT_RPM` default `36`
- `PROBE_MIN_INTERVAL_MS` default derived from `PROBE_RATE_LIMIT_RPM`
- `PROBE_TIMEOUT_MS` default `15000`
- `TOOL_SUPPORT_TIMEOUT_MS` default `25000`
- `PROBE_MAX_429_RETRIES` default `2`
- `PROBE_429_BACKOFF_MS` default `10000`

## Repository Docs

- [USAGE.md](USAGE.md)
- [REQUIREMENTS.md](REQUIREMENTS.md)
- [IMPLEMENTATION.md](IMPLEMENTATION.md)
- [TESTING.md](TESTING.md)
