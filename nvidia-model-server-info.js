const express = require("express");
const path = require("node:path");
const fs = require("node:fs");
const { exec } = require("node:child_process");

const API_KEY_ENV_NAME = "Sherman_NVDA_test";

const app = express();

const PORT = Number(process.env.PORT || 4920);
const API_BASE_URL = "https://integrate.api.nvidia.com/v1";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
const MAX_CONCURRENCY = Math.max(1, Number(process.env.MAX_CONCURRENCY || 12));
const CACHE_TTL_MS = Math.max(1000, Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000));

if (typeof fetch !== "function") {
  throw new Error("This app requires Node.js 18+ (global fetch is missing).");
}

const cache = {
  expiresAt: 0,
  payload: null,
  inFlight: null
};

function getApiKey() {
  return process.env[API_KEY_ENV_NAME];
}

function launchBrowser(url) {
  let command;
  if (process.platform === "darwin") {
    command = `open ${url}`;
  } else if (process.platform === "win32") {
    command = `start ${url}`;
  } else {
    command = `xdg-open ${url}`;
  }

  exec(command, (error) => {
    if (error) {
      console.warn(`Unable to open browser automatically: ${error.message}`);
    }
  });
}

function getRequestHeaders() {
  const headers = {
    "Content-Type": "application/json"
  };

  const apiKey = getApiKey();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener(
        "abort",
        () => {
          controller.abort(signal.reason);
        },
        { once: true }
      );
    }
  }

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout)
  };
}

async function fetchJson(url, { signal } = {}) {
  const timeoutWrap = withTimeout(signal, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: getRequestHeaders(),
      signal: timeoutWrap.signal
    });

    const bodyText = await response.text();
    let body;

    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }

    if (!response.ok) {
      const errorBody =
        typeof body === "string" ? body : JSON.stringify(body ?? {}, null, 2);
      throw new Error(`HTTP ${response.status} for ${url}: ${errorBody}`);
    }

    return body;
  } finally {
    timeoutWrap.clear();
  }
}

function splitModelId(modelId) {
  const firstSlash = modelId.indexOf("/");
  if (firstSlash === -1) {
    return {
      publisher: "",
      modelName: modelId
    };
  }

  return {
    publisher: modelId.slice(0, firstSlash),
    modelName: modelId.slice(firstSlash + 1)
  };
}

async function listAllModels() {
  const payload = await fetchJson(`${API_BASE_URL}/models`);
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error("Unexpected /models response shape.");
  }

  return payload.data;
}

async function getModelMetadata(modelId) {
  const { publisher, modelName } = splitModelId(modelId);

  if (publisher && modelName) {
    const preferredUrl = `${API_BASE_URL}/models/${encodeURIComponent(publisher)}/${encodeURIComponent(modelName)}`;
    return fetchJson(preferredUrl);
  }

  const fallbackUrl = `${API_BASE_URL}/models/${encodeURIComponent(modelId)}`;
  return fetchJson(fallbackUrl);
}

function flattenObject(source, target, prefix) {
  if (source === null || source === undefined) {
    target[prefix] = source;
    return;
  }

  if (Array.isArray(source)) {
    target[prefix] = JSON.stringify(source);
    return;
  }

  if (typeof source !== "object") {
    target[prefix] = source;
    return;
  }

  const entries = Object.entries(source);
  if (entries.length === 0) {
    target[prefix] = "{}";
    return;
  }

  for (const [key, value] of entries) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    flattenObject(value, target, nextPrefix);
  }
}

function findValueByKeyCandidates(obj, candidates) {
  const keys = Object.keys(obj);
  for (const key of keys) {
    const lowered = key.toLowerCase();

    // We only care about the inner key name if it's formatted like `metadata.foo`
    const effectiveKey = lowered.includes(".") ? lowered.split(".").pop() : lowered;

    if (candidates.some((c) => effectiveKey.includes(c))) {
      const val = obj[key];
      if (val !== null && val !== undefined && val !== "") return val;
    }
  }
  return null;
}

