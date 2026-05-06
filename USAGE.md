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
2. Output-token limit (only when `model_specs.json` does not already provide `maxOutputTokens` for this model)
3. Tool calling support

`Context Limit` is never re-probed live — it always comes from `model_specs.json`. To refresh that value, use `Force Refresh Data` (or `npm run populate-specs`).

The row is cleared to an in-progress state before the request completes.

### Test Displayed Models

Click `Test Displayed Models` to batch-test the rows that are currently displayed and still missing a complete live result.

- Rows that already have latency, numeric token limits, and a completed tool support probe are skipped by default.
- Hold `Shift` while clicking to force a re-test of every displayed row.
- There is no artificial delay between models. Every NVIDIA call (availability, output-limit, tool-support probes) goes through a single global rate limiter on the backend: minimum gap = `60000 / PROBE_RATE_LIMIT_RPM` ms, defaulting to 1500 ms (= NVIDIA's free-tier 40 RPM cap). The batch button just fires models in order and lets the limiter pace everything.
- If a test does not return numeric token limits or comes back rate-limited, that model is retried once immediately — the rate limiter holds the retry's first probe until 1500 ms has passed since the previous one.
- Click the button again while a batch is running to stop it.

## Understanding The Key Columns

- `Labels`: Plain capability tags pulled from the build.nvidia.com model card (for example `MoE`, `agentic`, `coding`, `Multimodal`, `Tool Use`). Sortable and searchable through the global filter. System labels containing `:` are stripped.
- `Context Limit`: Comes from `model_specs.json`, populated from the publisher's model card on `build.nvidia.com`. Shows `Not Tested` when no spec entry exists for the model. Refresh via `Force Refresh Data`.
- `Max Output`: Comes from `model_specs.json` when available, otherwise filled in by a live probe. Falls back to `Unknown`, `Inactive`, `Error`, or `No Limit Reported` when a live probe runs but cannot resolve a numeric value.
- `Latency (ms)`: Populated only after a successful live probe.
- `Tool Support`:
  - blank = not tested yet
  - `true` = tool calling support confirmed
  - `false` = the probe completed and concluded either that tool fields are explicitly unsupported or that accepted requests still did not emit tool calls
- The backend tries several tool-calling payload variants, expands the unsupported classification for tool-field validation errors, and retries accepted-but-truncated responses with a larger `max_tokens` budget before leaving `Tool Support` blank.
- `Rate Limited`: the NVIDIA API returned `429 Too Many Requests`. These rows are left retryable instead of being treated as confirmed failures.
- `Tested At`: Local timestamp saved with the last completed live probe.
- Hover the `Tool Support` cell to inspect the stored reason summary for `false` or inconclusive results.

## Row Usage Popover

Right-click any model row to open a usage popover with a copyable cURL example.

The snippet always references `NVIDIA_API_KEY` and is generated for that specific model ID.

The popover does not include a Claude Code command for the hosted API. On `2026-04-14`, the hosted endpoint `https://integrate.api.nvidia.com/v1/messages` returned `404 page not found`, so the Anthropic-compatible path required by Claude Code is not currently available there.

## Force Refresh Data

`Force Refresh Data` is a hard reset that also re-pulls model cards. It is the only UI action that brings new data in from `build.nvidia.com` and is the only way `Context Limit` and `Labels` get updated for newly added models.

It does all of the following:

- clears the visible table
- stops any running batch test
- deletes all saved live test results from `model_limits_cache.json`
- clears the backend in-memory cache
- fetches a fresh model list and model metadata from NVIDIA
- re-pulls every endpoint's model card from the public NGC catalog API and rewrites `model_specs.json`
- shows a progress bar while the populate runs (`Refreshing model cards: …`)
- reloads the page when finished so the table picks up the new specs

On the very first load, when `model_specs.json` is empty, the dashboard fires this same flow automatically — no clicks required. The status bar reads `First-time setup: loading model list and refreshing model cards from build.nvidia.com…` while it runs.

The same refresh can also be triggered from the command line: `npm run populate-specs` (or `node populate_specs.js`). Useful for CI, cron, or one-off workflows.

## Troubleshooting

- API key missing: verify `NVIDIA_API_KEY` is exported in the same shell that launches `./start.sh`.
- Port already in use: set another port, for example `PORT=5000 ./start.sh`.
- `Not Tested` or blank `Tool Support`: the row has not completed a live test yet.
- blank `Tool Support` with a tooltip reason like `Rate Limited`, `Backend Error`, or `Timeout`: the tool probe ran but stayed inconclusive, so the row remains retryable.
- `Unknown`: the model responded, but the output-token probe did not produce a numeric limit.
- `Not Tested` in `Context Limit`: no entry exists in `model_specs.json` for this model. Run `Force Refresh Data` (or `npm run populate-specs`) to repopulate.
- numeric `Context Limit` value: pulled from `model_specs.json` (publisher's model card on build.nvidia.com).
- `No Limit Reported`: the model accepted the oversized token test without exposing a hard limit.
- `Rate Limited`: the backend hit NVIDIA's request cap and backed off. Retry the row later or rerun the batch after the cooldown window.
- `Inactive`: the availability test failed for that model.
- `Error`: the probe failed before a usable result could be determined.
