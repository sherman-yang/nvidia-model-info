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
- Support global text search across row values.
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
- `Context Limit` must not be probed live. It comes from `model_specs.json` only.
- `Tool Support` must remain blank until a tool support probe finishes.
- `429 Too Many Requests` responses must be treated as rate limiting, not as confirmed unsupported-tool results.
- Tool support detection must classify explicit tool-field validation errors such as unsupported or unknown `tools`, `tool_choice`, `functions`, and `function_call` fields as unsupported-tool results instead of leaving them inconclusive.
- Tool support detection must retry accepted-but-truncated tool probe responses with a larger completion budget before concluding that tool calling was not observed.
- Batch testing must support:
  - testing currently displayed rows
  - skipping already complete rows by default
  - forcing a full re-test with `Shift + Click`
  - no artificial delay between models — pacing must come from a single global rate limiter at `PROBE_RATE_LIMIT_RPM` (defaulting to NVIDIA's free-tier 40 RPM cap), enforced before every outgoing NVIDIA call
  - a single retry when numeric token limits are still missing or the model comes back rate-limited

### Filters

- Provide an `Exclude Inactive/Error` filter.
- Provide a `Tool Support` filter that keeps only rows with confirmed tool calling support.

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
  - show progress while the populate runs and reload the page when done

- On first load, when `model_specs.json` has no entries, the dashboard must automatically execute the same flow as `Force Refresh Data` so the user lands on a populated table without manual interaction.

- The same model-card populate must also be runnable from the CLI as `npm run populate-specs` (or `node populate_specs.js`).

## Technical Requirements

- Runtime language: Node.js 18+
- UI language: English
- API key source: environment variable `NVIDIA_API_KEY`
- `.env` files must not be used for API key loading
- The app should attempt to open the dashboard automatically in the default browser on startup
- The UI should follow the system light or dark theme
