const express = require("express");
const path = require("node:path");
const fs = require("node:fs");
const { exec } = require("node:child_process");

const API_KEY_ENV_NAME = "NVIDIA_API_KEY";

const app = express();

const PORT = Number(process.env.PORT || 4920);
const API_BASE_URL = "https://integrate.api.nvidia.com/v1";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
const MAX_CONCURRENCY = Math.max(1, Number(process.env.MAX_CONCURRENCY || 12));
const CACHE_TTL_MS = Math.max(1000, Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000));
const PROBE_RATE_LIMIT_RPM = Math.max(1, Number(process.env.PROBE_RATE_LIMIT_RPM || 36));
const PROBE_MIN_INTERVAL_MS = Math.max(
  250,
  Number(process.env.PROBE_MIN_INTERVAL_MS || Math.ceil(60000 / PROBE_RATE_LIMIT_RPM))
);
const PROBE_TIMEOUT_MS = Math.max(1000, Number(process.env.PROBE_TIMEOUT_MS || 15000));
const TOOL_SUPPORT_TIMEOUT_MS = Math.max(1000, Number(process.env.TOOL_SUPPORT_TIMEOUT_MS || 25000));
const PROBE_MAX_429_RETRIES = Math.max(0, Number(process.env.PROBE_MAX_429_RETRIES || 2));
const PROBE_429_BACKOFF_MS = Math.max(1000, Number(process.env.PROBE_429_BACKOFF_MS || 10000));

if (typeof fetch !== "function") {
  throw new Error("This app requires Node.js 18+ (global fetch is missing).");
}

const cache = {
  expiresAt: 0,
  payload: null,
  inFlight: null,
  loadToken: 0
};

let probeRateLimitChain = Promise.resolve();
let nextProbeSlotAt = 0;

const TOOL_SUPPORT_PROMPT =
  "Call the tool exactly once with location set to Calgary. Do not answer normally. Return immediately with the tool call and no extra reasoning.";
const TOOL_SUPPORT_MAX_TOKENS = 64;
const TOOL_SUPPORT_RETRY_MAX_TOKENS = 192;
const METADATA_CONTEXT_KEY_CANDIDATES = [
  "context_length",
  "contextlength",
  "context_window",
  "contextwindow",
  "max_input_tokens",
  "maxinputtokens",
  "input_token_limit"
];
const METADATA_OUTPUT_KEY_CANDIDATES = [
  "max_output_tokens",
  "maxoutputtokens",
  "output_token_limit",
  "max_tokens",
  "completion_token_limit"
];
const TOOL_SUPPORT_FUNCTION_SCHEMA = {
  name: "get_weather",
  description: "Get weather for a location.",
  parameters: {
    type: "object",
    properties: {
      location: {
        type: "string"
      }
    },
    required: ["location"]
  }
};
const TOOL_SUPPORT_TOOL_SCHEMA = {
  type: "function",
  function: TOOL_SUPPORT_FUNCTION_SCHEMA
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

function parseResponseBodyText(bodyText) {
  if (!bodyText) {
    return undefined;
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function reserveProbeSlot() {
  const reservation = probeRateLimitChain.then(async () => {
    const waitMs = Math.max(0, nextProbeSlotAt - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    nextProbeSlotAt = Date.now() + PROBE_MIN_INTERVAL_MS;
  });

  probeRateLimitChain = reservation.catch(() => {});
  return reservation;
}

function extendProbeBackoffWindow(waitMs) {
  nextProbeSlotAt = Math.max(nextProbeSlotAt, Date.now() + waitMs);
}

function getRetryDelayMs(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }

    const absolute = Date.parse(retryAfter);
    if (Number.isFinite(absolute)) {
      const delta = absolute - Date.now();
      if (delta > 0) {
        return delta;
      }
    }
  }

  return PROBE_429_BACKOFF_MS * Math.pow(2, attempt);
}

async function postProbeRequest(url, headers, payload, { modelId, purpose, timeoutMs }) {
  let attempt = 0;

  while (true) {
    await reserveProbeSlot();
    const timeoutWrap = withTimeout(null, timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: timeoutWrap.signal
      });

      const bodyText = await response.text();
      const body = parseResponseBodyText(bodyText);

      if (response.status === 429 && attempt < PROBE_MAX_429_RETRIES) {
        const waitMs = getRetryDelayMs(response, attempt);
        extendProbeBackoffWindow(waitMs);
        console.warn(
          `${purpose} probe hit 429 for ${modelId}; waiting ${waitMs}ms before retry ${attempt + 1}/${PROBE_MAX_429_RETRIES}`
        );
        attempt += 1;
        await sleep(waitMs);
        continue;
      }

      return {
        response,
        bodyText,
        body,
        rateLimited: response.status === 429,
        attempts: attempt + 1
      };
    } finally {
      timeoutWrap.clear();
    }
  }
}

