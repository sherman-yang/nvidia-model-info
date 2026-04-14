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
- Verify the table contains flattened metadata columns in addition to the pinned columns.

### Sorting And Filtering

- Enter `llama` in the search box and verify the table filters immediately.
- Toggle `Exclude Inactive/Error` and verify rows with `Error` or `Inactive` live results disappear.
- Toggle `Tool Support` and verify only rows with `Tool Support = true` remain visible.
- Click `Model ID`, `Context Limit`, and `Tool Support` headers and verify sorting changes direction on repeated clicks.

### Single-Row Testing

- Click `Ping` on an untested row.
- Verify the row clears immediately into a testing state.
- Verify latency, context limit, max output, and tested timestamp are updated after the request.
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
- Verify the runner waits about 8 seconds between models.
- Verify a row with missing numeric token limits gets retried once after another 8 second wait.
- If NVIDIA returns `429`, verify the row shows `Rate Limited` and remains eligible for retry instead of being treated as a confirmed unsupported result.
- If a model accepts a tool request but stops with `finish_reason="length"` before returning a tool call, verify the backend retries that variant with a larger `max_tokens` budget before concluding `false`.
- Click `Stop Testing` and verify the batch run stops.

### Forced Batch Re-Test

- Hold `Shift` and click `Test Displayed Models`.
- Verify already-tested displayed rows are cleared and re-tested.

### Force Refresh

- Populate several rows with live test results.
- Click `Force Refresh Data`.
- Verify the table clears immediately.
- Verify any running batch test is stopped.
- Verify the next load returns fresh rows with no persisted live test values.

### Usage Popover

- Right-click a row.
- Verify the popover opens with only a cURL snippet.
- Verify the snippet references `NVIDIA_API_KEY`.
- Verify the note explains that the hosted endpoint does not currently expose `/v1/messages`.
- Verify the copy button places the expected cURL text on the clipboard.

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
