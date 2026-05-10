# Requirements

## Product Goal

Provide a local dashboard for inspecting the free model catalog on `build.nvidia.com`, including flattened metadata, live capability probes, sorting, searching, and copyable usage examples.

## Functional Requirements

### Model Loading

- Fetch the NVIDIA model catalog from the API.
- Fetch metadata for every listed model through the model metadata endpoint.
- Show only models that appear active and usable.
- Flatten metadata into table columns so every available metadata field can be viewed and sorted.
- Source `Context Limit`, `Max Output`, and `Labels` from publisher-stated values on `build.nvidia.com` (pulled via the public NGC catalog API into `model_specs.json`). The probe path must not overwrite spec-supplied values.

### Table Behavior

- Support sorting on every displayed column.
- Support global text search across row values. Whitespace-separated terms must use OR semantics — a row matches when any term is found as a substring in any displayed cell.
- Keep these columns pinned on the left:
  - `Live Ping`
  - `Model ID`
  - `Publisher`
  - `Labels`
  - `Context Limit`
  - `Max Output`
  - `Latency (ms)`
  - `Tool Support`
  - `Tested At`
- The `Labels` column must show only plain capability tags (system labels containing `:` are not displayed). Sorting and global search must apply to it.

### Live Probing

- Each row must provide a `Ping` action.
- A live probe must attempt to determine:
  - availability
  - latency
  - max output tokens (only when the spec did not already provide a value)
  - tool calling support
- Availability probing must first omit `max_tokens`, then step through `4096`,
  `16384`, `65536`, and `262144` by default when needed.
- Availability probing must use a tiered timeout strategy: 30 seconds for
  no-`max_tokens`, `4096`, and `16384` attempts; 120 seconds for `65536` and
  `262144` attempts.
- Availability results must distinguish HTTP-callable, normal-output,
  length-limited, timeout, backend-error, auth-error, and unavailable cases
  instead of collapsing every non-success into one generic failure.
- Max output probing must not depend on a single successful availability probe;
  it may still run after timeout or inconclusive availability results, while
  preserving model-card `Context Limit` and existing spec values.
- Max output probing must use independent timeout tiers and must keep source,
  status, and summary diagnostics instead of treating `no_limit_reported` as a
  hard numeric fact.
- `Context Limit` must not be probed live. It comes from `model_specs.json` only.
- `Tool Support` must remain blank until a tool support probe finishes.
- `429 Too Many Requests` responses must be treated as rate limiting, not as confirmed unsupported-tool results.
- Tool support detection must classify explicit tool-field validation errors such as unsupported or unknown `tools`, `tool_choice`, `functions`, and `function_call` fields as unsupported-tool results instead of leaving them inconclusive.
- Tool support probes must use bounded token ladders, starting at `128` for the
  primary `tools` variant and ending with a no-`max_tokens` fallback when
  needed.
- Tool support probes must stop after 8 requests per model by default and must
  not mark accepted-but-truncated tool probe responses as confirmed false.
- Tool support probes must use timeout tiers and early-stop decisions so slow
  models do not run every request variant after a terminal result is known.
- Probe cache entries must carry a schema/config version and stale entries must
  not be merged into current model rows.
- Batch testing must support:
  - testing currently displayed rows
  - skipping already complete rows by default
  - forcing a full re-test with `Shift + Click`
  - no artificial delay between models — pacing must come from a single global fixed-spacing rate limiter at `PROBE_RATE_LIMIT_RPM` (default 39 RPM, minimum 1550 ms), enforced before every outgoing `/v1/chat/completions` model-probe call so model invocations stay strictly below NVIDIA's 40 RPM cap
  - fixed minimum spacing only; do not implement token-bucket request pacing for this project
  - a single retry when numeric token limits are still missing or the model comes back rate-limited

### Filters

- Provide an `Exclude Inactive/Error` filter.
- Provide a `Tool Support` filter that keeps only rows with confirmed tool calling support.
- The search box must default to `agentic` after startup data loading finishes.

### Usage Examples

- Right-clicking a row must open a popover with:
  - a clickable link to that model's `build.nvidia.com` model card,
  - the publisher-stated use case (hidden when not provided in `model_specs.json`),
  - a copyable cURL snippet that references `NVIDIA_API_KEY` and targets `https://integrate.api.nvidia.com/v1/chat/completions`.
- The popover must not include an Anthropic-compatible `/v1/messages` snippet — that path is not exposed by the hosted endpoint.

### Reset And Refresh

- `Force Refresh Data` must:
  - stop any running batch test
  - clear visible dashboard state
  - delete saved live test results
  - reset backend caches
  - fetch a fresh model list and metadata snapshot from NVIDIA
  - re-pull every endpoint's model card from build.nvidia.com and rewrite `model_specs.json`
  - show progress while the populate runs and reload table data when done

- On first load, when `model_specs.json` has no entries, the dashboard must automatically execute the same flow as `Force Refresh Data` so the user lands on a populated table without manual interaction, then apply the default `agentic` search filter.

- The same model-card populate must also be runnable from the CLI as `npm run populate-specs` (or `node populate_specs.js`).

## Technical Requirements

- Runtime language: Node.js 18+
- UI language: English
- API key source: environment variable `NVIDIA_API_KEY`
- `.env` files must not be used for API key loading
- The app should attempt to open the dashboard automatically in the default browser on startup
- The UI should follow the system light or dark theme
