# Usage

## Prerequisites

- Node.js 18 or later
- An NVIDIA API key from `build.nvidia.com`

## Start The Dashboard

Export the key in your shell. Do not place it in `.env`.

macOS or Linux:

```bash
export NVIDIA_API_KEY="your_actual_nvidia_api_key_here"
```

Windows Command Prompt:

```cmd
set NVIDIA_API_KEY=your_actual_nvidia_api_key_here
```

Windows PowerShell:

```powershell
$env:NVIDIA_API_KEY="your_actual_nvidia_api_key_here"
```

Then start the app:

```bash
./start.sh
```

The default URL is `http://localhost:4920`.

## Using The Interface

- Browse: Scroll horizontally to inspect all flattened metadata columns.
- Sort: Click any column header to toggle ascending or descending order.
- Search: Use the search box to filter rows by substring across all displayed values.
- Exclude Inactive/Error: Hides rows whose live test resolved to `Error` or `Inactive`.
- Tool Support: Shows only rows whose tool calling probe completed and returned `true`.

## Live Testing

### Ping One Model

Click `Ping` on a row to re-test that model.

The backend probes:

1. Availability and latency
2. Context limit and max output limit
3. Tool calling support

The row is cleared to an in-progress state before the request completes.

### Test Displayed Models

Click `Test Displayed Models` to batch-test the rows that are currently displayed and still missing a complete live result.

- Rows that already have latency, numeric token limits, and a completed tool support probe are skipped by default.
- Hold `Shift` while clicking to force a re-test of every displayed row.
- The batch runner waits 5 seconds between models.
- If a test does not return numeric token limits, the frontend waits 5 seconds and retries that model once.
- Click the button again while a batch is running to stop it.

## Understanding The Key Columns

- `Context Limit`: Comes from metadata when available, otherwise from live probing. If still unknown, it shows `Unknown`, `Inactive`, `Error`, or `No Limit Reported`.
- `Max Output`: Same detection flow as `Context Limit`.
- `Latency (ms)`: Populated only after a successful live probe.
- `Tool Support`:
  - blank = not tested yet
  - `true` = tool calling support confirmed
  - `false` = tool support probe completed but did not confirm tool calling
- `Tested At`: Local timestamp saved with the last completed live probe.

## Row Usage Popover

Right-click any model row to open a usage popover with copyable examples for:

- cURL
- Python `requests`
- JavaScript `fetch`

The snippets always reference `NVIDIA_API_KEY` and are generated for that specific model ID.

## Force Refresh Data

`Force Refresh Data` is a hard reset for the running dashboard state.

It does all of the following before reloading:

- clears the visible table
- stops any running batch test
- deletes all saved live test results from `model_limits_cache.json`
- clears the backend in-memory cache
- fetches a fresh model list and model metadata from NVIDIA

Use this when you want to discard all current test results and start from a clean state.

## Troubleshooting

- API key missing: verify `NVIDIA_API_KEY` is exported in the same shell that launches `./start.sh`.
- Port already in use: set another port, for example `PORT=5000 ./start.sh`.
- `Not Tested` or blank `Tool Support`: the row has not completed a live test yet.
- `Unknown`: the model responded, but the token limit probe did not produce a numeric limit.
- `No Limit Reported`: the model accepted the oversized token test without exposing a hard limit.
- `Inactive`: the availability test failed for that model.
- `Error`: the probe failed before a usable result could be determined.
