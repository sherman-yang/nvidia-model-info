# Implementation

## Architecture

The project is a Node.js and Express server with a vanilla HTML, CSS, and JavaScript frontend.

- Backend entrypoint: [nvidia-model-server-info.js](nvidia-model-server-info.js)
- Frontend files: [public/index.html](public/index.html), [public/app.js](public/app.js), [public/styles.css](public/styles.css)
- Startup wrapper: [start.sh](start.sh)

## Backend Responsibilities

The backend:

- serves the static frontend
- reads the API key from `process.env.NVIDIA_API_KEY`
- fetches the NVIDIA model list
- fetches metadata for each model
- filters out rows that appear inactive, deprecated, retired, disabled, or otherwise unusable
- merges persisted live test results back into the row set
- exposes endpoints for loading models, testing one model, and clearing caches

## Data Loading Flow

1. `GET /api/models-with-metadata` calls NVIDIA `GET /v1/models`.
2. For each model, the server calls the per-model metadata endpoint.
3. Metadata is flattened into a single row object.
4. Active and usable rows are kept.
5. Cached live test results from `model_limits_cache.json` are merged into the matching rows.
6. The final response returns:
   - `columns`
   - `rows`
   - `fetchedAt`
   - `modelCount`
   - `totalModelCount`
   - `filteredOutCount`
   - `apiKeyConfigured`

## Flattened Row Model

Each row begins with stable fields such as:

- `liveTest`
- `modelId`
- `publisher`
- `contextLength`
- `maxOutputTokens`
- `latencyMs`
- `toolSupport`
- `testedAt`

All remaining metadata keys are flattened and appended as sortable columns.

`toolSupportChecked` is stored internally and persisted in cache, but hidden from the table.

## Live Test Flow

`GET /api/test-model?model=...` performs up to three probes:

1. Availability and latency probe
   - sends a minimal chat completion request
   - `200` means available
   - latency is measured client-side around that request
   - all probe requests pass through a shared rate limiter before the request is sent

2. Token limit probe
   - sends an oversized `max_tokens` request
   - parses NVIDIA response text for context limit and output limit values
   - if the model accepts the oversized value, the row falls back to `No Limit Reported`
   - if NVIDIA still returns `429`, the row falls back to `Rate Limited`

3. Tool support probe
   - tries several request variants in sequence:
     - forced `tool_choice`
     - `tool_choice: "auto"`
     - `tools` without `tool_choice`
     - legacy `functions` plus `function_call`
   - marks `toolSupport=true` only when the response actually includes tool calls
   - marks `toolSupport=false` only for explicit unsupported-tool errors
   - leaves `toolSupportChecked=false` if the probe is rate-limited, times out, or returns any other inconclusive error

The final result is written to `model_limits_cache.json` and the in-memory payload cache is invalidated.

## Cache Behavior

There are two cache layers:

- In-memory payload cache
  - stores the assembled model table for `CACHE_TTL_MS`
  - default TTL is 5 minutes
  - prevents repeated metadata reloads during normal browsing

- Persistent live test cache
  - file: `model_limits_cache.json`
  - stores per-model live probe results across page reloads and server restarts

`Force Refresh Data` clears both layers.

The backend also keeps a global probe pacing window for `/api/test-model` requests so repeated single-clicks or batch tests do not fire raw probe traffic straight through to NVIDIA at full speed.

## Frontend Responsibilities

The frontend:

- loads `/api/models-with-metadata`
- renders a wide sortable table
- applies search and checkbox filters
- runs single-row and batch live tests
- shows right-click usage snippets
- tracks UI-only state such as sort order, filter text, and batch progress

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
- The batch runner waits 8 seconds between models.
- If a row still lacks numeric token limits after a run, or the row is marked `Rate Limited`, it retries once after another 8 seconds.

### Tool Support Display

`Tool Support` is intentionally three-state in the UI:

- blank: not tested
- `true`: supported
- `false`: tested but not confirmed

Rows that hit NVIDIA rate limits show `Rate Limited` in the live probe output and remain retryable.

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

`.env` loading is intentionally not used.
