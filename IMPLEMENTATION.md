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

`GET /api/test-model?model=...` performs up to three probes:

1. Availability and latency probe
   - sends a minimal chat completion request
   - `200` means available
   - latency is measured client-side around that request
   - all probe requests pass through a shared rate limiter before the request is sent

2. Output-token limit probe
   - skipped entirely when `model_specs.json` already provides `maxOutputTokens` for this model
   - sends an oversized `max_tokens` request and parses the resulting NVIDIA error for the limit
   - if the model accepts the oversized value, falls back to `No Limit Reported`
   - if NVIDIA returns `429`, falls back to `Rate Limited`
   - `contextLength` is never probed live — it comes from `model_specs.json` only. If the spec is missing, the column shows `Not Tested`.

3. Tool support probe
   - tries several request variants in sequence:
     - `tools` without `tool_choice`
     - `tool_choice: "auto"`
     - forced `tool_choice`
     - legacy `functions` plus `function_call`
   - starts with a small `max_tokens` budget and retries the same accepted request once with a larger budget when the response stops with `finish_reason="length"` before producing tool calls
   - marks `toolSupport=true` only when the response actually includes tool calls
   - marks `toolSupport=false` only when the probe ends with explicit unsupported-tool evidence or when accepted requests still fail to emit tool calls after the retry path
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

- on first load, calls `/api/specs-meta`. If `entries === 0`, fires the same handler as `Force Refresh Data` instead of loading half a table.
- loads `/api/models-with-metadata`
- renders a wide sortable table
- applies search and checkbox filters
- runs single-row and batch live tests
- shows right-click usage snippets
- tracks UI-only state such as sort order, filter text, and batch progress
- shares one progress bar between batch testing and populate; the bar is hidden by default via a CSS `[hidden]` rule that overrides `display: flex`

## Frontend Behavior

### Filtering

- Search applies a substring match across all displayed row values.
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
- The batch runner does not insert any artificial delay between models — pacing is handled by the backend's global probe rate limiter (`PROBE_RATE_LIMIT_RPM`, default 40 RPM = 1500 ms minimum gap between any two outgoing NVIDIA requests).
- If a row still lacks numeric token limits after a run, or the row is marked `Rate Limited`, it is retried once back-to-back. The rate limiter ensures the retry's first probe also waits its turn.

### Tool Support Display

`Tool Support` is intentionally three-state in the UI:

- blank: not tested
- `true`: supported
- `false`: explicitly unsupported or accepted but still no tool call observed

Rows that hit NVIDIA rate limits show `Rate Limited` in the live probe output and remain retryable. The `Tool Support` cell title carries `toolSupportReason` and `toolSupportSummary` so false or inconclusive results can be inspected without adding another visible column.

### Usage Popover

The right-click popover keeps only the hosted cURL example for `https://integrate.api.nvidia.com/v1/chat/completions`.

It intentionally omits a Claude Code command because the hosted endpoint used by this dashboard did not expose `/v1/messages` when verified on `2026-04-14`. Claude Code requires an Anthropic-compatible `/v1/messages` backend, so showing that command here would be misleading.

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
- `TOOL_SUPPORT_TIMEOUT_MS`
- `PROBE_MAX_429_RETRIES`
- `PROBE_429_BACKOFF_MS`
- `POPULATE_CONCURRENCY`
- `POPULATE_TIMEOUT_MS`
- `NGC_BASE`
- `BUILD_ORG`
- `PROBE_TRACE` — set to `1` to log every NVIDIA probe with timestamp, purpose, and model id; off by default.

`.env` loading is intentionally not used.
