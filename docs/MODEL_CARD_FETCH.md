# Fetching Model Cards from build.nvidia.com

How `model_specs.json` is generated, where the data comes from, and what to
watch out for. This document is the spec for [`populate_specs.js`](../populate_specs.js)
and the populate-related routes in [`nvidia-model-server-info.js`](../nvidia-model-server-info.js).
If code and document disagree, the code is the source of truth — please update
this file when behavior changes.

## TL;DR

- We pull every endpoint listed at build.nvidia.com from the **public NGC
  catalog API** (`api.ngc.nvidia.com`, no auth).
- Each endpoint's full markdown model-card body is in the response — the same
  prose that build.nvidia.com renders. We parse it locally with regex.
- Result is written to `model_specs.json` (committed). The server reads it on
  startup and on file `mtime` changes — **no restart needed** to pick up edits.
- Trigger: `Force Refresh Data` button (or first-load auto-trigger if the file
  is empty), `npm run populate-specs`, or `POST /api/populate-specs`.

## Why an API instead of HTML scraping

build.nvidia.com is a Next.js SPA. Its model card body lives inside
`self.__next_f.push([1,"…"])` chunks (Server Components stream). Scraping that
HTML works (we did it before), but is brittle:

- Same page contains promo blurbs about other models in sidebars — easy to
  capture wrong context lengths from neighbour cards.
- Markdown is double-escaped inside JS strings; needs unescaping before regex.
- Layout depends on which Next.js route renders the page.

The NGC catalog API returns the **exact same markdown** as one clean JSON
field — `artifact.description` — with no sidebar contamination.

## API endpoints used

All under `https://api.ngc.nvidia.com`. None require auth. Discovered by
loading build.nvidia.com in Playwright and watching the network panel.

### 1. List endpoints — `GET /v2/search/catalog/resources/ENDPOINT`

Search the catalog for ENDPOINT-type resources scoped to the build.nvidia.com
tenant org `qc69jvmznzxy`.

```
GET https://api.ngc.nvidia.com/v2/search/catalog/resources/ENDPOINT
    ?q={"query":"*","filters":[{"field":"orgName","value":"qc69jvmznzxy"}],"page":0,"pageSize":200}
```

Returns ~165 results. Each has `name`, `displayName`, `publisher`, short
`description`, `attributes`, `labels`, `dateModified`. We use `name` to look up
the full record next.

`pageSize: 200` is enough today; the loop pages through until the deduped set
either reaches `resultTotal` or stops growing.

### 2. Endpoint detail — `GET /v2/endpoints/{org}/{name}`

```
GET https://api.ngc.nvidia.com/v2/endpoints/qc69jvmznzxy/{name}
```

Returns:

```json
{
  "artifact": {
    "name": "deepseek-v4-flash",
    "displayName": "deepseek-v4-flash",
    "publisher": "deepseek-ai",
    "description": "<full markdown model card, 7-77 KB>",
    "shortDescription": "…",
    "attributes": [{"key": "AVAILABLE", "value": "true"}, ...],
    "labels": ["MoE", "agentic", "coding", "fast",
               "playgroundType:endpoint:playgroundtype_chat", ...],
    "createdDate": "...", "updatedDate": "...", "logo": "..."
  }
}
```

`description` is the goldmine — same prose build.nvidia.com renders in the
"Model Card" tab.

### 3. Status / metadata helpers (our own server)

- `POST /api/populate-specs` — fire-and-forget. Returns `202` with the initial
  state. If a populate is already running, returns the in-progress state with
  `message: "already running"`.
- `GET /api/populate-specs/status` — current `populateState` for polling.
- `GET /api/specs-meta` — `{ exists, entries, withContext, lastFetchedAt }`.
  Used by the front-end to decide whether to auto-trigger on first load.

## Slug mapping

`build.nvidia.com` URL ≠ NGC API `name`. The transformation is **not
deterministic** — different publishers normalize differently:

