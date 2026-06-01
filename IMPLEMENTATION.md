# Implementation

## Architecture

The project is a Node.js and Express server with a vanilla HTML, CSS, and JavaScript frontend.

- Backend entrypoint: [nvidia-model-server-info.js](nvidia-model-server-info.js)
- Model-card populate script: [populate_specs.js](populate_specs.js) (also exposed as `npm run populate-specs`)
- Persisted spec data: [model_specs.json](model_specs.json) — committed to the repo, read at runtime
- Frontend files: [public/index.html](public/index.html), [public/app.js](public/app.js), [public/styles.css](public/styles.css)
- Startup wrapper: [start.sh](start.sh)
- Model-card fetching design notes: [docs/MODEL_CARD_FETCH.md](docs/MODEL_CARD_FETCH.md)

## Backend Responsibilities

The backend:

- serves the static frontend
- reads the API key from `process.env.NVIDIA_API_KEY`
- fetches the NVIDIA model list
- fetches metadata for each model
- filters out rows that appear inactive, deprecated, retired, disabled, or otherwise unusable
- merges publisher-stated `contextLength`, `maxOutputTokens`, and plain `labels` from `model_specs.json` into matching rows
- merges persisted live test results back into the row set
- exposes endpoints for loading models, testing one model, populating specs from build.nvidia.com, and clearing caches

## Data Loading Flow

1. `GET /api/models-with-metadata` calls NVIDIA `GET /v1/models`.
2. The raw catalog is de-duplicated by `modelId`.
3. For each remaining model, the server calls the per-model metadata endpoint.
4. Metadata is flattened into a single row object.
5. The row set is de-duplicated again by `modelId` as a protective final pass.
6. Active and usable rows are kept.
7. Spec data from `model_specs.json` is injected into matching rows: `contextLength`, `maxOutputTokens`, and `labels` (plain tags only, colon-prefixed system labels are stripped at injection time).
8. Cached live test results from `model_limits_cache.json` are merged in. Spec values win over probed values — the probe cache only fills in gaps when the spec did not provide a number.
9. The final response returns:
   - `columns`
   - `rows`
   - `fetchedAt`
   - `modelCount`
   - `totalModelCount`
   - `filteredOutCount`
   - `duplicateModelCount`
   - `apiKeyConfigured`

`model_specs.json` is hot-reloaded on `mtime` change, so editing the file (or a `populate-specs` run) takes effect on the next list request without a server restart.

## Flattened Row Model

Each row begins with stable fields such as:

- `liveTest`
- `modelId`
- `publisher`
- `labels`
- `contextLength`
- `maxOutputTokens`
- `latencyMs`
- `toolSupport`
- `testedAt`

All remaining metadata keys are flattened and appended as sortable columns.

`toolSupportChecked`, `toolSupportReason`, `toolSupportSummary`, and `rateLimited` are stored internally and persisted in cache, but hidden from the table.

## Live Test Flow

`GET /api/test-model?model=...` performs up to three probes.

All probe requests are sent with `stream: true` and the Server-Sent-Events
response is consumed incrementally, with the streamed deltas aggregated back
into a normal chat-completion shape before classification. Because of this,
every per-attempt timeout below (`*_INITIAL_TIMEOUT_MS` / `*_FALLBACK_TIMEOUT_MS`)
is an **idle timeout** — the maximum time-to-first-byte and the maximum gap
between streamed chunks — rather than a total wall-clock budget. A slow but
steadily-streaming reasoning model therefore is not falsely timed out, while a
stalled connection still aborts promptly. `PROBE_STREAM_HARD_TIMEOUT_MS`
(`300000` by default) caps the total duration of any single streamed attempt so
a stream that trickles forever cannot hang a probe indefinitely. Error
responses (including `429`) arrive as ordinary JSON rather than SSE and are read
directly; if an endpoint ignores `stream: true` and returns a complete JSON
body, the consumer falls back to parsing it as a non-streaming completion.

