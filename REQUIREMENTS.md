# Requirements

## Product Goal

Provide a local dashboard for inspecting the free model catalog on `build.nvidia.com`, including flattened metadata, live capability probes, sorting, searching, and copyable usage examples.

## Functional Requirements

### Model Loading

- Fetch the NVIDIA model catalog from the API.
- Fetch metadata for every listed model through the model metadata endpoint.
- Show only models that appear active and usable.
- Flatten metadata into table columns so every available metadata field can be viewed and sorted.

### Table Behavior

- Support sorting on every displayed column.
- Support global text search across row values.
- Keep these columns pinned on the left:
  - `Live Ping`
  - `Model ID`
  - `Publisher`
  - `Context Limit`
  - `Max Output`
  - `Latency (ms)`
  - `Tool Support`
  - `Tested At`

### Live Probing

- Each row must provide a `Ping` action.
- A live probe must attempt to determine:
  - availability
  - latency
  - context length
  - max output tokens
  - tool calling support
- `Tool Support` must remain blank until a tool support probe finishes.
- `429 Too Many Requests` responses must be treated as rate limiting, not as confirmed unsupported-tool results.
- Batch testing must support:
  - testing currently displayed rows
  - skipping already complete rows by default
  - forcing a full re-test with `Shift + Click`
  - a 5 second delay between models
  - a single retry when numeric token limits are still missing

### Filters

- Provide an `Exclude Inactive/Error` filter.
- Provide a `Tool Support` filter that keeps only rows with confirmed tool calling support.

### Usage Examples

- Right-clicking a row must open model-specific usage examples.
- Provide copyable snippets for:
  - cURL
  - Python
  - JavaScript
- Snippets must reference `NVIDIA_API_KEY`.

### Reset And Refresh

- `Force Refresh Data` must:
  - stop any running batch test
  - clear visible dashboard state
  - delete saved live test results
  - reset backend caches
  - fetch a fresh model list and metadata snapshot from NVIDIA

## Technical Requirements

- Runtime language: Node.js 18+
- UI language: English
- API key source: environment variable `NVIDIA_API_KEY`
- `.env` files must not be used for API key loading
- The app should attempt to open the dashboard automatically in the default browser on startup
- The UI should follow the system light or dark theme