function toRow(listModel, metadata) {
  const { publisher, modelName } = splitModelId(listModel.id);
  const row = {
    modelId: listModel.id,
    publisher,
    listObject: listModel.object
  };

  flattenObject(metadata, row, "metadata");
  delete row["metadata.created"];
  delete row["metadata.owned_by"];

  row.contextLength = findValueByKeyCandidates(row, [
    "context_length",
    "contextlength",
    "context_window",
    "contextwindow",
    "max_input_tokens",
    "maxinputtokens",
    "input_token_limit"
  ]) || "Not Tested";

  row.maxOutputTokens = findValueByKeyCandidates(row, [
    "max_output_tokens",
    "maxoutputtokens",
    "output_token_limit",
    "max_tokens",
    "completion_token_limit"
  ]) || "Not Tested";

  row.liveTest = "Test"; // Placeholder for the frontend button
  row.latencyMs = ""; // Populated by live test
  row.testedAt = ""; // Populated by live test

  return row;
}

const NEGATIVE_STATUS_VALUES = new Set([
  "inactive",
  "disabled",
  "deprecated",
  "retired",
  "archived",
  "deleted",
  "unavailable",
  "not_available",
  "notavailable",
  "blocked",
  "suspended",
  "offline",
  "error",
  "failed",
  "unsupported",
  "not_supported",
  "notsupported",
  "removed",
  "sunset"
]);

function hasAnyToken(source, tokens) {
  return tokens.some((token) => source.includes(token));
}

function getBooleanLike(rawValue) {
  if (typeof rawValue === "boolean") {
    return rawValue;
  }

  if (typeof rawValue === "number") {
    if (rawValue === 0) return false;
    if (rawValue === 1) return true;
  }

  const normalized = String(rawValue).trim().toLowerCase().replace(/\s+/g, "_");

  if (
    [
      "true",
      "1",
      "yes",
      "on",
      "active",
      "enabled",
      "available",
      "ready",
      "supported",
      "ok",
      "online",
      "live",
      "ga",
      "general_availability"
    ].includes(normalized)
  ) {
    return true;
  }

  if (
    [
      "false",
      "0",
      "no",
      "off",
      "inactive",
      "disabled",
      "unavailable",
      "unsupported",
      "deprecated",
      "retired",
      "archived",
      "deleted",
      "blocked",
      "suspended",
      "offline"
    ].includes(normalized)
  ) {
    return false;
  }

  return null;
}

function isActiveUsableRow(row) {
  if (row.metadataError) {
    return false;
  }

  for (const [key, rawValue] of Object.entries(row)) {
    if (rawValue === null || rawValue === undefined || rawValue === "") {
      continue;
    }

    const lowerKey = key.toLowerCase();
    const isStatusLike = hasAnyToken(lowerKey, [
      "status",
      "state",
      "lifecycle",
      "phase",
      "availability",
      "available",
      "active",
      "enabled",
      "ready",
      "supported",
      "usable",
      "deprecated",
      "deprecation",
      "retired",
      "archived",
      "sunset",
      "disabled"
    ]);

    if (!isStatusLike) {
      continue;
    }

    const normalizedValue = String(rawValue).trim().toLowerCase().replace(/\s+/g, "_");
    const boolLike = getBooleanLike(rawValue);

    if (hasAnyToken(lowerKey, ["deprecated", "deprecation", "retired", "archived", "sunset"])) {
      if (boolLike === true) {
        return false;
      }

      if (
        NEGATIVE_STATUS_VALUES.has(normalizedValue) ||
        normalizedValue.includes("deprecat") ||
        normalizedValue.includes("retir") ||
        normalizedValue.includes("archiv")
      ) {
        return false;
      }

      continue;
    }

    if (hasAnyToken(lowerKey, ["active", "enabled", "available", "ready", "supported", "usable", "disabled"])) {
      if (boolLike === false) {
        return false;
      }

      if (NEGATIVE_STATUS_VALUES.has(normalizedValue)) {
        return false;
      }

      continue;
    }

    if (hasAnyToken(lowerKey, ["status", "state", "lifecycle", "phase", "availability"])) {
      if (NEGATIVE_STATUS_VALUES.has(normalizedValue)) {
        return false;
      }
    }
  }

  return true;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const currentIndex = cursor;
      cursor += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );

  await Promise.all(workers);
  return results;
}

function buildColumns(rows) {
  const pinned = [
    "liveTest",
    "modelId",
    "publisher",
    "contextLength",
    "maxOutputTokens",
    "latencyMs",
    "testedAt"
  ];

  const hiddenFields = new Set([
    "metadata.id",
    "metadata.object",
    "listObject"
  ]);

  const keySet = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!hiddenFields.has(key)) {
        keySet.add(key);
      }
    }
  }

  const remaining = [...keySet]
    .filter((key) => !pinned.includes(key))
    .sort((a, b) => a.localeCompare(b));

  return [...pinned, ...remaining];
}

