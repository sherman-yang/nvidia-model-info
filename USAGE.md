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
- Search: Defaults to `agentic` after startup data loading. Filter rows by substring across all displayed values. Multiple terms separated by whitespace use OR — a row matches when any term appears in any column. Example: `agentic moe multimodal`.
- Exclude Inactive/Error: Hides rows whose live test resolved to `Error` or `Inactive`.
- Tool Support: Shows only rows whose tool calling probe completed and returned `true`.

## Live Testing

### Ping One Model

Click `Ping` on a row to re-test that model.

The backend probes:

1. Availability and latency with `max_tokens: 262144`, a 30-second first timeout, and a 120-second fallback timeout.
2. Output-token limit when `model_specs.json` does not already provide `maxOutputTokens`; this can still run after an availability timeout or inconclusive availability error and has its own 30-second / 120-second timeout tiers.
3. Tool calling support with `max_tokens: 512`, 30-second initial timeout, 120-second fallback timeout, and early-stop classification.

`Context Limit` is never re-probed live — it always comes from `model_specs.json`. To refresh that value, use `Force Refresh Data` (or `npm run populate-specs`).

The row is cleared to an in-progress state before the request completes.
The backend stores hidden `availabilityStatus` and `availabilitySummary` fields
so HTTP-callable, length-limited, timeout, backend-error, and unavailable cases
are not collapsed into one generic failure.

### Test Displayed Models

Click `Test Displayed Models` to batch-test the rows that are currently displayed and still missing a complete live result.

- Rows that already have latency, numeric token limits, and a completed tool support probe are skipped by default.
- Hold `Shift` while clicking to force a re-test of every displayed row.
- There is no artificial delay between models. Every model-invocation probe call (`/v1/chat/completions` for availability, output-limit, and tool-support probes) goes through a single global fixed-spacing limiter on the backend. The default is 39 RPM with a minimum 1550 ms gap, so probe calls stay strictly below NVIDIA's 40 RPM free-tier cap. Model-list and model-metadata GET calls are not paced.
- If a test does not return numeric token limits or comes back rate-limited, that model is retried once immediately — the rate limiter holds the retry's first model probe call until the global spacing gate allows it.
- Click the button again while a batch is running to stop it.

## Understanding The Key Columns

- `Labels`: Plain capability tags pulled from the build.nvidia.com model card (for example `MoE`, `agentic`, `coding`, `Multimodal`, `Tool Use`). Sortable and searchable through the global filter. System labels containing `:` are stripped.
- `Context Limit`: Comes from `model_specs.json`, populated from the publisher's model card on `build.nvidia.com`. Shows `Not Tested` when no spec entry exists for the model. Refresh via `Force Refresh Data`.
- `Max Output`: Comes from `model_specs.json` when available, otherwise filled in by a live probe. Falls back to `Unknown`, `Inactive`, or `Error` when a live probe cannot resolve a numeric value. Hover this cell to inspect hidden source/status details such as `parsed_error`, `timeout`, or `no_limit_reported`.
- `Latency (ms)`: Populated only after a successful live probe.
- `Tool Support`:
  - blank = not tested yet
  - `true` = tool calling support confirmed
  - `false` = the probe completed and concluded either that tool fields are explicitly unsupported or that accepted requests still did not emit tool calls
- The backend tries tool-calling payload variants with early stop, expands the unsupported classification for tool-field validation errors, and leaves accepted-but-truncated responses inconclusive unless `TOOL_SUPPORT_RETRY_MAX_TOKENS` is configured above the default 512-token budget.
- `Rate Limited`: the NVIDIA API returned `429 Too Many Requests`. These rows are left retryable instead of being treated as confirmed failures.
- `Tested At`: Local timestamp saved with the last completed live probe.
- Hover the `Tool Support` cell to inspect the stored reason summary for `false` or inconclusive results.

## Row Usage Popover

Right-click any model row to open a usage popover containing:

- **Model card link** — clickable URL to that model's page on `build.nvidia.com` (`https://build.nvidia.com/<publisher>/<model>/modelcard`).
- **Use case** — the publisher's stated use-case sentence parsed from the model card. Hidden when the spec entry has no use case (some models genuinely don't state one).
- **cURL snippet** — ready to paste, references the `NVIDIA_API_KEY` environment variable, target endpoint is `https://integrate.api.nvidia.com/v1/chat/completions`, body uses `max_tokens = min(spec maxOutputTokens, 512)`.

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
- reloads the table data when finished so the table picks up the new specs

On the very first load, when `model_specs.json` is empty, the dashboard fires this same flow automatically — no clicks required. The status bar reads `First-time setup: loading model list and refreshing model cards from build.nvidia.com…` while it runs. The `agentic` search filter is applied only after this refresh finishes.

The same refresh can also be triggered from the command line: `npm run populate-specs` (or `node populate_specs.js`). Useful for CI, cron, or one-off workflows.

## Troubleshooting

- API key missing: verify `NVIDIA_API_KEY` is exported in the same shell that launches `./start.sh`.
- Port already in use: set another port, for example `PORT=5000 ./start.sh`.
- `Not Tested` or blank `Tool Support`: the row has not completed a live test yet.
- blank `Tool Support` with a tooltip reason like `Rate Limited`, `Backend Error`, or `Timeout`: the tool probe ran but stayed inconclusive, so the row remains retryable.
- `Unknown`: the model responded, but the output-token probe did not produce a numeric limit.
- `Not Tested` in `Context Limit`: no entry exists in `model_specs.json` for this model. Run `Force Refresh Data` (or `npm run populate-specs`) to repopulate.
- numeric `Context Limit` value: pulled from `model_specs.json` (publisher's model card on build.nvidia.com).
- `Unknown` with max-output status `no_limit_reported`: the model accepted the oversized token test without exposing a hard limit; this is not treated as proof that no limit exists.
- `Rate Limited`: the backend hit NVIDIA's request cap and backed off. Retry the row later or rerun the batch after the cooldown window.
- `Inactive`: the availability test failed for that model.
- `Error`: the probe failed before a usable result could be determined.
