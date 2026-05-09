# NVIDIA Model Info Dashboard

A local web dashboard for browsing the free NVIDIA models listed on
[build.nvidia.com](https://build.nvidia.com), with sortable metadata, model-card
specs, live API probes, tool-calling detection, and copyable cURL examples.

The app is built for repeated model comparison work: dense table layout,
default `agentic` filtering, pinned high-value columns, explicit rate limiting,
and refresh behavior that rebuilds local model-card data from NVIDIA sources.

## What It Shows

- Active and usable NVIDIA model IDs from `/v1/models`
- Flattened model metadata as sortable and searchable table columns
- Publisher labels from model cards, such as `agentic`, `coding`, `MoE`, and `Tool Use`
- Publisher-stated `Context Limit` from `model_specs.json`
- Live probe results for availability, latency, max output tokens, and tool support
- Right-click cURL examples for the selected model
- Duplicate model IDs removed before rendering

## Quick Start

Requirements:

- Node.js 18 or newer
- A NVIDIA API key from build.nvidia.com for live probes

```bash
git clone https://github.com/sherman-yang/nvidia-model-info.git
cd nvidia-model-info
export NVIDIA_API_KEY="nvapi-..."
./start.sh
```

The server listens on `http://localhost:4920` and attempts to open the
dashboard in your default browser.

If `model_specs.json` is missing or empty on first launch, the dashboard
automatically runs the same flow as `Force Refresh Data`: it clears local probe
state, loads the model catalog, fetches model-card specs, rebuilds
`model_specs.json`, reloads the table, and then applies the default `agentic`
search filter.

## Main Controls

| Control | Behavior |
| --- | --- |
| Search | Defaults to `agentic` after startup data loading. Space-separated terms use OR matching across displayed cells. |
| Exclude Inactive/Error | Hides rows whose live probe state is `Error` or `Inactive`. |
| Tool Support | Shows only rows confirmed to return tool calls. |
| Ping / Re-test | Runs a live probe for one row. Requires `NVIDIA_API_KEY`. |
| Test Displayed Models | Batch-tests displayed rows that are missing complete live probe data. Requires `NVIDIA_API_KEY`. |
| Shift + Click on Test Displayed Models | Forces a re-test of every displayed row. |
| Force Refresh Data | Clears probe cache, reloads `/v1/models`, re-pulls model cards, rebuilds `model_specs.json`, and reloads table data. |

## Data Sources

The dashboard combines two NVIDIA sources:

| Source | Used For |
| --- | --- |
| `https://integrate.api.nvidia.com/v1/models` | Model IDs and basic model metadata |
| `https://api.ngc.nvidia.com/v2` catalog endpoints | Model-card labels, context limits, use cases, and model page links |

`model_specs.json` is generated from the public NGC catalog API and committed to
the repository so the table can show model-card specs immediately after startup.
Use `Force Refresh Data` or `npm run populate-specs` to rebuild it from current
NVIDIA model cards.

## Live Probe Behavior

`GET /api/test-model?model=<id>` performs up to three sequential checks:

1. Availability and latency using a minimal `chat/completions` call.
2. Max output token detection using an oversized `max_tokens` request when
   `model_specs.json` does not already provide the value.
3. Tool-calling detection using several OpenAI-compatible request shapes:
   `tools`, `tool_choice: "auto"`, forced `tool_choice`, and legacy
   `functions` / `function_call`.

`Context Limit` is not guessed from max output. It comes from model-card specs
or remains unknown. This avoids showing a completion-token cap as if it were the
model's full context window.

## Rate Limiting

All outgoing NVIDIA probe calls pass through one global pacing gate.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROBE_RATE_LIMIT_RPM` | `40` | Main rate-limit knob |
| `PROBE_MIN_INTERVAL_MS` | derived | Minimum delay between any two probe calls |
| `PROBE_MAX_429_RETRIES` | `2` | Retries after `429 Too Many Requests` |
| `PROBE_429_BACKOFF_MS` | `10000` | Base exponential backoff when no `Retry-After` header exists |

Rows that hit rate limits stay retryable instead of being cached as normal
failures.

## Configuration

The API key is read only from `NVIDIA_API_KEY`. The app intentionally does not
load `.env` files.

| Variable | Default | Notes |
| --- | --- | --- |
| `NVIDIA_API_KEY` | optional for catalog, required for live probes | Enables `Ping` and batch testing |
| `PORT` | `4920` | Server port |
| `MAX_CONCURRENCY` | `12` | Parallel metadata fetches |
| `REQUEST_TIMEOUT_MS` | `20000` | Generic HTTP timeout |
| `CACHE_TTL_MS` | `300000` | In-memory table cache TTL |
| `TOOL_SUPPORT_TIMEOUT_MS` | `25000` | Tool probe timeout |
| `POPULATE_CONCURRENCY` | `6` | Concurrent model-card fetches |
| `POPULATE_TIMEOUT_MS` | `20000` | Per model-card request timeout |
| `NGC_BASE` | `https://api.ngc.nvidia.com/v2` | NGC catalog API base |

## Commands

```bash
npm start               # start the server
npm run check           # syntax-check backend and frontend JavaScript
npm run populate-specs  # rebuild model_specs.json from NVIDIA model cards
```

## Repository Layout

| Path | Purpose |
| --- | --- |
| `nvidia-model-server-info.js` | Express server, NVIDIA API calls, live probes, cache handling |
| `public/app.js` | Browser UI, table rendering, filters, batch testing |
| `populate_specs.js` | CLI model-card fetcher for `model_specs.json` |
| `model_specs.json` | Persisted model-card specs used by the dashboard |
| `docs/MODEL_CARD_FETCH.md` | Details for the model-card fetch pipeline |

## Known Boundaries

- Claude Code commands are not shown because the hosted
  `integrate.api.nvidia.com` endpoint currently exposes `chat/completions`, not
  Anthropic-compatible `/v1/messages`.
- Context length is shown only when model-card specs or explicit metadata
  provide it. The app does not infer context length from output-token errors.
- Large batch tests can take time because all probe calls are paced to respect
  NVIDIA's free-tier request limits.

## Documentation

- [USAGE.md](USAGE.md)
- [IMPLEMENTATION.md](IMPLEMENTATION.md)
- [REQUIREMENTS.md](REQUIREMENTS.md)
- [TESTING.md](TESTING.md)
- [docs/MODEL_CARD_FETCH.md](docs/MODEL_CARD_FETCH.md)

## License

MIT. See [package.json](package.json).
