# Implementation Document

## 1. Architecture Overview
The application consists of a Node.js Express backend and a vanilla HTML/CSS/JavaScript frontend. It acts as an integration layer between the user's browser and the `build.nvidia.com` APIs.

## 2. Backend (`server.js`)

**Key Responsibilities:**
- Serve static frontend files from the `public/` directory.
- Provide a health endpoint (`/api/health`).
- Provide the core models endpoint (`/api/models-with-metadata`).
- Provide the live test endpoint (`/api/test-model`).
- Persist test results to `model_limits_cache.json`.

**Core Logic Flow:**
1. **API Key Loading**: 
   - Reads the API key strictly from the system environment variable `Sherman_NVDA_test`. 
   - Falls back to a warning if it's not set. Requests are sent without the Authorization header in this case.
   - `.env` files are ignored to enhance security.

2. **Fetching Models**:
   - `listAllModels()`: Calls `GET /models` to get the base list of models.
   - `getModelMetadata(modelId)`: Concurrently fetches metadata for each model from `GET /models/{publisher}/{model}`.

3. **Data Transformation & Filtering**: 
   - `toRow(listModel, metadata)`: Flattens the metadata object to integrate it into a single table row dictionary alongside base item properties. 
   - Extracts and pins `contextLength` and `maxOutputTokens` directly to the row using a series of key heuristics to handle inconsistencies in API payloads. If not found from the API metadata, the default value is `"Not Tested"`, which signals to the user that a live test hasn't been run yet.
   - `isActiveUsableRow(row)`: Scans flattened keys and values to determine model availability. If terms like `deprecated`, `retired`, `inactive`, or purely boolean indicators suggest it's unavailable, the model is filtered out.

4. **Caching**:
   - **In-memory cache**: Implements a TTL cache (`cache.payload`) valid for `CACHE_TTL_MS` (default 5 minutes). Prevents hitting the NVIDIA API rate limits repeatedly across browser reloads.
   - **In-flight deduplication** (`cache.inFlight`): Deduplicates simultaneous requests making the initial API call.
   - **Persistent test cache** (`model_limits_cache.json`): When models are tested via `/api/test-model`, results (latency, context length, max output tokens, availability) are saved to a JSON file. On the next data load, these cached results are merged into the rows, so test results survive page refreshes and server restarts.

5. **Live Test Endpoint** (`/api/test-model`):
   - Sends a minimal `max_tokens: 1` request to measure latency and availability.
   - Sends an oversized `max_tokens: 99999999` request to trigger error messages that reveal the model's actual context length and max output token limits.
   - Parses error messages with multiple regex patterns to extract limits from varied error formats across different model providers.
   - Falls back: if `contextLength` is found but not `maxOutputTokens`, defaults to `min(4096, contextLength)`. The reverse also applies.
   - Persists the result to `model_limits_cache.json` and invalidates the in-memory cache.

6. **Browser Launch**:
   - On server start, automatically opens the dashboard URL in the user's default browser via `exec("open ...")` on macOS, `exec("start ...")` on Windows, or `exec("xdg-open ...")` on Linux.

## 3. Frontend (`public/app.js`, `public/index.html`, `public/styles.css`)

**Key Responsibilities:**
- Request aggregated data from the backend.
- Render the responsive, tabular UI.
- Handle search filtering, column sorting, live testing, and code snippet generation.

**Core Logic Flow:**
1. **State Management**:
   - Maintains a central `state` object holding rows, columns, search text, and sort key/direction.
   
2. **Table Rendering**:
   - Pinned columns: `liveTest` (Live Ping), `modelId`, `publisher`, `contextLength`, `maxOutputTokens`, `latencyMs`. These are sticky on the left for easy reference.
   - When a model has cached test results, the Live Ping column shows the result (e.g. `"850ms (OK)"`) alongside a small "Re-test" button. Untested models show a "Ping" button.

3. **Sorting and Filtering**:
   - A real-time search box applies a substring match against all column values.
   - Clicking headers toggles ascending/descending sorting, implemented by standardizing numbers vs text mapping (`compareValues`).

4. **Live Testing**:
   - `runLiveTest(row, btn)`: Tests a single model via `/api/test-model` and updates the row in-place.
   - `runBatchTest(force)`: Iterates over all visible rows sequentially, calling `runLiveTest` with a 3.5s delay between tests to respect rate limits. Models that were tested but didn't get numeric limits are automatically retested. If a test fails to detect numeric limits, it retries once after a 3.5s delay. Provides a progress bar and abort capability.

5. **Usage Code Generation (`buildUsageSnippets`)**:
   - When the user right-clicks a row, a popup context window (`#usage-popover`) is shown.
   - Constructs runnable examples containing the target model ID and realistic values using `maxOutputTokens`.
   - Offers snippets for cURL, Python (`requests`), and JavaScript (`fetch`).
   - Uses the environment variable `Sherman_NVDA_test` in all snippets (no hardcoded keys).

6. **Theming**:
   - CSS uses semantic variables (`:root` for light, `@media (prefers-color-scheme: dark)` for dark).
   - Automatically follows the user's system preference.

## 4. Initialization
- **`start.sh`**: Acts as the single entrypoint for the project. The script verifies that Node.js and NPM exist, asserts that the `Sherman_NVDA_test` environment variable has been exported successfully, installs dependencies via `npm install`, and delegates execution directly to the `server.js` backend, ensuring a smooth and consistent launch pattern.

## 5. Dependencies
- **Node.js**: Requires `v18+` (uses globally available `fetch`).
- **Express (`^4.21.2`)**: For the HTTP web server and robust static file routing.

*(Note: Environment configurations like `dotenv` have been explicitly removed according to requirements. The application mandates system environment variable usage exclusively.)*