1. Availability and latency probe
   - first sends a chat completion request without `max_tokens`
   - then steps through `AVAILABILITY_TOKEN_STEPS` (`4096,16384,65536,262144` by default) until the model is callable or a terminal failure is known
   - the ladder escalates from the no-`max_tokens` attempt to the first numeric step only to clear a "max_tokens is required" rejection; once a numeric budget has been sent and the attempt still returns a timeout, backend error, or request error, the probe stops early rather than climbing the rest of the ladder (a larger budget cannot help those and only makes timeouts more likely)
   - asks the model to reply with exactly `OK` so successful models should stop quickly even with the high token budget
   - no-`max_tokens`, `4096`, and `16384` attempts use `AVAILABILITY_INITIAL_TIMEOUT_MS` (`30000` by default) as the idle timeout
   - `65536` and `262144` attempts use `AVAILABILITY_FALLBACK_TIMEOUT_MS` (`120000` by default) as the idle timeout
   - `200` means HTTP-callable, but the backend also records whether the response was a normal final answer, length-limited, reasoning-only, or missing final content
   - latency is measured around all availability attempts for that model
   - all model-invocation probe requests pass through a shared rate limiter before the request is sent

2. Output-token limit probe
   - skipped entirely when `model_specs.json` already provides `maxOutputTokens` for this model
   - can run after an availability timeout, backend error, or other inconclusive availability result
   - skipped after terminal availability failures such as auth errors or explicit model-unavailable errors
   - first uses `OUTPUT_LIMIT_INITIAL_TIMEOUT_MS` (`30000` by default) as the idle timeout
   - retries once with `OUTPUT_LIMIT_FALLBACK_TIMEOUT_MS` (`120000` by default) as the idle timeout when the first output-limit attempt times out
   - sends an oversized `max_tokens` request and parses the resulting NVIDIA error for the limit
   - if the model accepts the oversized value, the visible value remains `Unknown` and the hidden status is `no_limit_reported`
   - if NVIDIA returns `429`, falls back to `Rate Limited`
   - writes hidden `maxOutputTokensSource`, `maxOutputTokensStatus`, and `maxOutputTokensSummary` fields for tooltips and diagnostics
   - `contextLength` is never probed live — it comes from `model_specs.json` only. If the spec is missing, the column shows `Not Tested`.

3. Tool support probe
   - tries several request variants in sequence:
     - `tools` without `tool_choice`
     - `tool_choice: "auto"`
     - forced `tool_choice`
     - legacy `functions` plus `function_call`
   - primary `tools` attempts use `TOOL_SUPPORT_TOKEN_BUDGETS` (`128,512,2048,8192` by default) followed by no `max_tokens`
   - secondary `tool_choice` attempts use `TOOL_SUPPORT_SECONDARY_TOKEN_BUDGETS` (`512,2048` by default) followed by no `max_tokens`
   - legacy `functions` attempts use `TOOL_SUPPORT_LEGACY_TOKEN_BUDGETS` (`512` by default) followed by no `max_tokens`
   - each attempt starts with `TOOL_SUPPORT_INITIAL_TIMEOUT_MS` (`30000` by default) as the idle timeout
   - the same budget is retried once with `TOOL_SUPPORT_FALLBACK_TIMEOUT_MS` (`120000` by default) as the idle timeout only when that attempt times out
   - the entire tool probe is capped by `TOOL_SUPPORT_MAX_ATTEMPTS` (`8` by default)
   - only runs after the availability probe confirms the model accepts a chat completion request
   - early-stops on confirmed support, rate limits, backend errors, fallback timeout, or the max-attempt cap
   - continues to the next request variant after explicit unsupported-tool errors
   - increases token budgets after accepted responses without tool calls, including `finish_reason="length"`
   - marks `toolSupport=true` only when the response actually includes tool calls
   - marks `toolSupport=false` only when all attempted variants provide explicit unsupported-tool evidence
   - leaves `toolSupportChecked=false` if the probe is rate-limited, times out, or returns any other inconclusive error