function invalidateCachedPayload({ dropInFlight = false } = {}) {
  cache.payload = null;
  cache.expiresAt = 0;
  cache.loadToken += 1;

  if (dropInFlight) {
    cache.inFlight = null;
  }
}

function clearAllCachedData() {
  const cacheFile = path.join(__dirname, "model_limits_cache.json");
  fs.writeFileSync(cacheFile, "{}\n", "utf8");
  invalidateCachedPayload({ dropInFlight: true });
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
    const body = parseResponseBodyText(bodyText);

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

function findValueByKeyCandidates(obj, candidates, { keyPrefix = "" } = {}) {
  const keys = Object.keys(obj);
  for (const key of keys) {
    if (keyPrefix && !key.startsWith(keyPrefix)) {
      continue;
    }

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

function parseTokenCount(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().replace(/,/g, "");
  if (!normalized) {
    return null;
  }

  const compact = normalized.replace(/\s+/g, "");
  const compactMatch = compact.match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
  if (compactMatch) {
    const amount = Number(compactMatch[1]);
    const suffix = compactMatch[2] ? compactMatch[2].toLowerCase() : "";
    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }

    if (suffix === "k") return Math.round(amount * 1024);
    if (suffix === "m") return Math.round(amount * 1024 * 1024);
    if (suffix === "b") return Math.round(amount * 1024 * 1024 * 1024);
    return Math.round(amount);
  }

  const embeddedMatch = normalized.match(/(\d+(?:\.\d+)?)\s*([kmb])\b/i);
  if (embeddedMatch) {
    const amount = Number(embeddedMatch[1]);
    const suffix = embeddedMatch[2].toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }

    if (suffix === "k") return Math.round(amount * 1024);
    if (suffix === "m") return Math.round(amount * 1024 * 1024);
    if (suffix === "b") return Math.round(amount * 1024 * 1024 * 1024);
  }

  return null;
}

function getCachedMetadataTokenHints(modelId) {
  const rows = cache.payload && Array.isArray(cache.payload.rows) ? cache.payload.rows : null;
  if (!rows) {
    return {
      contextLength: null,
      maxOutputTokens: null
    };
  }

  const row = rows.find((item) => item.modelId === modelId);
  if (!row) {
    return {
      contextLength: null,
      maxOutputTokens: null
    };
  }

  return {
    contextLength: parseTokenCount(
      findValueByKeyCandidates(row, METADATA_CONTEXT_KEY_CANDIDATES, { keyPrefix: "metadata." })
    ),
    maxOutputTokens: parseTokenCount(
      findValueByKeyCandidates(row, METADATA_OUTPUT_KEY_CANDIDATES, { keyPrefix: "metadata." })
    )
  };
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
  row.toolSupport = ""; // Populated by live test
  row.toolSupportChecked = false; // Internal marker used to decide whether re-testing is needed
  row.toolSupportReason = ""; // Internal classification of the latest tool probe result
  row.toolSupportSummary = ""; // Internal summary kept for diagnostics/tooltips
  row.rateLimited = false; // Internal marker for non-terminal 429 probe results
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
    "toolSupport",
    "testedAt"
  ];

  const hiddenFields = new Set([
    "metadata.id",
    "metadata.object",
    "listObject",
    "toolSupportChecked",
    "toolSupportReason",
    "toolSupportSummary",
    "rateLimited"
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

  if (!forceRefresh && cache.inFlight) {
    return cache.inFlight;
  }

  const loadToken = cache.loadToken + 1;
  cache.loadToken = loadToken;

  const currentPromise = (async () => {
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
          row.toolSupport = tc.toolSupportChecked ? Boolean(tc.toolSupport) : "";
          row.toolSupportChecked = Boolean(tc.toolSupportChecked);
          row.toolSupportReason = tc.toolSupportReason || "";
          row.toolSupportSummary = tc.toolSupportSummary || "";
          row.rateLimited = Boolean(tc.rateLimited);
          row.testedAt = tc.testedAt || "";
          
          if (tc.rateLimited || tc.contextLength === "Rate Limited" || tc.maxOutputTokens === "Rate Limited") {
            row.liveTest = tc.isAvailable && tc.latencyMs >= 0 ? `${tc.latencyMs}ms (OK)` : "Rate Limited";
          } else if (tc.contextLength === "Error") {
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

    if (cache.loadToken === loadToken) {
      cache.payload = payload;
      cache.expiresAt = Date.now() + CACHE_TTL_MS;
    }

    return payload;
  })();

  cache.inFlight = currentPromise;

  try {
    return await currentPromise;
  } finally {
    if (cache.inFlight === currentPromise) {
      cache.inFlight = null;
    }
  }
}

function persistTestResult(modelId, result) {
  try {
    const cacheFile = path.join(__dirname, "model_limits_cache.json");
    let testCache = {};
    if (fs.existsSync(cacheFile)) {
      testCache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    }
    testCache[modelId] = result;
    fs.writeFileSync(cacheFile, JSON.stringify(testCache, null, 2), "utf8");
    invalidateCachedPayload();
  } catch (e) {
    console.error("Failed to save test cache:", e.message);
  }
}

function hasToolCallInResponse(body) {
  if (!body || typeof body !== "object") {
    return false;
  }

  const choice = Array.isArray(body.choices) ? body.choices[0] : null;
  const message = choice && choice.message && typeof choice.message === "object" ? choice.message : null;
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

  return toolCalls.length > 0 || Boolean(message?.function_call);
}

function shouldRetryAcceptedToolProbe(body) {
  if (!body || typeof body !== "object") {
    return false;
  }

  const choice = Array.isArray(body.choices) ? body.choices[0] : null;
  if (!choice || typeof choice !== "object") {
    return false;
  }

  if (choice.finish_reason !== "length") {
    return false;
  }

  const message = choice.message && typeof choice.message === "object" ? choice.message : null;
  const signals = [
    message?.reasoning,
    message?.reasoning_content,
    message?.content
  ]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();

  return /tool call|call the tool|function call|get_weather|tool invocation/.test(signals);
}

function getErrorText(body, bodyText) {
  if (typeof body === "string") {
    return body;
  }

  if (bodyText) {
    return bodyText;
  }

  return JSON.stringify(body ?? {});
}

function buildRateLimitedResult(modelId, { latencyMs = -1, isAvailable = false } = {}) {
  return {
    modelId,
    latencyMs,
    isAvailable,
    rateLimited: true,
    contextLength: "Rate Limited",
    maxOutputTokens: "Rate Limited",
    toolSupport: "",
    toolSupportChecked: false,
    toolSupportReason: "rate_limited",
    toolSupportSummary: "",
    testedAt: new Date().toLocaleString()
  };
}

function summarizeErrorText(text, maxLength = 220) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function classifyAvailabilityError(status, errorText) {
  const normalized = String(errorText || "").toLowerCase();

  if (status === 429 || /too many requests/i.test(normalized)) {
    return "rate_limited";
  }

  if (/timed out/i.test(normalized)) {
    return "timeout";
  }

  if (
    status >= 500 ||
    /internal server error/i.test(normalized) ||
    /enginecore encountered an issue/i.test(normalized) ||
    /inference connection error/i.test(normalized)
  ) {
    return "backend_error";
  }

  if (
    status === 401 ||
    status === 403 ||
    /unauthorized/i.test(normalized) ||
    /forbidden/i.test(normalized) ||
    /invalid api key/i.test(normalized) ||
    /authentication/i.test(normalized)
  ) {
    return "auth_error";
  }

  if (
    status === 404 ||
    /does not exist/i.test(normalized) ||
    /not found/i.test(normalized) ||
    /model .* unsupported/i.test(normalized) ||
    /unsupported by/i.test(normalized) ||
    /not currently supported/i.test(normalized)
  ) {
    return "unavailable";
  }

  if (
    (status === 400 || status === 422) &&
    (
      /chat/i.test(normalized) ||
      /completion/i.test(normalized) ||
      /model/i.test(normalized) ||
      /messages/i.test(normalized) ||
      /max_tokens/i.test(normalized)
    )
  ) {
    return "unavailable";
  }

  return "request_error";
}

function classifyToolSupportError(status, errorText) {
  const normalized = String(errorText || "").toLowerCase();
  const mentionsToolFields =
    /(tools|tool_choice|function_call|functions|tool use|tool[_ ]?calls?)/i.test(normalized);

  if (status === 429 || /too many requests/i.test(normalized)) {
    return "rate_limited";
  }

  if (
    status >= 500 ||
    /internal server error/i.test(normalized) ||
    /enginecore encountered an issue/i.test(normalized) ||
    /inference connection error/i.test(normalized)
  ) {
    return "backend_error";
  }

  if (/timed out/i.test(normalized)) {
    return "timeout";
  }

  if (
    /tool use has not been enabled/i.test(normalized) ||
    (/unsupported by/i.test(normalized) && mentionsToolFields) ||
    /tool(s)? (is|are)? not (enabled|supported|available)/i.test(normalized) ||
    /tool[_ ]?calls? (is|are)? not (enabled|supported|available)/i.test(normalized) ||
    /does not support tool/i.test(normalized) ||
    /does not support function/i.test(normalized) ||
    /function calling (is|not)? ?supported/i.test(normalized) ||
    /tool_choice.*not supported/i.test(normalized) ||
    /unsupported.*tool/i.test(normalized) ||
    /unsupported.*function/i.test(normalized) ||
    /parameter [`'"]?(tools|tool_choice|functions|function_call)[`'"]? is not currently supported/i.test(normalized) ||
    /unknown parameter ['"`]?(tools|tool_choice|functions|function_call)['"`]?/i.test(normalized) ||
    ((/extra inputs are not permitted/i.test(normalized) || /extra_forbidden/i.test(normalized)) &&
      /(tools|tool_choice|functions|function_call)/i.test(normalized)) ||
    /enable-auto-tool-choice/i.test(normalized) ||
    /tool-call-parser/i.test(normalized)
  ) {
    return "unsupported";
  }

  return "inconclusive";
}

function buildToolSupportResult({
  toolSupport,
  toolSupportChecked,
  toolSupportReason,
  toolSupportSummary = "",
  rateLimited = false
}) {
  return {
    toolSupport,
    toolSupportChecked,
    toolSupportReason,
    toolSupportSummary,
    rateLimited
  };
}

function getToolSupportProbePayloads(modelId) {
  const basePayload = {
    model: modelId,
    messages: [
      {
        role: "user",
        content: TOOL_SUPPORT_PROMPT
      }
    ],
    max_tokens: TOOL_SUPPORT_MAX_TOKENS
  };

  return [
    {
      name: "tools-only",
      payload: {
        ...basePayload,
        tools: [TOOL_SUPPORT_TOOL_SCHEMA]
      }
    },
    {
      name: "auto-tool-choice",
      payload: {
        ...basePayload,
        tools: [TOOL_SUPPORT_TOOL_SCHEMA],
        tool_choice: "auto"
      }
    },
    {
      name: "forced-tool-choice",
      payload: {
        ...basePayload,
        tools: [TOOL_SUPPORT_TOOL_SCHEMA],
        tool_choice: {
          type: "function",
          function: {
            name: TOOL_SUPPORT_FUNCTION_SCHEMA.name
          }
        }
      }
    },
    {
      name: "legacy-function-call",
      payload: {
        ...basePayload,
        functions: [TOOL_SUPPORT_FUNCTION_SCHEMA],
        function_call: {
          name: TOOL_SUPPORT_FUNCTION_SCHEMA.name
        }
      }
    }
  ];
}

function clonePayloadWithMaxTokens(payload, maxTokens) {
  return {
    ...payload,
    max_tokens: maxTokens
  };
}

function extractFirstMatchingNumber(text, patterns) {
  const haystack = String(text || "");
  for (const pattern of patterns) {
    const match = haystack.match(pattern);
    if (!match) {
      continue;
    }

    const parsed = parseTokenCount(match[1]);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

async function probeToolSupport(url, headers, modelId) {
  const attempts = [];
  let sawAcceptedNoToolCall = false;
  let sawUnsupported = false;
  let sawBackendError = false;
  let sawTimeout = false;
  let sawInconclusive = false;
  let sawRateLimited = false;

  for (const variant of getToolSupportProbePayloads(modelId)) {
    try {
      let toolProbe = await postProbeRequest(url, headers, variant.payload, {
        modelId,
        purpose: `Tool support (${variant.name})`,
        timeoutMs: TOOL_SUPPORT_TIMEOUT_MS
      });

      if (
        toolProbe.response.ok &&
        !hasToolCallInResponse(toolProbe.body) &&
        shouldRetryAcceptedToolProbe(toolProbe.body)
      ) {
        attempts.push(
          `${variant.name}: accepted request but hit length limit; retrying with ${TOOL_SUPPORT_RETRY_MAX_TOKENS} max_tokens`
        );
        toolProbe = await postProbeRequest(
          url,
          headers,
          clonePayloadWithMaxTokens(variant.payload, TOOL_SUPPORT_RETRY_MAX_TOKENS),
          {
            modelId,
            purpose: `Tool support retry (${variant.name})`,
            timeoutMs: TOOL_SUPPORT_TIMEOUT_MS
          }
        );
      }

      if (toolProbe.rateLimited) {
        sawRateLimited = true;
        attempts.push(`${variant.name}: rate limited`);
        continue;
      }

      if (toolProbe.response.ok) {
        if (hasToolCallInResponse(toolProbe.body)) {
          return buildToolSupportResult({
            toolSupport: true,
            toolSupportChecked: true,
            toolSupportReason: "supported"
          });
        }

        sawAcceptedNoToolCall = true;
        attempts.push(`${variant.name}: accepted request but returned no tool call`);
        continue;
      }

      const toolErrorText = getErrorText(toolProbe.body, toolProbe.bodyText);
      const classification = classifyToolSupportError(toolProbe.response.status, toolErrorText);

      if (classification === "unsupported") {
        sawUnsupported = true;
        attempts.push(`${variant.name}: unsupported ${summarizeErrorText(toolErrorText, 120)}`);
        continue;
      }

      if (classification === "backend_error") {
        sawBackendError = true;
      } else {
        sawInconclusive = true;
      }

      attempts.push(
        `${variant.name}: ${classification} ${summarizeErrorText(toolErrorText, 120)}`
      );
    } catch (toolError) {
      const classification = classifyToolSupportError(0, toolError.message);
      if (classification === "timeout") {
        sawTimeout = true;
      } else if (classification === "backend_error") {
        sawBackendError = true;
      } else {
        sawInconclusive = true;
      }

      attempts.push(`${variant.name}: ${classification} ${summarizeErrorText(toolError.message, 120)}`);
    }
  }

  const summary = attempts.join(" | ");

  if (sawAcceptedNoToolCall && !sawRateLimited && !sawBackendError && !sawTimeout && !sawInconclusive) {
    return buildToolSupportResult({
      toolSupport: false,
      toolSupportChecked: true,
      toolSupportReason: "no_tool_call_observed",
      toolSupportSummary: summary
    });
  }

  if (sawUnsupported && !sawRateLimited && !sawBackendError && !sawTimeout && !sawInconclusive) {
    return buildToolSupportResult({
      toolSupport: false,
      toolSupportChecked: true,
      toolSupportReason: "unsupported",
      toolSupportSummary: summary
    });
  }

  if (sawRateLimited) {
    return buildToolSupportResult({
      toolSupport: "",
      toolSupportChecked: false,
      toolSupportReason: "rate_limited",
      toolSupportSummary: summary,
      rateLimited: true
    });
  }

  const reason = sawTimeout ? "timeout" : sawBackendError ? "backend_error" : "inconclusive";
  if (summary) {
    console.warn(`Tool support probe ${reason} for ${modelId}: ${summary}`);
  }

  return buildToolSupportResult({
    toolSupport: "",
    toolSupportChecked: false,
    toolSupportReason: reason,
    toolSupportSummary: summary
  });
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

app.post("/api/reset-all-cache", (_req, res) => {
  try {
    clearAllCachedData();
    res.json({ success: true });
  } catch (err) {
    console.error("Failed to reset all cache:", err);
    res.status(500).json({ error: err.message });
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
      invalidateCachedPayload();
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
  const metadataTokenHints = getCachedMetadataTokenHints(modelId);

  let latencyMs = -1;
  let isAvailable = false;
  let contextLength = metadataTokenHints.contextLength;
  let maxOutputTokens = metadataTokenHints.maxOutputTokens;
  let toolSupport = "";
  let toolSupportChecked = false;
  let toolSupportReason = "";
  let toolSupportSummary = "";
  let rateLimited = false;
  let unavailableLabel = "Inactive";

  try {
    // 1. Test Latency & Availability
    const start = Date.now();
    const smallProbe = await postProbeRequest(
      url,
      headers,
      {
        model: modelId,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1
      },
      {
        modelId,
        purpose: "Availability",
        timeoutMs: PROBE_TIMEOUT_MS
      }
    );

    // Some models may reject even simple requests if permission is wrong, but 200 means active
    isAvailable = smallProbe.response.ok;
    latencyMs = Date.now() - start;

    if (smallProbe.rateLimited) {
      const rateLimitedResult = buildRateLimitedResult(modelId);
      persistTestResult(modelId, rateLimitedResult);
      return res.json(rateLimitedResult);
    }

    if (!isAvailable) {
      const availabilityErrorText = getErrorText(smallProbe.body, smallProbe.bodyText);
      const availabilityReason = classifyAvailabilityError(smallProbe.response.status, availabilityErrorText);
      unavailableLabel = availabilityReason === "unavailable" ? "Inactive" : "Error";

      const unavailableResult = {
        modelId,
        latencyMs,
        isAvailable: false,
        rateLimited: false,
        contextLength: unavailableLabel,
        maxOutputTokens: unavailableLabel,
        toolSupport: "",
        toolSupportChecked: false,
        toolSupportReason: "",
        toolSupportSummary: "",
        testedAt: new Date().toLocaleString()
      };

      if (availabilityReason !== "unavailable") {
        console.warn(
          `Availability probe ${availabilityReason} for ${modelId}: ${summarizeErrorText(availabilityErrorText)}`
        );
      }

      persistTestResult(modelId, unavailableResult);
      return res.json(unavailableResult);
    }

    if (isAvailable) {
      const needsLimitProbe = !(typeof contextLength === "number" && typeof maxOutputTokens === "number");

      if (needsLimitProbe) {
        // 2. Test Context Length and Tokens via out of bounds error scraping
        const limitProbe = await postProbeRequest(
          url,
          headers,
          {
            model: modelId,
            messages: [{ role: "user", content: "Hi" }],
            max_tokens: 99999999
          },
          {
            modelId,
            purpose: "Limit",
            timeoutMs: PROBE_TIMEOUT_MS
          }
        );

        const errorBody = limitProbe.bodyText || "";
        if (limitProbe.rateLimited) {
          rateLimited = true;
          if (contextLength == null) {
            contextLength = "Rate Limited";
          }
          if (maxOutputTokens == null) {
            maxOutputTokens = "Rate Limited";
          }
        } else if (!limitProbe.response.ok && errorBody) {
          const parsedContextLength = extractFirstMatchingNumber(errorBody, [
            /context length (?:is|of) (\d+)/i,
            /maximum context length is (\d+)/i,
            /supports up to (\d+) input tokens/i,
            /max_model_len=max_total_tokens=(\d+)/i,
            /max_model_len=\s*(\d+)/i,
            /maximum total tokens(?: is| are)? (\d+)/i,
            /input (?:sequence )?length .*? exceeds .*?(\d+)/i
          ]);
          if (parsedContextLength && contextLength == null) {
            contextLength = parsedContextLength;
          }

          const parsedMaxOutputTokens = extractFirstMatchingNumber(errorBody, [
            /generate up to (\d+) tokens/i,
            /maximum of (\d+) tokens/i,
            /supports at most (\d+) completion tokens/i,
            /maximum allowed output length is (\d+)/i,
            /max_tokens must be at most (\d+)/i,
            /max_tokens must be between \d+ and (\d+)/i,
            /output tokens .*? (\d+)/i,
            /completion tokens .*? (\d+)/i,
            /less than or equal to (\d+)/i
          ]);
          if (parsedMaxOutputTokens && maxOutputTokens == null) {
            maxOutputTokens = parsedMaxOutputTokens;
          }
        } else if (limitProbe.response.ok) {
          // Model accepted the oversized max_tokens without error - no enforced limit exposed by probing.
          if (contextLength == null) {
            contextLength = "No Limit Reported";
          }
          if (maxOutputTokens == null) {
            maxOutputTokens = "No Limit Reported";
          }
        }
      }

      // Fallback guess: if we found contextLength but not maxOutput, it's often min(4096, contextLength)
      if (typeof contextLength === "number" && !maxOutputTokens) {
        maxOutputTokens = Math.min(4096, contextLength);
      }
      // Conversely, if we found max completion tokens but not context, context is at least that size.
      if (!contextLength && typeof maxOutputTokens === "number") {
        contextLength = maxOutputTokens;
      }

      // 3. Probe explicit function/tool calling support.
      if (!rateLimited) {
        const toolProbeResult = await probeToolSupport(url, headers, modelId);
        rateLimited = toolProbeResult.rateLimited;
        toolSupport = toolProbeResult.toolSupport;
        toolSupportChecked = toolProbeResult.toolSupportChecked;
        toolSupportReason = toolProbeResult.toolSupportReason;
        toolSupportSummary = toolProbeResult.toolSupportSummary;
      }
    }

  } catch (error) {
    // Even on error, save the result so it's not lost on reload
    const errResult = {
      modelId,
      latencyMs: -1,
      isAvailable: false,
      rateLimited: false,
      contextLength: "Error",
      maxOutputTokens: "Error",
      toolSupport: "",
      toolSupportChecked: false,
      toolSupportReason: "request_error",
      toolSupportSummary: summarizeErrorText(error.message),
      testedAt: new Date().toLocaleString()
    };
    persistTestResult(modelId, errResult);
    return res.json(errResult);
  }

  const fallbackLabel = isAvailable ? "Unknown" : unavailableLabel;
  const result = {
    modelId,
    latencyMs,
    isAvailable,
    rateLimited,
    contextLength: contextLength || fallbackLabel,
    maxOutputTokens: maxOutputTokens || fallbackLabel,
    toolSupport,
    toolSupportChecked,
    toolSupportReason,
    toolSupportSummary,
    testedAt: new Date().toLocaleString()
  };

  persistTestResult(modelId, result);

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