async function loadModelsWithMetadata({ forceRefresh = false } = {}) {
  const now = Date.now();

  if (!forceRefresh && cache.payload && now < cache.expiresAt) {
    return cache.payload;
  }

  if (cache.inFlight) {
    return cache.inFlight;
  }

  cache.inFlight = (async () => {
    let testCache = {};
    try {
      const cacheFilePath = path.join(__dirname, "model_limits_cache.json");
      if (fs.existsSync(cacheFilePath)) {
        testCache = JSON.parse(fs.readFileSync(cacheFilePath, "utf8"));
      }
    } catch (e) { }

    const list = await listAllModels();

    const allRows = await mapWithConcurrency(list, MAX_CONCURRENCY, async (listModel) => {
      try {
        const metadata = await getModelMetadata(listModel.id);
        const row = toRow(listModel, metadata);

        // Inject cached test results if available
        const tc = testCache[row.modelId];
        if (tc && tc.contextLength != null) {
          row.contextLength = tc.contextLength;
          row.maxOutputTokens = tc.maxOutputTokens;
          row.latencyMs = tc.latencyMs >= 0 ? tc.latencyMs : "";
          row.testedAt = tc.testedAt || "";
          
          if (tc.contextLength === "Error") {
            row.liveTest = "Error";
          } else if (tc.isAvailable) {
            row.liveTest = `${tc.latencyMs}ms (OK)`;
          } else {
            row.liveTest = "Inactive";
          }
        }

        return row;
      } catch (error) {
        return {
          modelId: listModel.id,
          publisher: splitModelId(listModel.id).publisher,
          modelName: splitModelId(listModel.id).modelName,
          listObject: listModel.object,
          listCreated: listModel.created,
          listOwnedBy: listModel.owned_by,
          metadataError: error.message
        };
      }
    });

    const rows = allRows.filter((row) => isActiveUsableRow(row));

    const payload = {
      fetchedAt: new Date().toISOString(),
      modelCount: rows.length,
      totalModelCount: allRows.length,
      filteredOutCount: allRows.length - rows.length,
      apiKeyConfigured: Boolean(getApiKey()),
      columns: buildColumns(rows),
      rows
    };

    cache.payload = payload;
    cache.expiresAt = Date.now() + CACHE_TTL_MS;
    return payload;
  })();

  try {
    return await cache.inFlight;
  } finally {
    cache.inFlight = null;
  }
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    now: new Date().toISOString(),
    apiKeyConfigured: Boolean(getApiKey())
  });
});

app.get("/api/models-with-metadata", async (req, res) => {
  const forceRefresh = req.query.refresh === "1";

  try {
    const payload = await loadModelsWithMetadata({ forceRefresh });
    res.json(payload);
  } catch (error) {
    res.status(500).json({
      error: "Failed to load models with metadata",
      message: error.message
    });
  }
});