| build.nvidia.com URL | NGC `name`                  | Rule observed     |
|---------------------|------------------------------|-------------------|
| `kimi-k2.6`         | `kimi-k2.6`                  | preserved         |
| `minimax-m2.7`      | `minimax-m2.7`               | preserved         |
| `glm-5.1`           | `glm-51`                     | dot dropped       |
| `llama-3.3-70b-instruct` | `llama-3_3-70b-instruct` | dot → underscore  |

**Rule of thumb: never derive the slug — list it.** `populate_specs.js` always
runs the search to enumerate names, then fetches each by `name`.

For mapping back into our app's model id (which matches `/v1/models` IDs like
`meta/llama-3.3-70b-instruct`):

```
apiId = `${artifact.publisher}/${artifact.displayName}`
```

`displayName` preserves the dotted version. This matches our `/v1/models`
catalog one-to-one.

## Field extraction

Source: `artifact.description` (markdown). We extract:

| Field             | Where it comes from                                  | Notes |
|-------------------|------------------------------------------------------|-------|
| `contextLength`   | Pattern waterfall over the markdown body              | Number of tokens (integer). Plausibility: 512 ≤ value ≤ 100M |
| `maxOutputTokens` | Same source, narrow patterns                          | Rare on cards (~5 of 162) — usually missing; probe falls back |
| `displayName`     | API field `artifact.displayName`                      | Dotted version, used in `apiId` |
| `publisher`       | API field `artifact.publisher`                        | e.g. `deepseek-ai`, `z-ai`, `meta`, `nvidia` |
| `parameters`      | "X total parameters" / table cell                     | String like `"284B"`, `"1T"` |
| `activeParameters`| "and Y activated" / `(Y active)`                      | Only for MoE; null for dense models |
| `architecture`    | "Network Architecture: …" line                        | E.g. `"Mixture-of-Experts (MoE)"` |
| `inputModalities` | "Input Type(s): …"                                   | Filtered to `text/image/video/audio/speech` |
| `outputModalities`| "Output Type(s): …"                                  | Same allowed set |
| `releaseDate`     | "build.nvidia.com:** April 23, 2026"                  | ISO 8601 (`YYYY-MM-DD`) |
| `license`         | "Additional Information: [MIT]"                       | Author license, not NVIDIA terms-of-service |
| `huggingfaceUrl`  | First `https://huggingface.co/...` link in body       | Empty for NVIDIA-developed models |
| `useCase`         | First sentence after `## Use Case`                    | Not surfaced as a column today |
| `labels`          | API field `artifact.labels` (raw, kept verbatim)      | The server filters `:` out for the table column |
| `preview`         | `attributes.PREVIEW === "true"`                      | Boolean |
| `available`       | `attributes.AVAILABLE === "false"` → `false`          | Set only when explicitly false |
| `_source`         | Constant `"build.nvidia.com"`                         | Provenance |
| `_fetchedAt`      | `new Date().toISOString()`                            | When this entry was written |
| `_ngcSlug`        | `artifact.name`                                       | For debugging slug mismatches |

### Context-length patterns (in priority order)

See `CONTEXT_PATTERNS` in `populate_specs.js`. The list is ordered
most-specific → least-specific; the first match wins. Each pattern requires
either a `K`/`M` suffix or an explicit `tokens?` word so we don't capture
unrelated numbers (e.g. "20 seconds" from a 3D-vision model).

A few real examples:

| Phrase in card                                   | Pattern that catches it                           | Result   |
|-------------------------------------------------|---------------------------------------------------|----------|
| `Maximum context length of 1 million tokens`    | "Maximum context length is/of …" (word "million") | 1000000  |
| `Input Context Length (ISL):** 204,800`         | "Input Context Length (ISL)" + comma number       | 204800   |
| `**Context Length**: 256K tokens`               | "Context Length: …K tokens"                       | 262144   |
| `\| 128k \|` (markdown table cell)               | Table fallback, header column "Context length"    | 131072   |
| `Up to 128k tokens context length`               | "Up to … tokens context length"                   | 131072   |
| `128K Maximum Context Length` (Mistral-Nemotron)| Reversed form: number then phrase                 | 131072   |
| `Long-context support up to 32K tokens`          | "Long-context support up to … tokens"             | 32768    |
| `Total input context of 32K tokens` (Gemma)     | "Total input context of … tokens"                 | 32768    |
| `Input + Output Token: 128K` (Nemotron-VL)      | "Input + Output Token(s): …K"                     | 131072   |

