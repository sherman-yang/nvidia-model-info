# Testing

## Environment Setup

1. Install Node.js 18 or later.
2. Export a valid NVIDIA API key:

```bash
export NVIDIA_API_KEY="your_actual_key"
```

3. Start the app with:

```bash
./start.sh
```

## Manual Test Checklist

### Initial Load

- Verify the dashboard loads on `http://localhost:4920` unless `PORT` is overridden.
- Verify only active and usable models are shown.
- Verify repeated `Model ID` values are not rendered as duplicate rows.
- Verify the table contains flattened metadata columns in addition to the pinned columns.
- Verify the pinned columns include `Labels` between `Publisher` and `Context Limit`.

### First-Time Setup (Empty model_specs.json)

- With the server stopped, replace `model_specs.json` with `{}` (or delete it).
- Start the server and open the dashboard.
- Verify the status bar reads `First-time setup: loading model list and refreshing model cards from build.nvidia.com…`.
- Verify the progress bar shows `Refreshing model cards: N/M (…%, context found: K) — <publisher>/<model>` and updates as work proceeds.
- Verify rows have `Context Limit` and `Labels` populated where the publisher's card supplies them after populate finishes.
- Verify the search box is populated with `agentic` only after the first-time refresh finishes.

### Sorting And Filtering

- Verify the search box defaults to `agentic`.
- Type `llama` in the search box and verify the table filters immediately.
- Type `MoE` or `coding` in the search box and verify only rows whose displayed cells contain that term remain.
- Type `agentic moe coding` (space-separated). Verify the table now contains rows with any of those labels (OR semantics across terms), not the empty intersection.
- Toggle `Exclude Inactive/Error` and verify rows with `Error` or `Inactive` live results disappear.
- Toggle `Tool Support` and verify only rows with `Tool Support = true` remain visible.
- Click `Model ID`, `Labels`, `Context Limit`, and `Tool Support` headers and verify sorting changes direction on repeated clicks.

### Single-Row Testing

- Click `Ping` on an untested row.
- Verify the row clears immediately into a testing state.
- Verify latency, max output, and tested timestamp are updated after the request.
- Run with `PROBE_TRACE=1` and verify the availability probe logs
  `Availability initial (262144 max_tokens, 30000ms timeout)` unless the
  availability environment variables are overridden.
- For a model that rejects 256K as above its output cap, verify the backend
  retries once with the parsed cap and the 120-second fallback timeout instead
  of immediately marking the row inactive.
- For a slow reasoning model, verify the availability probe uses
  `AVAILABILITY_FALLBACK_TIMEOUT_MS` after the first 30-second timeout.
- Verify live probe responses include hidden `availabilityStatus` and
  `availabilitySummary` fields, and that the live cell tooltip shows them.
- Verify output-limit probes use `OUTPUT_LIMIT_INITIAL_TIMEOUT_MS=30000` and
  `OUTPUT_LIMIT_FALLBACK_TIMEOUT_MS=120000` on timeout, and that the `Max Output`
  cell tooltip shows source/status/summary details.
- Verify `Context Limit` is unchanged by the ping — it comes from `model_specs.json` only and is never probed.
- Verify `Tool Support` is:
  - blank before test completion
  - `true` when tool calls are observed
  - `false` when the tool probe ends with explicit unsupported-tool evidence or accepted requests still do not emit tool calls
  - still blank when the tool probe is inconclusive or rate-limited
- Hover the `Tool Support` cell on a false or inconclusive row and verify the tooltip explains the stored reason and probe summary.

### Batch Testing

- Click `Test Displayed Models`.
- Verify rows that are missing a complete live result are tested sequentially.
- Verify the progress area appears and the button changes to `Stop Testing`.
- Run with `PROBE_TRACE=1` and verify every consecutive `[probe-trace ...]` model-probe log line is at least the configured fixed spacing apart. At defaults, that means at least 1550 ms between any two `/v1/chat/completions` probe calls, keeping model invocations strictly below 40 RPM. This is the only probe rate-limit mechanism — there is no per-model delay layered on top.
- Verify a row with missing numeric token limits gets retried once back-to-back (no extra wait, the rate limiter handles spacing).
- If NVIDIA returns `429`, verify the row shows `Rate Limited` and remains eligible for retry instead of being treated as a confirmed unsupported result.
- Verify tool support probes use `TOOL_SUPPORT_MAX_TOKENS=512` by default.
- Verify tool support probes use a 30-second initial timeout and one 120-second
  fallback timeout only for the same timed-out variant.
- Verify tool support testing stops early on confirmed support, explicit
  unsupported-tool errors, rate limits, backend errors, or fallback timeout.
- If a model accepts a tool request but stops with `finish_reason="length"` before returning a tool call, verify the backend leaves the tool result inconclusive unless `TOOL_SUPPORT_RETRY_MAX_TOKENS` is configured above the current budget.
- Click `Stop Testing` and verify the batch run stops.

### Forced Batch Re-Test

- Hold `Shift` and click `Test Displayed Models`.
- Verify already-tested displayed rows are cleared and re-tested.

### Force Refresh

- Populate several rows with live test results.
- Click `Force Refresh Data`.
- Verify the table clears immediately.
- Verify any running batch test is stopped.
- Verify the populate progress bar appears and updates while model cards are being fetched.
- After populate finishes, verify the next render returns fresh rows with no persisted live test values, and `Context Limit` / `Labels` reflect the latest publisher data.

### CLI Populate

- Run `npm run populate-specs` (or `node populate_specs.js`).
- Verify it writes to `model_specs.json` with sensible counts in stdout (`contextLength populated: K/N`).
- Verify the running server picks up the new file without restart on the next list refresh (mtime hot-reload).

### Usage Popover

- Right-click a row that has a `Use case` populated in `model_specs.json` (for example `deepseek-ai/deepseek-v4-flash`).
- Verify the popover shows:
  - "Model card: https://build.nvidia.com/&lt;publisher&gt;/&lt;model&gt;/modelcard" rendered as a clickable link that opens in a new tab.
  - "Use case: ..." with the publisher's stated use-case sentence.
  - The cURL block referencing `$NVIDIA_API_KEY`.
- Right-click a row whose spec has no `useCase` (for example `adept/fuyu-8b`).
- Verify the use-case line is hidden entirely (no empty-row gap).
- Verify the copy button places the cURL text on the clipboard.

## Static Verification

Run these checks before committing:

```bash
npm run check
bash -n start.sh
```

## Acceptance Criteria

| Area | Expected Result |
| --- | --- |
| Startup | `./start.sh` requires `NVIDIA_API_KEY`, installs dependencies, and starts the server successfully. |
| Data loading | Metadata is fetched, flattened, and displayed for active models only. |
| Sorting and search | Every displayed column remains sortable and searchable through the global filter. |
| Live probing | Single-row and batch testing update latency, token limits, and tool support without crashing the UI. |
| Reset behavior | `Force Refresh Data` clears saved live test results and reloads the dataset from NVIDIA. |
| Usage examples | Right-click snippets are model-specific and use `NVIDIA_API_KEY`. |