The final result is written to `model_limits_cache.json` and the in-memory payload cache is invalidated.

## Persistent Files And Caches

There are three layers of persisted state:

- In-memory payload cache
  - stores the assembled model table for `CACHE_TTL_MS`
  - default TTL is 5 minutes
  - prevents repeated metadata reloads during normal browsing

- Persistent live test cache
  - file: `model_limits_cache.json` (gitignored)
  - stores per-model live probe results across page reloads and server restarts
  - each entry includes `probeSchemaVersion` and a probe configuration snapshot
  - stale entries from older schema/config combinations are ignored instead of merged into current rows

- Persistent spec data
  - file: `model_specs.json` (committed to the repo)
  - publisher-stated `contextLength`, `maxOutputTokens`, `labels`, and other extracted fields
  - regenerated by `Force Refresh Data` or `npm run populate-specs`
  - hot-reloaded on file `mtime` change

`Force Refresh Data` clears the in-memory and probe caches and rewrites `model_specs.json` from a fresh fetch of the build.nvidia.com catalog.

The backend also keeps a global probe pacing window for `/api/test-model` requests so repeated single-clicks or batch tests do not fire raw probe traffic straight through to NVIDIA at full speed.

## Populate Flow

`POST /api/populate-specs` is fire-and-forget. The handler:

1. Returns `202 Accepted` immediately with the initial state.
2. In the background, calls the public NGC catalog API:
   - `GET /v2/search/catalog/resources/ENDPOINT` filtered to `orgName=qc69jvmznzxy` to enumerate every endpoint visible at build.nvidia.com.
   - `GET /v2/endpoints/qc69jvmznzxy/{name}` for each endpoint to retrieve the full markdown body.
3. Runs a regex waterfall over each `description` to extract `contextLength`, `parameters`, `useCase`, `license`, `huggingfaceUrl`, and other fields.
4. Writes the result to `model_specs.json`, drops the in-memory specs cache, and invalidates the assembled-table cache.

`GET /api/populate-specs/status` returns the shared progress state: `status`, `total`, `completed`, `contextHits`, `failed`, `skipped404`, `currentLabel`, `startedAt`, `finishedAt`, `error`. The frontend polls this every 600 ms while a populate is running.

`GET /api/specs-meta` returns `{ exists, entries, withContext, lastFetchedAt }`. The frontend uses it on first load to decide whether to auto-trigger Force Refresh Data so the user lands on a populated table without clicking anything.

See [docs/MODEL_CARD_FETCH.md](docs/MODEL_CARD_FETCH.md) for the full design, slug-mapping quirks, the regex pattern set, and known gotchas (for example, NVIDIA-developed and gated-on-HuggingFace models, and how the API description can diverge from the rendered build.nvidia.com page).

## Frontend Responsibilities

The frontend:

- on first load, calls `/api/specs-meta`. If `entries === 0`, fires the same handler as `Force Refresh Data` instead of loading half a table, then applies the default `agentic` search filter.
- loads `/api/models-with-metadata`
- renders a wide sortable table
- applies search and checkbox filters
- runs single-row and batch live tests
- shows right-click usage snippets
- tracks UI-only state such as sort order, filter text, and batch progress
- shares one progress bar between batch testing and populate; the bar is hidden by default via a CSS `[hidden]` rule that overrides `display: flex`

## Frontend Behavior

### Filtering

- Search defaults to `agentic` after startup data loading. It splits the input on whitespace and applies OR semantics: a row matches when any term appears as a substring in any displayed cell. Empty input keeps every row.
- `Exclude Inactive/Error` hides rows whose live result is `Error` or `Inactive`.
- `Tool Support` hides every row except those with `toolSupport === true`.

### Batch Testing

- Default batch mode tests displayed rows that are still missing a complete live result.
- A row is considered complete only when it has:
  - a measured latency string
  - numeric `contextLength`
  - numeric `maxOutputTokens`
  - `toolSupportChecked === true`