app.post("/api/reset-cache", express.json(), (req, res) => {
  const { models } = req.body;
  if (!Array.isArray(models)) return res.status(400).json({ error: "models array required" });

  try {
    const cacheFile = path.join(__dirname, "model_limits_cache.json");
    let testCache = {};
    if (fs.existsSync(cacheFile)) {
      testCache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    }

    let modified = false;
    for (const modelId of models) {
      if (testCache[modelId]) {
        delete testCache[modelId];
        modified = true;
      }
    }

    if (modified) {
      fs.writeFileSync(cacheFile, JSON.stringify(testCache, null, 2), "utf8");
      cache.payload = null; // Invalidate memory cache
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Failed to reset cache:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/test-model", async (req, res) => {
  const modelId = req.query.model;
  if (!modelId) return res.status(400).json({ error: "Missing model parameter" });

  const url = `${API_BASE_URL}/chat/completions`;
  const headers = getRequestHeaders();

  let latencyMs = -1;
  let isAvailable = false;
  let contextLength = null;
  let maxOutputTokens = null;

  try {
    // 1. Test Latency & Availability
    const start = Date.now();
    const timeoutSmall = withTimeout(null, 15000);
    const rSmall = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1
      }),
      signal: timeoutSmall.signal
    });
    timeoutSmall.clear();

    // Some models may reject even simple requests if permission is wrong, but 200 means active
    isAvailable = rSmall.ok;

    // Always consume the body
    await rSmall.text();
    latencyMs = Date.now() - start;

    // 2. Test Context Length and Tokens via out of bounds error scraping
    const timeoutLimit = withTimeout(null, 15000);
    const rLimit = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 99999999
      }),
      signal: timeoutLimit.signal
    });

    const errorBody = await rLimit.text();
    timeoutLimit.clear();
    if (!rLimit.ok && errorBody) {
      // Common Context length phrases
      const ctxMatch = errorBody.match(/context length (?:is|of) (\d+)/i) ||
        errorBody.match(/max_model_len=max_total_tokens=(\d+)/i);
      if (ctxMatch) contextLength = parseInt(ctxMatch[1], 10);

      // Common token limit phrases
      const outMatch = errorBody.match(/generate up to (\d+) tokens/i) ||
        errorBody.match(/maximum of (\d+) tokens/i) ||
        errorBody.match(/supports at most (\d+) completion tokens/i) ||
        errorBody.match(/Maximum allowed output length is (\d+)/i) ||
        errorBody.match(/max_tokens must be at most (\d+)/i) ||
        errorBody.match(/less than or equal to (\d+)/i) ||
        errorBody.match(/max_tokens must be between \d+ and (\d+)/i);
      if (outMatch) maxOutputTokens = parseInt(outMatch[1], 10);

      // If we found a max_model_len which implies the total limit, we can fallback that to context
      if (!contextLength && errorBody.includes("max_model_len") && errorBody.match(/max_model_len=\s*(\d+)/i)) {
        contextLength = parseInt(errorBody.match(/max_model_len=\s*(\d+)/i)[1], 10);
      }
    } else if (rLimit.ok) {
      // Model accepted the oversized max_tokens without error — no enforced limit
      if (!contextLength) contextLength = "No Limit Reported";
      if (!maxOutputTokens) maxOutputTokens = "No Limit Reported";
    }

    // Fallback guess: if we found contextLength but not maxOutput, it's often min(4096, contextLength)
    if (contextLength && !maxOutputTokens) maxOutputTokens = Math.min(4096, contextLength);
    // Conversely, if we found max completion tokens but not context, context is at least that size.
    if (!contextLength && maxOutputTokens) contextLength = maxOutputTokens;

  } catch (error) {
    // Even on error, save the result so it's not lost on reload
    const errResult = {
      modelId,
      latencyMs: -1,
      isAvailable: false,
      contextLength: "Error",
      maxOutputTokens: "Error",
      testedAt: new Date().toLocaleString()
    };
    try {
      const cacheFile = path.join(__dirname, "model_limits_cache.json");
      let testCache = {};
      if (fs.existsSync(cacheFile)) {
        testCache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      }
      testCache[modelId] = errResult;
      fs.writeFileSync(cacheFile, JSON.stringify(testCache, null, 2), "utf8");
      cache.payload = null;
    } catch (e) {
      console.error("Failed to save error test cache:", e.message);
    }
    return res.json(errResult);
  }

  const fallbackLabel = isAvailable ? "Unknown" : "Inactive";
  const result = {
    modelId,
    latencyMs,
    isAvailable,
    contextLength: contextLength || fallbackLabel,
    maxOutputTokens: maxOutputTokens || fallbackLabel,
    testedAt: new Date().toLocaleString()
  };

  // Persist result to cache file
  try {
    const cacheFile = path.join(__dirname, "model_limits_cache.json");
    let testCache = {};
    if (fs.existsSync(cacheFile)) {
      testCache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    }
    testCache[modelId] = result;
    fs.writeFileSync(cacheFile, JSON.stringify(testCache, null, 2), "utf8");
    // Invalidate the in-memory models payload so the next refresh picks up the new cache
    cache.payload = null;
  } catch (e) {
    console.error("Failed to save test cache:", e.message);
  }

  res.json(result);
});

app.listen(PORT, () => {
  const appUrl = `http://localhost:${PORT}`;
  const hasKey = Boolean(getApiKey());

  console.log(`nvidia-model-info server started at ${appUrl}`);
  console.log(
    hasKey
      ? `Using API key from environment variable ${API_KEY_ENV_NAME}`
      : `Environment variable ${API_KEY_ENV_NAME} is not set. Requests will continue without Authorization.`
  );

  launchBrowser(appUrl);
});
