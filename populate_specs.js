#!/usr/bin/env node
// Populate model_specs.json from the build.nvidia.com catalog.
//
// Pulls every endpoint under the build.nvidia.com tenant org via the public
// NGC catalog API, then fetches each endpoint's full markdown body and
// extracts publisher-stated limits (contextLength, maxOutputTokens) plus a
// few useful metadata fields (parameters, architecture, modalities, license,
// useCase, releaseDate, huggingfaceUrl).

const fs = require("node:fs");
const path = require("node:path");

const NGC_BASE = process.env.NGC_BASE || "https://api.ngc.nvidia.com/v2";
const BUILD_ORG = process.env.BUILD_ORG || "qc69jvmznzxy";
const SPECS_PATH = path.join(__dirname, "model_specs.json");
const CONCURRENCY = Math.max(1, Number(process.env.POPULATE_CONCURRENCY || 6));
const REQUEST_TIMEOUT_MS = Math.max(3000, Number(process.env.POPULATE_TIMEOUT_MS || 20000));

if (typeof fetch !== "function") {
  throw new Error("This script requires Node.js 18+ (global fetch is missing).");
}

// ---------- HTTP helpers ----------

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status} for ${url}: ${body.slice(0, 200)}`);
    }
    return r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function listEndpoints() {
  const seen = new Set();
  const all = [];
  for (let page = 0; page < 50; page += 1) {
    const q = encodeURIComponent(
      JSON.stringify({
        query: "*",
        filters: [{ field: "orgName", value: BUILD_ORG }],
        page,
        pageSize: 200
      })
    );
    const json = await fetchJson(`${NGC_BASE}/search/catalog/resources/ENDPOINT?q=${q}`);
    let added = 0;
    for (const group of json.results || []) {
      for (const res of group.resources || []) {
        if (res.orgName !== BUILD_ORG) continue;
        const key = res.name;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        all.push(res);
        added += 1;
      }
    }
    const total = Number(json.resultTotal || 0);
    if (added === 0 || all.length >= total) break;
  }
  return all;
}

async function fetchEndpointDetail(name) {
  return fetchJson(`${NGC_BASE}/endpoints/${encodeURIComponent(BUILD_ORG)}/${encodeURIComponent(name)}`);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await mapper(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

// ---------- Token-count parsing ----------

// Treat K/M/G suffixes as powers of 1024 (matches model architectures like 128K=131072, 1M=1048576).
// "million" / "billion" written as words decode as decimal (1 million = 1,000,000).
function parseTokenCount(rawValue) {
  if (typeof rawValue === "number" && Number.isFinite(rawValue) && rawValue > 0) {
    return Math.round(rawValue);
  }
  if (typeof rawValue !== "string") return null;
  const s = rawValue.trim().replace(/,/g, "");
  if (!s) return null;
  const compact = s.replace(/\s+/g, "");
  const m = compact.match(/^(\d+(?:\.\d+)?)([kmgb])?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const suf = (m[2] || "").toLowerCase();
  if (suf === "k") return Math.round(n * 1024);
  if (suf === "m") return Math.round(n * 1024 * 1024);
  if (suf === "g" || suf === "b") return Math.round(n * 1024 * 1024 * 1024);
  return Math.round(n);
}

// ---------- Context length extraction ----------

// Order: most-specific phrasings first. Each captured number must either
// carry a K/M/B suffix or be followed by an explicit "tokens?" — otherwise
// we'd grab unrelated numbers like "20 seconds" from non-text models.
// Helper: a flexible prefix that absorbs markdown bold, colons, and whitespace.
// Used between a label phrase and the number we want.
const SEP = "[*\\s:=]*";

const CONTEXT_PATTERNS = [
  // ISL formal label
  new RegExp(`Input\\s+Context\\s+Length\\s*\\(ISL\\)${SEP}([0-9,]+(?:\\.\\d+)?\\s*[KkMm]?)\\b`, "i"),
  // "Context Length: 262,144 tokens" / "**Context Length**: 4K tokens"
  new RegExp(`Context\\s+(?:Length|Window|Size)${SEP}([0-9,]+(?:\\.\\d+)?\\s*[KkMm]?)\\s+tokens?\\b`, "i"),
  // "Context length up to 131,072 tokens" / "Context length up to 128K" — Nemotron family
  new RegExp(`Context\\s+(?:Length|Window|Size)\\s+up\\s+to${SEP}([0-9,]+(?:\\.\\d+)?\\s*[KkMm]?)\\s+tokens?\\b`, "i"),
  new RegExp(`Context\\s+(?:Length|Window|Size)\\s+up\\s+to${SEP}([0-9,]+(?:\\.\\d+)?\\s*[KkMm])\\b`, "i"),
  // "Up to 128k tokens context length" — Mistral
  new RegExp(`Up\\s+to${SEP}([0-9,]+(?:\\.\\d+)?\\s*[KkMm]?)\\s+tokens?\\s+context\\s+(?:length|window|size)`, "i"),
  // "Input + Output Token: 128K" — Nemotron-nano-vl
  new RegExp(`Input\\s*\\+\\s*Output\\s+Tokens?${SEP}([0-9,]+(?:\\.\\d+)?\\s*[KkMm])\\b`, "i"),
  // "Maximum context length is 256000" / "Maximum context length of 1 million"
  /Maximum\s+context\s+length\s+(?:is|of)\s+([0-9.,]+\s*(?:[KkMm]|million|billion)?)/i,
  // "Input context length: 128K"
  new RegExp(`Input\\s+context\\s+length${SEP}([0-9,]+(?:\\.\\d+)?\\s*[KkMm]?)\\s+tokens?\\b`, "i"),
  new RegExp(`Input\\s+context\\s+length${SEP}([0-9,]+(?:\\.\\d+)?\\s*[KkMm])\\b`, "i"),
  // "Total input context of 32K tokens" — Gemma
  new RegExp(`Total\\s+input\\s+context\\s+(?:of\\s+)?${SEP}([0-9,]+(?:\\.\\d+)?\\s*[KkMm])\\s+tokens?\\b`, "i"),
  // "Max input length: 262,144 tokens" — Qwen-coder
  new RegExp(`Max(?:imum)?\\s+input\\s+(?:length|context|tokens?)${SEP}([0-9,]+(?:\\.\\d+)?\\s*[KkMm]?)\\s+tokens?\\b`, "i"),
  // "supports context lengths of up to 262,144 tokens" — Qwen3-Next
  new RegExp(`(?:natively\\s+)?supports?\\s+context\\s+lengths?\\s+of\\s+up\\s+to${SEP}([0-9,]+(?:\\.\\d+)?\\s*[KkMm]?)\\s+tokens?\\b`, "i"),
  // "Long-context support up to 32K tokens" — Qwen-coder
  /(?:Long[- ]context\s+support\s+up\s+to|context\s+support\s+up\s+to)\s+([0-9.,]+\s*[KkMm]?)\s+tokens?\b/i,
  // "support a context length of up to 4K" — Gemma
  /context\s+length\s+of\s+up\s+to\s+(\d+(?:\.\d+)?\s*[KkMm])/i,
  // "supports up to 1M tokens of context"
  /supports?\s+up\s+to\s+(\d+(?:\.\d+)?\s*[KkMm])\s+(?:tokens?\s+(?:of\s+)?context|context)/i,
  // "maximum of 4096 input tokens" — Nemotron-mini
  /maximum\s+of\s+([0-9,]+)\s+input\s+tokens?\b/i,
  // Reversed forms: number then phrase ("128K Maximum Context Length")
  /\b(\d+(?:\.\d+)?\s*[KkMm])\s+(?:Maximum\s+)?[Cc]ontext\s+(?:Length|Window|Size)\b/,
  /\b[Mm]aximum\s+[Cc]ontext\s+[Ll]ength\s+(\d+(?:\.\d+)?\s*[KkMm])\b/,
  /\b(\d+(?:\.\d+)?\s*[KkMm])[- ]token\s+context\b/i,
  /\b(\d+(?:\.\d+)?\s*[KkMm])\s+context\s+(?:length|window|size)\b/i
];

// Sanity bounds: a real LLM context length lives between 512 and 100M tokens.
// Anything outside this range is almost certainly a mis-parse.
const MIN_PLAUSIBLE_CONTEXT = 512;
const MAX_PLAUSIBLE_CONTEXT = 100 * 1024 * 1024;

// Markdown table fallback: rows like `| **Context Length** | Up to 1M tokens |`
function extractContextLengthFromMarkdownTable(text) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i];
    if (!line.includes("|")) continue;

    // Same-line key/value table row: header + value live in the same line
    if (/Context\s+(?:Length|Window|Size)/i.test(line)) {
      const same = line.match(/Context\s+(?:Length|Window|Size)[^|]*\|[^|]*?(\d+(?:\.\d+)?\s*[KkMm]?)/i);
      if (same) {
        const v = parseTokenCount(same[1]);
        if (v) return v;
      }
    }

    // Multi-row table: header row, separator, data row
    if (/Context\s+(?:Length|Window|Size)/i.test(line) && i + 1 < lines.length) {
      let dataIdx = -1;
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j += 1) {
        if (lines[j].includes("|") && !/^[\s|:\-]+$/.test(lines[j])) {
          dataIdx = j;
          break;
        }
      }
      if (dataIdx === -1) continue;
      const headerCells = line.split("|").map((c) => c.trim());
      const dataCells = lines[dataIdx].split("|").map((c) => c.trim());
      for (let ci = 0; ci < headerCells.length; ci += 1) {
        if (/Context\s+(?:Length|Window|Size)/i.test(headerCells[ci]) && ci < dataCells.length) {
          const cell = dataCells[ci];
          const m = cell.match(/(\d+(?:\.\d+)?\s*[KkMm]?)\b/);
          if (m) {
            const v = parseTokenCount(m[1]);
            if (v) return v;
          }
        }
      }
    }
  }
  return null;
}

function isPlausibleContext(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_PLAUSIBLE_CONTEXT &&
    value <= MAX_PLAUSIBLE_CONTEXT
  );
}

function parseContextLength(text) {
  if (!text) return null;
  for (const pattern of CONTEXT_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    let raw = m[1];
    // Handle "1 million tokens" / "1 billion tokens" written with words
    const tail = text.slice(m.index, m.index + 80);
    if (/million/i.test(tail) && !/[KkMm]/.test(raw)) {
      const num = parseFloat(raw);
      if (Number.isFinite(num)) {
        const v = Math.round(num * 1_000_000);
        if (isPlausibleContext(v)) return v;
      }
    }
    if (/billion/i.test(tail) && !/[KkMm]/.test(raw)) {
      const num = parseFloat(raw);
      if (Number.isFinite(num)) {
        const v = Math.round(num * 1_000_000_000);
        if (isPlausibleContext(v)) return v;
      }
    }
    const v = parseTokenCount(raw);
    if (isPlausibleContext(v)) return v;
  }
  const tableValue = extractContextLengthFromMarkdownTable(text);
  return isPlausibleContext(tableValue) ? tableValue : null;
}

// ---------- Max output tokens extraction ----------
// Rare on cards (only ~1/6 in our sample), but try anyway.

const MAX_OUTPUT_PATTERNS = [
  /Output\s+Context\s+Length\s*\(OSL\)\s*[:*]?\s*\**\s*([0-9.,]+\s*[KkMm]?)/i,
  /Output\s+context\s+length\s*[:*]?\s*\**\s*([0-9.,]+\s*[KkMm]?)/i,
  /Max(?:imum)?\s+output\s+tokens?\s*[:*]?\s*\**\s*([0-9.,]+\s*[KkMm]?)/i,
  /Maximum\s+(?:allowed\s+)?output\s+(?:length|tokens)\s+(?:is|of)\s+([0-9.,]+\s*[KkMm]?)/i
];

function parseMaxOutputTokens(text) {
  if (!text) return null;
  for (const p of MAX_OUTPUT_PATTERNS) {
    const m = text.match(p);
    if (m) {
      const v = parseTokenCount(m[1]);
      if (v) return v;
    }
  }
  return null;
}

// ---------- Other metadata ----------

function parseParameters(text) {
  if (!text) return { total: null, active: null };
  // Match in this order: explicit "X total parameters and Y activated"
  let total = null;
  let active = null;

  const fullMatch = text.match(
    /\b(\d+(?:\.\d+)?\s*(?:billion|trillion|million|[BTM]))\s+total\s+parameters?(?:\s+and\s+(\d+(?:\.\d+)?\s*(?:billion|trillion|million|[BTM]))\s+(?:activated|active))?/i
  );
  if (fullMatch) {
    total = normalizeParamString(fullMatch[1]);
    if (fullMatch[2]) active = normalizeParamString(fullMatch[2]);
  }

  if (!total) {
    const tableTotal = text.match(/Total\s+Parameters\s*[:*|]+\s*\**\s*([0-9.]+\s*[BTM])/i);
    if (tableTotal) total = normalizeParamString(tableTotal[1]);
  }
  if (!active) {
    const tableActive = text.match(/Active\s+Parameters\s*[:*|]+\s*\**\s*([0-9.]+\s*[BTM])/i);
    if (tableActive) active = normalizeParamString(tableActive[1]);
    else {
      const inline = text.match(/\(([\d.]+\s*[BTM])\s+(?:active|activated)\)/i);
      if (inline) active = normalizeParamString(inline[1]);
    }
  }
  if (!total) {
    const fallback = text.match(/Number\s+of\s+(?:model\s+)?parameters?\s*[:*]+\s*\**\s*([0-9.]+\s*[BTM])/i);
    if (fallback) total = normalizeParamString(fallback[1]);
  }

  return { total, active };
}

function normalizeParamString(s) {
  if (!s) return null;
  return s.trim().replace(/billion/i, "B").replace(/trillion/i, "T").replace(/million/i, "M").replace(/\s+/g, "");
}

function parseModalities(text) {
  if (!text) return { input: null, output: null };
  const inputMatch = text.match(/Input\s+Type[s]?\s*[:*]+\s*\**\s*([^\n]+)/i);
  const outputMatch = text.match(/Output\s+Type[s]?\s*[:*]+\s*\**\s*([^\n]+)/i);
  return {
    input: inputMatch ? splitModalities(inputMatch[1]) : null,
    output: outputMatch ? splitModalities(outputMatch[1]) : null
  };
}

function splitModalities(s) {
  const tokens = s.replace(/\*\*|\\/g, "").split(/[,;\/]+|\s+and\s+/i)
    .map((t) => t.trim().toLowerCase())
    .map((t) => t.replace(/[^a-z]/g, ""))
    .filter(Boolean);
  const allowed = new Set(["text", "image", "video", "audio", "speech"]);
  const out = [];
  for (const t of tokens) {
    if (allowed.has(t) && !out.includes(t)) out.push(t);
  }
  return out.length > 0 ? out : null;
}

function parseHuggingfaceUrl(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/huggingface\.co\/[^\s)\]]+/i);
  return m ? m[0].replace(/[)\]>.,]+$/, "") : null;
}

function parseReleaseDate(text) {
  if (!text) return null;
  // "build.nvidia.com:** April 23, 2026" / "Build.NVIDIA.com:** 4/17/2026" / "**Release Date** | March 11, 2026"
  const candidates = [
    /(?:build\.nvidia\.com|Build\.NVIDIA\.com)\s*[:*]+\s*\**\s*([A-Za-z]+\s+\d{1,2},\s*\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i,
    /Release\s+Date\s*[:*|]+\s*\**\s*([A-Za-z]+\s+\d{1,2},\s*\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i
  ];
  for (const p of candidates) {
    const m = text.match(p);
    if (m) {
      const iso = toIsoDate(m[1]);
      if (iso) return iso;
    }
  }
  return null;
}

function toIsoDate(s) {
  if (!s) return null;
  s = s.trim();
  const named = s.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (named) {
    const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    const idx = months.indexOf(named[1].slice(0,3).toLowerCase());
    if (idx === -1) return null;
    return `${named[3]}-${String(idx+1).padStart(2,"0")}-${String(named[2]).padStart(2,"0")}`;
  }
  const slash = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (slash) return `${slash[3]}-${slash[1].padStart(2,"0")}-${slash[2].padStart(2,"0")}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