- `Shift + Click` forces re-testing of every displayed row.
- The batch runner does not insert any artificial delay between models — pacing is handled by the backend's global model-probe rate limiter (`PROBE_RATE_LIMIT_RPM`, default 39 RPM, with at least a 1550 ms minimum gap between any two outgoing `/v1/chat/completions` probe requests).
- The limiter is intentionally fixed-spacing. Do not replace it with token-bucket behavior; staying strictly below 40 RPM is required.
- If a row still lacks numeric token limits after a run, or the row is marked `Rate Limited`, it is retried once back-to-back. The rate limiter ensures the retry's first probe also waits its turn.

### Tool Support Display

`Tool Support` is intentionally three-state in the UI:

- blank: not tested
- `true`: supported
- `false`: explicitly unsupported by all attempted request variants

Rows that hit NVIDIA rate limits show `Rate Limited` in the live probe output and remain retryable. The `Tool Support` cell title carries `toolSupportReason` and `toolSupportSummary` so false or inconclusive results can be inspected without adding another visible column.

### Usage Popover

The right-click popover renders three things, in order:

1. A clickable link to the model's `build.nvidia.com` model card (opens in a new tab).
2. The publisher's stated use case (`useCase`) parsed from the model card and stored in `model_specs.json`. Hidden when no use case is available.
3. A copyable cURL snippet for `https://integrate.api.nvidia.com/v1/chat/completions`. The snippet references `NVIDIA_API_KEY` and uses `max_tokens = min(spec maxOutputTokens, 512)`.

`useCase` is added to the row by `loadModelsWithMetadata` but kept out of the table by adding it to the `hiddenFields` set in `buildColumns`.

## Startup Flow

[start.sh](start.sh) is the intended entrypoint.

It:

- checks that `node` and `npm` exist
- requires `NVIDIA_API_KEY`
- runs `npm install`
- refuses to kill unknown processes on the target port
- starts the server with `npm start`

When the server starts, it tries to open the dashboard URL in the default browser through the host OS.

## Runtime Configuration

Supported environment variables:

- `NVIDIA_API_KEY`
- `PORT`
- `MAX_CONCURRENCY`
- `REQUEST_TIMEOUT_MS`
- `CACHE_TTL_MS`
- `PROBE_RATE_LIMIT_RPM`
- `PROBE_MIN_INTERVAL_MS`
- `PROBE_TIMEOUT_MS`
- `PROBE_STREAM_HARD_TIMEOUT_MS`
- `AVAILABILITY_PROBE_MAX_TOKENS`
- `AVAILABILITY_TOKEN_STEPS`
- `AVAILABILITY_INITIAL_TIMEOUT_MS`
- `AVAILABILITY_FALLBACK_TIMEOUT_MS`
- `OUTPUT_LIMIT_MAX_TOKENS`
- `OUTPUT_LIMIT_INITIAL_TIMEOUT_MS`
- `OUTPUT_LIMIT_FALLBACK_TIMEOUT_MS`
- `TOOL_SUPPORT_TOKEN_BUDGETS`
- `TOOL_SUPPORT_SECONDARY_TOKEN_BUDGETS`
- `TOOL_SUPPORT_LEGACY_TOKEN_BUDGETS`
- `TOOL_SUPPORT_MAX_ATTEMPTS`
- `TOOL_SUPPORT_INITIAL_TIMEOUT_MS`
- `TOOL_SUPPORT_FALLBACK_TIMEOUT_MS`
- `PROBE_MAX_429_RETRIES`
- `PROBE_429_BACKOFF_MS`
- `POPULATE_CONCURRENCY`
- `POPULATE_TIMEOUT_MS`
- `NGC_BASE`
- `BUILD_ORG`
- `PROBE_TRACE` — set to `1` to log every NVIDIA probe with timestamp, purpose, and model id; off by default.

`.env` loading is intentionally not used.