### Plausibility bounds

After parsing, we drop any value outside `[512, 100M]` tokens. This prevents
mis-parses like the StreamPETR case where the prose said "Input Context Length
(ISL): 20 seconds" — a 3D-vision model's frame budget, not an LLM context.

### Token-count parsing

`parseTokenCount` (in `populate_specs.js`) treats:

- `K` / `k` → `× 1024`
- `M` / `m` → `× 1024 × 1024`  (binary, **not** decimal)
- `B` / `b` / `G` / `g` → `× 1024³`
- bare integer → as-is
- comma is stripped: `204,800` → `204800`

For prose with the word `million` / `billion` (e.g. DeepSeek's "1 million
tokens"), we use **decimal** scaling instead — `1 million = 1,000,000`. This
matches the publisher's stated intent.

## Triggers — when populate runs

1. **First-load auto-trigger.** On page load, the front-end calls
   `GET /api/specs-meta`. If `entries === 0` or the file is missing, it fires
   the same handler as the Force Refresh Data button (full reset + reload +
   populate) and reloads the page when done. No partial table is shown — the
   user lands on a fully-populated view.
2. **Force Refresh Data button.** The only manual control. Performs three
   things in sequence:
   1. `POST /api/reset-all-cache` — clears the live-test (probe) cache.
   2. `GET /api/models-with-metadata?refresh=1` — reloads the `/v1/models`
      catalog from NVIDIA.
   3. `POST /api/populate-specs` + poll — refreshes every model card from
      build.nvidia.com.
   Then `window.location.reload()` so the table reflects new specs.
3. **CLI** — `node populate_specs.js` or `npm run populate-specs`. Useful in
   CI / cron / one-off workflows. Does the same thing as the HTTP endpoint but
   without server overhead.

There is intentionally **no separate "Refresh Model Cards" button** — model
cards travel with the model catalog, so a refresh of one without the other
would be inconsistent.

## Progress reporting

`populateState` in the server is a single shared object, polled by the
front-end every 600 ms while a populate is running:

```js
{
  status: "idle" | "running" | "done" | "failed",
  total: 0,                  // number of endpoints to process
  completed: 0,              // count finished (ok or 404 or fail)
  contextHits: 0,            // how many got a contextLength
  failed: 0,                 // non-404 errors
  skipped404: 0,             // endpoints that 404'd at /v2/endpoints/{org}/{name}
  startedAt: <ISO> | null,
  finishedAt: <ISO> | null,
  error: <string> | null,
  currentLabel: "<publisher>/<displayName>"  // most recent in-flight item
}
```

Concurrency defaults to 6 simultaneous detail fetches (`POPULATE_CONCURRENCY`).
For ~165 endpoints this finishes in roughly 30 seconds.

## File map

| File                              | Role                                                                              |
|-----------------------------------|-----------------------------------------------------------------------------------|
| `populate_specs.js`               | CLI/library: list endpoints, fetch details, parse description, write JSON.        |
| `model_specs.json`                | Generated artifact. Committed to repo. Source of `contextLength` etc. at runtime. |
| `nvidia-model-server-info.js`     | Loads `model_specs.json` (mtime-watched). Exposes `/api/populate-specs` etc.      |
| `public/app.js`                   | Auto-trigger on first load, Force Refresh handler, progress polling, table render.|
| `public/index.html`               | Hosts the progress bar and the (single) Force Refresh button.                     |
| `docs/MODEL_CARD_FETCH.md`        | This document.                                                                    |

## Caveats and known issues

### `description` ≠ what build.nvidia.com renders for some models

GLM-5.1 is the canonical example:

- HF `config.json`: `max_position_embeddings = 202752`
- NGC API `description`: "Maximum context length: 205K tokens" (matches HF)
- build.nvidia.com page (rendered): "Input context length: 131,072 tokens"
- Probe of the live NIM endpoint: usually 131K or lower

The API description and the rendered web page can diverge by 30%+. The API
gives the **author's stated upper bound**. The build.nvidia.com page gives the
**NIM-deployment cap**. We currently take the API value because:

1. It's more stable across NIM redeployments.
2. It matches what HF / publisher docs say.
3. The probe (`/api/test-model`) provides empirical ground truth as a sibling.

If you ever need the deployed limit specifically, scrape the rendered HTML
instead — but you give up everything else this API gives you.

### Some models genuinely have no context info

Out of 162 endpoints, only ~64 surface a usable contextLength. The rest are:

- **Image / vision generation** (FLUX, Stable Diffusion, Cosmos) — context
  doesn't apply.
- **ASR / speech** (Parakeet, NemoVoiceChat) — token count is meaningless.
- **Embeddings & rerankers** — sometimes have a context, often unstated.
- **CFD / scientific** (Fluent, AlphaFold, Spectre-X) — different domain.
- A handful of older Mistral cards that don't state context anywhere.

This is expected. Don't try to "fix" the chat-model gap below ~90% by widening
patterns — you'll just get false positives. Filter by labels containing
`playgroundtype_chat` for an honest hit-rate denominator.

### Slug case sensitivity

The HuggingFace side is case-sensitive (`MiniMaxAI/MiniMax-M2.7` ≠
`minimaxai/minimax-m2.7`). The NGC API is **case-insensitive on most paths**
but the canonical `name` returned by search has its own normalization. Always
use `artifact.name` from the API verbatim — never lower- or upper-case it.

### 404s on /v2/endpoints/{org}/{name}

Even when an endpoint shows in the search list, the detail call sometimes
returns 404 (e.g. transient catalog inconsistencies, deprecated endpoints
still indexed). The script counts these as `skipped404`, not `failed`. Output
is unaffected.

### Rate limiting

The NGC catalog is generous in our experience — 6 concurrent calls have
worked reliably. If you raise `POPULATE_CONCURRENCY` and start seeing 429s,
add backoff in `fetchEndpointDetail`.

## Adding new patterns

When a model isn't caught by `parseContextLength`:

1. Fetch its description directly:
   ```bash
   curl -s "https://api.ngc.nvidia.com/v2/endpoints/qc69jvmznzxy/<name>" \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)["artifact"]["description"])'
   ```
2. Find the line that states the context. Note its phrasing.
3. Add a new entry near the top of `CONTEXT_PATTERNS`. Most-specific phrasings
   go first.
4. Verify the regex would match all `[KkMm]` cases — `[KMm]` is a common
   mistake that excludes lowercase `k` (which models like Llama use as
   `128k`).
5. Re-run `node populate_specs.js`. Check that
   - the new model now has a `contextLength`,
   - no previously-correct value changed,
   - no false positives appear (cross-check with the plausibility bounds log).

If you can't write a pattern that's both narrow and complete, prefer
narrow — it's better to leave a model without a context value than to display
a wrong one.

## Frontend integration

The server exposes `row.labels` as a comma-joined string of plain tags
(colon-prefixed system labels like `playgroundType:endpoint:playgroundtype_chat`
are filtered out at row-build time in `loadModelsWithMetadata`).

The UI shows it as a sortable, search-filterable column titled "Labels". The
search input filters across every column, so typing `agentic` (or `MoE`,
`coding`, `Multimodal`, etc.) narrows the table to matching models.

Sample real labels we see in production: `MoE`, `agentic`, `coding`, `fast`,
`reasoning`, `Multimodal`, `text-generation`, `Tool Use`, `Long Context`,
`Vision Assistant`, `Run-on-RTX`, `thinking budget`.