function parseLicense(text) {
  if (!text) return null;
  // Pull the "Additional Information" license name first; that's the underlying author license.
  const m = text.match(/Additional\s+Information[:\s]*\**\s*\[([^\]]+)\]/i);
  if (m) return m[1].trim();
  const m2 = text.match(/License\s*[:*|]+\s*\**\s*\[([^\]]+)\]/i);
  if (m2) return m2[1].trim();
  return null;
}

function parseArchitecture(text) {
  if (!text) return null;
  const m = text.match(/Network\s+Architecture\s*[:*]+\s*\**\s*([^\n]+)/i);
  if (m) return m[1].replace(/\*\*/g, "").trim();
  return null;
}

function parseUseCase(text) {
  if (!text) return null;
  const m = text.match(/##\s*Use\s+Case[:\s]*\n+\s*(?:\*\*Use\s+Case:?\*\*\s*)?([^\n]+)/i);
  if (m) return m[1].replace(/\*\*/g, "").trim();
  return null;
}

// ---------- Main ----------

function buildSpecEntry(detail, listEntry) {
  const art = (detail && detail.artifact) || {};
  const desc = art.description || "";

  const ctx = parseContextLength(desc);
  const maxOut = parseMaxOutputTokens(desc);
  const params = parseParameters(desc);
  const mods = parseModalities(desc);
  const hfUrl = parseHuggingfaceUrl(desc);
  const releaseDate = parseReleaseDate(desc);
  const license = parseLicense(desc);
  const architecture = parseArchitecture(desc);
  const useCase = parseUseCase(desc);

  const labels = Array.isArray(art.labels) ? art.labels : [];
  const isPreview = (art.attributes || []).some((a) => a.key === "PREVIEW" && a.value === "true");
  const isAvailable = (art.attributes || []).some((a) => a.key === "AVAILABLE" && a.value === "true");

  const entry = {};
  if (ctx) entry.contextLength = ctx;
  if (maxOut) entry.maxOutputTokens = maxOut;
  if (art.displayName) entry.displayName = art.displayName;
  if (art.publisher) entry.publisher = art.publisher;
  if (params.total) entry.parameters = params.total;
  if (params.active) entry.activeParameters = params.active;
  if (architecture) entry.architecture = architecture;
  if (mods.input) entry.inputModalities = mods.input;
  if (mods.output) entry.outputModalities = mods.output;
  if (releaseDate) entry.releaseDate = releaseDate;
  if (license) entry.license = license;
  if (hfUrl) entry.huggingfaceUrl = hfUrl;
  if (useCase) entry.useCase = useCase;
  if (labels.length) entry.labels = labels;
  if (isPreview) entry.preview = true;
  if (isAvailable === false) entry.available = false;

  // Provenance
  entry._source = "build.nvidia.com";
  entry._fetchedAt = new Date().toISOString();
  entry._ngcSlug = art.name || listEntry.name;

  return entry;
}

async function main() {
  console.log(`Listing endpoints under org ${BUILD_ORG} ...`);
  const endpoints = await listEndpoints();
  console.log(`Found ${endpoints.length} endpoints. Fetching details (concurrency=${CONCURRENCY})...`);

  let okCount = 0;
  let ctxCount = 0;
  let failCount = 0;

  const results = await mapWithConcurrency(endpoints, CONCURRENCY, async (ep, idx) => {
    try {
      const detail = await fetchEndpointDetail(ep.name);
      const art = (detail && detail.artifact) || {};
      const publisher = art.publisher || "unknown";
      const displayName = art.displayName || ep.displayName || ep.name;
      const apiId = `${publisher}/${displayName}`;
      const entry = buildSpecEntry(detail, ep);
      okCount += 1;
      if (entry.contextLength) ctxCount += 1;
      const ctxLabel = entry.contextLength ? `ctx=${entry.contextLength}` : "no-ctx";
      const moLabel = entry.maxOutputTokens ? ` mo=${entry.maxOutputTokens}` : "";
      console.log(`[${idx + 1}/${endpoints.length}] ${apiId}: ${ctxLabel}${moLabel}`);
      return [apiId, entry];
    } catch (e) {
      const tag = `${ep.publisher || "?"}/${ep.displayName || ep.name}`;
      const isExpected = /HTTP\s+404/.test(e.message);
      if (!isExpected) failCount += 1;
      console.warn(`[${idx + 1}/${endpoints.length}] ${tag}: ${isExpected ? "skipped (404)" : "FAILED"} ${e.message.slice(0, 120)}`);
      return null;
    }
  });

  // Sort, write
  const specs = {};
  for (const r of results) {
    if (r) specs[r[0]] = r[1];
  }
  const sortedKeys = Object.keys(specs).sort();
  const sorted = {};
  for (const k of sortedKeys) sorted[k] = specs[k];

  fs.writeFileSync(SPECS_PATH, JSON.stringify(sorted, null, 2) + "\n", "utf8");

  console.log("");
  console.log(`Wrote ${sortedKeys.length} entries → ${SPECS_PATH}`);
  console.log(`Detail OK: ${okCount}/${endpoints.length}`);
  console.log(`contextLength populated: ${ctxCount}/${endpoints.length} (${(100*ctxCount/Math.max(1,endpoints.length)).toFixed(1)}%)`);
  if (failCount) console.log(`Failed fetches: ${failCount}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("populate_specs FAILED:", e);
    process.exit(1);
  });
}

module.exports = {
  listEndpoints,
  fetchEndpointDetail,
  parseContextLength,
  parseMaxOutputTokens,
  parseParameters,
  parseModalities,
  parseHuggingfaceUrl,
  parseReleaseDate,
  parseLicense,
  parseArchitecture,
  parseUseCase,
  parseTokenCount,
  buildSpecEntry
};
