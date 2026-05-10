const statusEl = document.getElementById("status");
const searchInput = document.getElementById("search-input");
const filterInactiveChk = document.getElementById("filter-inactive-chk");
const filterToolSupportChk = document.getElementById("filter-tool-support-chk");
const refreshBtn = document.getElementById("refresh-btn");
const testDisplayedBtn = document.getElementById("test-displayed-btn");
const batchProgressContainer = document.getElementById("batch-progress-container");
const batchProgress = document.getElementById("batch-progress");
const batchStatus = document.getElementById("batch-status");
const tableHead = document.getElementById("table-head");
const tableBody = document.getElementById("table-body");
const usagePopover = document.getElementById("usage-popover");
const usageTitle = document.getElementById("usage-title");
const usageSubtitle = document.getElementById("usage-subtitle");
const usageMeta = document.getElementById("usage-meta");
const usageNote = document.getElementById("usage-note");
const usageCurl = document.getElementById("usage-curl");
const usageCloseBtn = document.getElementById("usage-close-btn");
const usageCopyButtons = document.querySelectorAll("[data-copy-target]");

const CHAT_COMPLETIONS_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_SEARCH_TEXT = "agentic";
const DEFAULT_COLUMN_WIDTH = 240;
const PINNED_COLUMN_COUNT = 4;
const COLUMN_WIDTHS = {
  liveTest: 170,
  modelId: 280,
  publisher: 140,
  labels: 320,
  contextLength: 120,
  maxOutputTokens: 120,
  latencyMs: 110,
  toolSupport: 110,
  testedAt: 170
};

const state = {
  loading: false,
  columns: [],
  rows: [],
  fetchedAt: null,
  modelCount: 0,
  totalModelCount: 0,
  filteredOutCount: 0,
  duplicateModelCount: 0,
  apiKeyConfigured: false,
  filterText: "",
  excludeInactive: false,
  toolSupportOnly: false,
  sortKey: "modelId",
  sortDirection: "asc",
  activeUsageModelId: ""
};


let activeUsageSnippets = null;
let isBatchTesting = false;
let batchTestAbortController = null;

function hasNumericProbeLimits(row) {
  return typeof row.contextLength === "number" && typeof row.maxOutputTokens === "number";
}

function isRateLimitedRow(row) {
  return (
    row.rateLimited === true ||
    row.liveTest === "Rate Limited" ||
    row.contextLength === "Rate Limited" ||
    row.maxOutputTokens === "Rate Limited"
  );
}

function getLiveTestLabel(data) {
  if (data.rateLimited && !data.isAvailable) return "Rate Limited";
  if (data.availabilityStatus === "timeout") return "Timeout";
  if (data.availabilityStatus === "unavailable") return "Inactive";
  if (
    data.availabilityStatus === "auth_error" ||
    data.availabilityStatus === "backend_error" ||
    data.availabilityStatus === "request_error"
  ) {
    return "Error";
  }
  if (data.latencyMs >= 0) {
    return `${data.latencyMs}ms (${data.isAvailable ? "OK" : "Fail"})`;
  }
  return data.isAvailable ? "OK" : "Fail";
}

function applyApiKeyGating() {
  // Buttons that hit /v1/chat/completions need the key. Force Refresh Data
  // does not (NGC catalog API is unauthenticated), so leave it alone.
  const disabled = !state.apiKeyConfigured;
  const why = "Set NVIDIA_API_KEY to enable live probing";
  testDisplayedBtn.disabled = disabled;
  testDisplayedBtn.title = disabled ? why : "Click to test unknown models. Hold Shift + Click to force re-test ALL models.";
}

function setStatus(text) {
  statusEl.textContent = text;
}

function applyDefaultSearchFilter() {
  state.filterText = DEFAULT_SEARCH_TEXT;
  searchInput.value = DEFAULT_SEARCH_TEXT;
}

function normalizeValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return String(value).trim();
}

function isNumericValue(value) {
  return /^-?\d+(\.\d+)?$/.test(String(value));
}

function compareValues(aValue, bValue) {
  const aNorm = normalizeValue(aValue);
  const bNorm = normalizeValue(bValue);

  const aIsNumber = typeof aNorm === "number" || isNumericValue(aNorm);
  const bIsNumber = typeof bNorm === "number" || isNumericValue(bNorm);

  if (aIsNumber && bIsNumber) {
    return Number(aNorm) - Number(bNorm);
  }

  return String(aNorm).localeCompare(String(bNorm), "en-US", {
    numeric: true,
    sensitivity: "base"
  });
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

function findValueByKeyCandidates(row, candidates) {
  const keys = Object.keys(row);

  for (const key of keys) {
    const lowered = key.toLowerCase();
    if (!candidates.some((candidate) => lowered.includes(candidate))) {
      continue;
    }

    const value = row[key];
    if (value === null || value === undefined || value === "") {
      continue;
    }

    return value;
  }

  return null;
}

function buildUsageSnippets(row) {
  const modelId =
    row.modelId || (row.publisher && row.modelName ? `${row.publisher}/${row.modelName}` : "unknown-model");

  const maxOutputTokensValue = findValueByKeyCandidates(row, [
    "max_output_tokens",
    "maxoutputtokens",
    "output_token_limit",
    "max_tokens",
    "completion_token_limit"
  ]);
  const parsedMaxOutputTokens = parseTokenCount(maxOutputTokensValue);
  const maxTokens = parsedMaxOutputTokens ? Math.min(parsedMaxOutputTokens, 512) : 512;

  const payload = {
    model: modelId,
    messages: [{ role: "user", content: "Please briefly introduce the best use cases for this model." }],
    max_tokens: maxTokens,
    temperature: 0.2
  };

  const payloadJsonCompact = JSON.stringify(payload);
  const curlPayloadForShell = payloadJsonCompact.replace(/'/g, "'\"'\"'");
  const curl = `curl -X POST "${CHAT_COMPLETIONS_URL}" \\
  -H "Authorization: Bearer $NVIDIA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${curlPayloadForShell}'`;

  // build.nvidia.com URL slug uses the same form as our /v1/models id
  // (publisher/displayName, dots preserved). Link straight to the Model Card tab.
  const modelCardUrl = `https://build.nvidia.com/${modelId}/modelcard`;

  return {
    modelId,
    modelCardUrl,
    useCase: typeof row.useCase === "string" ? row.useCase : "",
    snippets: {
      curl
    }
  };
}

function hideUsagePopover() {
  usagePopover.hidden = true;
  state.activeUsageModelId = "";
  activeUsageSnippets = null;
}

function showUsagePopover(row, clientX, clientY) {
  const usage = buildUsageSnippets(row);
  state.activeUsageModelId = usage.modelId;
  activeUsageSnippets = usage.snippets;

  usageTitle.textContent = "Model Usage Examples";
  usageSubtitle.textContent = `Model: ${usage.modelId}`;

  // Replace the old context/max-output meta line with a clickable link to the
  // model card on build.nvidia.com.
  usageMeta.replaceChildren();
  usageMeta.append("Model card: ");
  const cardLink = document.createElement("a");
  cardLink.href = usage.modelCardUrl;
  cardLink.textContent = usage.modelCardUrl;
  cardLink.target = "_blank";
  cardLink.rel = "noopener noreferrer";
  usageMeta.append(cardLink);

  // useCase (publisher's stated use case) — show only when populated.
  if (usage.useCase) {
    usageNote.textContent = `Use case: ${usage.useCase}`;
    usageNote.hidden = false;
  } else {
    usageNote.textContent = "";
    usageNote.hidden = true;
  }

  usageCurl.textContent = usage.snippets.curl;

  usagePopover.hidden = false;
  usagePopover.style.left = "0px";
  usagePopover.style.top = "0px";

  const popoverRect = usagePopover.getBoundingClientRect();
  const left = Math.max(12, Math.min(clientX + 8, window.innerWidth - popoverRect.width - 12));
  const top = Math.max(12, Math.min(clientY + 8, window.innerHeight - popoverRect.height - 12));
  usagePopover.style.left = `${left}px`;
  usagePopover.style.top = `${top}px`;
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "readonly");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function getFilteredAndSortedRows() {
  // Search uses OR semantics: split the input on whitespace and a row matches
  // when ANY term appears in ANY column. Empty input matches everything.
  const terms = state.filterText.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = state.rows.filter((row) => {
    if (state.excludeInactive) {
      const isError = row.liveTest === "Error" || row.contextLength === "Error" || row.maxOutputTokens === "Error";
      const isInactive = row.liveTest === "Inactive" || row.contextLength === "Inactive" || row.maxOutputTokens === "Inactive";
      if (isError || isInactive) {
        return false;
      }
    }

    if (state.toolSupportOnly && row.toolSupport !== true) {
      return false;
    }

    if (terms.length === 0) {
      return true;
    }

    for (const key of state.columns) {
      const value = row[key];
      if (value === null || value === undefined) {
        continue;
      }
      const cell = String(value).toLowerCase();
      for (const term of terms) {
        if (cell.includes(term)) {
          return true;
        }
      }
    }

    return false;
  });

  filtered.sort((a, b) => {
    const compareResult = compareValues(a[state.sortKey], b[state.sortKey]);
    return state.sortDirection === "asc" ? compareResult : -compareResult;
  });

  return filtered;
}

function toggleSort(columnKey) {
  if (state.sortKey === columnKey) {
    state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
  } else {
    state.sortKey = columnKey;
    state.sortDirection = "asc";
  }

  render();
}

function makeHeaderLabel(columnKey) {
  if (columnKey === "liveTest") return "Live Ping";
  if (columnKey === "modelId") return "Model ID";
  if (columnKey === "publisher") return "Publisher";
  if (columnKey === "modelName") return "Model Name";
  if (columnKey === "labels") return "Labels";
  if (columnKey === "contextLength") return "Context Limit";
  if (columnKey === "maxOutputTokens") return "Max Output";
  if (columnKey === "latencyMs") return "Latency (ms)";
  if (columnKey === "toolSupport") return "Tool Support";
  if (columnKey === "testedAt") return "Tested At";
  return columnKey;
}

function getColumnWidth(columnKey) {
  return COLUMN_WIDTHS[columnKey] || DEFAULT_COLUMN_WIDTH;
}

function getPinnedLeftOffset(index) {
  let offset = 0;
  for (let i = 0; i < index; i += 1) {
    offset += getColumnWidth(state.columns[i]);
  }
  return offset;
}

function applyColumnSizing(cell, columnKey) {
  const width = getColumnWidth(columnKey);
  cell.style.width = `${width}px`;
  cell.style.minWidth = `${width}px`;
  cell.style.maxWidth = `${width}px`;
}

function humanizeToolSupportReason(reason) {
  const labels = {
    supported: "Supported",
    unsupported: "Unsupported",
    no_tool_call_observed: "No Tool Call Observed",
    rate_limited: "Rate Limited",
    timeout: "Timeout",
    backend_error: "Backend Error",
    max_tokens_unsupported: "Max Tokens Unsupported",
    inconclusive: "Inconclusive",
    request_error: "Request Error"
  };

  return labels[reason] || "Unknown";
}

function buildToolSupportTitle(row) {
  if (!row.toolSupportReason && !row.toolSupportSummary) {
    return "";
  }

  const parts = [];
  if (row.toolSupportReason) {
    parts.push(`Reason: ${humanizeToolSupportReason(row.toolSupportReason)}`);
  }
  if (row.toolSupportSummary) {
    parts.push(`Detail: ${row.toolSupportSummary}`);
  }

  return parts.join("\n");
}

function buildAvailabilityTitle(row) {
  const parts = [];
  if (row.availabilityStatus) {
    parts.push(`Availability: ${row.availabilityStatus}`);
  }
  if (row.availabilitySummary) {
    parts.push(`Detail: ${row.availabilitySummary}`);
  }
  return parts.join("\n");
}

function buildMaxOutputTitle(row) {
  const parts = [];
  if (row.maxOutputTokensSource) {
    parts.push(`Source: ${row.maxOutputTokensSource}`);
  }
  if (row.maxOutputTokensStatus) {
    parts.push(`Status: ${row.maxOutputTokensStatus}`);
  }
  if (row.maxOutputTokensSummary) {
    parts.push(`Detail: ${row.maxOutputTokensSummary}`);
  }
  return parts.join("\n");
}

function formatTokensToK(val) {
  if (typeof val === "number") {
    return Math.round(val / 1024) + "K";
  }
  const parsed = parseInt(val, 10);
  if (!isNaN(parsed)) {
    return Math.round(parsed / 1024) + "K";
  }
  return val;
}

async function runLiveTest(row, btn, isRetry = false) {
  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = isRetry ? "Retrying..." : "Testing...";
    }
    
    // Instantly clear limits to visually indicate a test is in-flight/queued
    row.liveTest = "Test";
    row.latencyMs = "";
    row.contextLength = "Not Tested";
    row.maxOutputTokens = "Not Tested";
    row.toolSupport = "";
    row.toolSupportChecked = false;
    row.toolSupportReason = "";
    row.toolSupportSummary = "";
    row.availabilityStatus = "";
    row.availabilitySummary = "";
    row.maxOutputTokensSource = "";
    row.maxOutputTokensStatus = "";
    row.maxOutputTokensSummary = "";
    row.rateLimited = false;
    row.testedAt = "";
    row.testState = isRetry ? "retrying" : "testing";
    
    if (!isRetry && !isBatchTesting) {
      // Clear cache on backend immediately if this is a standalone manual click
      try {
        await fetch("/api/reset-cache", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ models: [row.modelId] })
        });
      } catch (e) {}
    }

    // Force a re-render so text turns blue/orange immediately
    render();

    const r = await fetch(`/api/test-model?model=${encodeURIComponent(row.modelId)}`);
    const data = await r.json();

    if (!r.ok) throw new Error(data.error || "Bad status");

    // Update local state row
    row.liveTest = getLiveTestLabel(data);
    row.latencyMs = data.latencyMs;
    row.contextLength = data.contextLength;
    row.maxOutputTokens = data.maxOutputTokens;
    row.toolSupport = data.toolSupportChecked ? Boolean(data.toolSupport) : "";
    row.toolSupportChecked = Boolean(data.toolSupportChecked);
    row.toolSupportReason = data.toolSupportReason || "";
    row.toolSupportSummary = data.toolSupportSummary || "";
    row.availabilityStatus = data.availabilityStatus || "";
    row.availabilitySummary = data.availabilitySummary || "";
    row.maxOutputTokensSource = data.maxOutputTokensSource || "";
    row.maxOutputTokensStatus = data.maxOutputTokensStatus || "";
    row.maxOutputTokensSummary = data.maxOutputTokensSummary || "";
    row.rateLimited = Boolean(data.rateLimited);
    row.testedAt = data.testedAt || "";

    // Determine state
    if (data.rateLimited) {
      row.testState = "warning";
    } else if (!data.isAvailable && data.availabilityStatus !== "timeout") {
      row.testState = "error";
    } else {
      const hasNumbers = typeof data.contextLength === 'number' || typeof data.maxOutputTokens === 'number';
      row.testState = data.availabilityStatus === "available" && hasNumbers ? "success" : "warning";
    }

    // Force a re-render
    render();
  } catch (e) {
    // True network failure - update row to show error state
    row.liveTest = "Error";
    row.contextLength = "Error";
    row.maxOutputTokens = "Error";
    row.toolSupport = "";
    row.toolSupportChecked = false;
    row.toolSupportReason = "request_error";
    row.toolSupportSummary = e.message || "";
    row.availabilityStatus = "request_error";
    row.availabilitySummary = e.message || "";
    row.maxOutputTokensSource = "";
    row.maxOutputTokensStatus = "";
    row.maxOutputTokensSummary = "";
    row.rateLimited = false;
    row.testedAt = "";
    row.testState = "error";
    render();
    console.error(e);
  }
}

async function runBatchTest(force = false) {
  if (isBatchTesting) {
    // User wants to cancel
    if (batchTestAbortController) batchTestAbortController.abort();
    isBatchTesting = false;
    testDisplayedBtn.textContent = "Test Displayed Models";
    testDisplayedBtn.style.backgroundColor = "";
    batchProgressContainer.hidden = true;
    return;
  }

  const visibleRows = getFilteredAndSortedRows();
  if (visibleRows.length === 0) return;

  isBatchTesting = true;
  testDisplayedBtn.textContent = "Stop Testing";
  testDisplayedBtn.style.backgroundColor = "#d32f2f";
  batchProgress.max = visibleRows.length;
  batchProgress.value = 0;
  batchProgressContainer.hidden = false;
  batchTestAbortController = new AbortController();
  const signal = batchTestAbortController.signal;

  // Pre-clear all target rows so the user instantly sees the entire queue mapped out
  const rowsToClear = [];
  for (const row of visibleRows) {
    const hasNumericLimits = hasNumericProbeLimits(row);
    const isAlreadyTestedOk =
      row.liveTest &&
      typeof row.liveTest === 'string' &&
      row.liveTest.includes("ms") &&
      hasNumericLimits &&
      row.toolSupportChecked === true;
    
    if (force || !isAlreadyTestedOk) {
      row.liveTest = "Test";
      row.latencyMs = "";
      row.contextLength = "Not Tested";
      row.maxOutputTokens = "Not Tested";
      row.toolSupport = "";
      row.toolSupportChecked = false;
      row.toolSupportReason = "";
      row.toolSupportSummary = "";
      row.availabilityStatus = "";
      row.availabilitySummary = "";
      row.maxOutputTokensSource = "";
      row.maxOutputTokensStatus = "";
      row.maxOutputTokensSummary = "";
      row.rateLimited = false;
      row.testedAt = "";
      row.testState = "";
      rowsToClear.push(row.modelId);
    }
  }

  // Tell backend to clear cache for these models before starting so it survives a refresh
  if (rowsToClear.length > 0) {
    try {
      await fetch("/api/reset-cache", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: rowsToClear })
      });
    } catch (e) {
      console.error("Failed to reset cache on backend", e);
    }
  }

  render();

  let count = 0;
  for (const row of visibleRows) {
    if (signal.aborted) break;

    // Skip if already tested with numeric limits, unless forcing
    // Models that were tested but got non-numeric results (Error, Unknown, etc.) are retested
    const hasNumericLimits = hasNumericProbeLimits(row);
    if (
      !force &&
      row.liveTest &&
      typeof row.liveTest === 'string' &&
      row.liveTest.includes("ms") &&
      hasNumericLimits &&
      row.toolSupportChecked === true
    ) {
      count++;
      batchProgress.value = count;
      continue;
    }

    count++;
    batchProgress.value = count;
    batchStatus.textContent = `Batch testing ${force ? '(Forced) ' : ''}${count}/${visibleRows.length}: ${row.modelId}...`;

    const tr = document.querySelector(`tr[data-model-id="${row.modelId}"]`);
    const btn = tr ? tr.querySelector('.live-test-btn') : null;

    await runLiveTest(row, btn);

    // Retry once if we hit the rate-limited path or if no numeric limits came
    // back. No artificial wait — the backend's global probe rate limiter
    // (PROBE_RATE_LIMIT_RPM, defaults to NVIDIA's 40 RPM cap) automatically
    // paces every outgoing request.
    const gotNumericCtx = typeof row.contextLength === "number";
    const gotNumericOut = typeof row.maxOutputTokens === "number";
    const needsRetry = (!gotNumericCtx && !gotNumericOut) || isRateLimitedRow(row);

    if (needsRetry && !signal.aborted) {
      batchStatus.textContent = `⟳ Retrying ${count}/${visibleRows.length}: ${row.modelId}...`;
      const retryBtn = document.querySelector(`tr[data-model-id="${row.modelId}"] .live-test-btn`);
      if (retryBtn) {
        retryBtn.textContent = "Retrying...";
        retryBtn.classList.add("retry");
        retryBtn.disabled = false;
      }
      await runLiveTest(row, retryBtn, true);
    }
  }

  isBatchTesting = false;
  testDisplayedBtn.textContent = "Test Displayed Models";
  testDisplayedBtn.style.backgroundColor = "";
  batchProgressContainer.hidden = true;
  render(); // restore normal status text
}

function renderTableHeader() {
  tableHead.innerHTML = "";

  const row = document.createElement("tr");

  state.columns.forEach((columnKey, index) => {
    const th = document.createElement("th");
    applyColumnSizing(th, columnKey);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "sort-btn";
    button.textContent = makeHeaderLabel(columnKey);
    button.addEventListener("click", () => toggleSort(columnKey));

    if (state.sortKey === columnKey) {
      button.dataset.sortDirection = state.sortDirection;
    }

    th.appendChild(button);

    if (index < PINNED_COLUMN_COUNT) {
      th.classList.add("pinned");
      th.style.left = `${getPinnedLeftOffset(index)}px`;
    }

    row.appendChild(th);
  });

  tableHead.appendChild(row);
}

function renderTableBody(rows) {
  tableBody.innerHTML = "";

  const fragment = document.createDocumentFragment();

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.dataset.modelId = row.modelId || "";

    tr.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showUsagePopover(row, event.clientX, event.clientY);
    });

    state.columns.forEach((columnKey, index) => {
      const td = document.createElement("td");
      applyColumnSizing(td, columnKey);
      const value = row[columnKey];

      if (columnKey === "liveTest") {
        if (row.testState) {
          td.classList.add(`status-${row.testState}`);
        }
        td.title = buildAvailabilityTitle(row);
        
        const hasResult = row.liveTest && typeof row.liveTest === "string" && row.liveTest !== "Test";
        if (hasResult) {
          const span = document.createElement("span");
          span.textContent = row.liveTest + " ";
          span.style.marginRight = "6px";
          td.appendChild(span);
        }
        const btn = document.createElement("button");
        btn.textContent = hasResult ? "Re-test" : "Ping";
        btn.className = "live-test-btn";
        btn.style.fontSize = hasResult ? "11px" : "";
        btn.style.padding = hasResult ? "2px 6px" : "";
        if (!state.apiKeyConfigured) {
          btn.disabled = true;
          btn.title = "Set NVIDIA_API_KEY to enable live probing";
        }
        btn.onclick = (e) => {
          e.stopPropagation();
          runLiveTest(row, btn);
        };
        td.appendChild(btn);
      } else if (columnKey === "contextLength" || columnKey === "maxOutputTokens") {
        td.textContent = value === null || value === undefined ? "" : formatTokensToK(value);
        if (columnKey === "maxOutputTokens") {
          td.title = buildMaxOutputTitle(row);
        }
      } else if (columnKey === "toolSupport") {
        td.textContent = row.toolSupportChecked === true ? (value === true ? "true" : "false") : "";
        td.title = buildToolSupportTitle(row);
      } else {
        td.textContent = value === null || value === undefined ? "" : String(value);
      }

      if (index < PINNED_COLUMN_COUNT) {
        td.classList.add("pinned");
        td.style.left = `${getPinnedLeftOffset(index)}px`;
      }

      tr.appendChild(td);
    });

    fragment.appendChild(tr);
  });

  tableBody.appendChild(fragment);
}

function renderStatus(visibleRows) {
  const sortLabel = `${state.sortKey} (${state.sortDirection})`;
  const fetchedAtLabel = state.fetchedAt ? new Date(state.fetchedAt).toLocaleString() : "-";
  const keyLabel = state.apiKeyConfigured ? "Configured" : "Not Configured";
  const totalLabel = state.totalModelCount > 0 ? state.totalModelCount : state.modelCount;
  const duplicateLabel = state.duplicateModelCount > 0 ? ` | Duplicates Removed: ${state.duplicateModelCount}` : "";

  // Calculate dynamic active model count by ONLY counting explicitly successful models
  let dynamicActiveCount = 0;
  for (const row of state.rows) {
    if (row.testState === "success" || row.testState === "warning") {
      dynamicActiveCount++;
    }
  }

  // Calculate how many *active* models are currently hidden by frontend filters
  // (Search string or Exclude checkbox)
  const dynamicallyFilteredCount = Math.max(0, dynamicActiveCount - visibleRows);

  setStatus(
    `Active Models: ${dynamicActiveCount} / Total: ${totalLabel} | Displaying: ${visibleRows} | Filtered: ${dynamicallyFilteredCount}${duplicateLabel} | Sort: ${sortLabel} | API Key: ${keyLabel} | Data from: ${fetchedAtLabel}`
  );
}

function render() {
  hideUsagePopover();
  renderTableHeader();

  const visibleRows = getFilteredAndSortedRows();
  renderTableBody(visibleRows);
  renderStatus(visibleRows.length);
}

function stopBatchTestingUi() {
  if (batchTestAbortController) {
    batchTestAbortController.abort();
  }

  isBatchTesting = false;
  testDisplayedBtn.textContent = "Test Displayed Models";
  testDisplayedBtn.style.backgroundColor = "";
  batchProgressContainer.hidden = true;
}

function clearDisplayedData() {
  hideUsagePopover();
  state.columns = [];
  state.rows = [];
  state.fetchedAt = null;
  state.modelCount = 0;
  state.totalModelCount = 0;
  state.filteredOutCount = 0;
  state.duplicateModelCount = 0;
  render();
}

async function loadData(forceRefresh = false) {
  if (state.loading) {
    return;
  }

  state.loading = true;
  refreshBtn.disabled = true;
  setStatus(forceRefresh ? "Resetting all cached data and reloading fresh model list..." : "Loading model list and metadata, please wait...");

  try {
    if (forceRefresh) {
      stopBatchTestingUi();
      clearDisplayedData();
      setStatus("Resetting all cached data and reloading fresh model list...");

      const resetResponse = await fetch("/api/reset-all-cache", {
        method: "POST"
      });

      if (!resetResponse.ok) {
        const resetBodyText = await resetResponse.text();
        throw new Error(`Reset failed: HTTP ${resetResponse.status}: ${resetBodyText}`);
      }
    }

    const url = forceRefresh ? "/api/models-with-metadata?refresh=1" : "/api/models-with-metadata";
    const response = await fetch(url);

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`HTTP ${response.status}: ${bodyText}`);
    }

    const payload = await response.json();

    state.columns = Array.isArray(payload.columns) ? payload.columns : [];
    state.rows = Array.isArray(payload.rows) ? payload.rows : [];
    state.fetchedAt = payload.fetchedAt || null;
    state.modelCount = Number(payload.modelCount || state.rows.length || 0);
    state.totalModelCount = Number(payload.totalModelCount || state.modelCount || 0);
    state.filteredOutCount = Number(payload.filteredOutCount || 0);
    state.duplicateModelCount = Number(payload.duplicateModelCount || 0);
    state.apiKeyConfigured = Boolean(payload.apiKeyConfigured);

    const banner = document.getElementById("api-key-banner");
    if (banner) banner.hidden = state.apiKeyConfigured;
    applyApiKeyGating();

    // Reconstruct the visual testState from the loaded string values
    state.rows.forEach(row => {
      row.toolSupportChecked = row.toolSupportChecked === true;
      row.toolSupport = row.toolSupportChecked ? row.toolSupport === true : "";
      row.toolSupportReason = row.toolSupportReason || "";
      row.toolSupportSummary = row.toolSupportSummary || "";
      row.availabilityStatus = row.availabilityStatus || "";
      row.availabilitySummary = row.availabilitySummary || "";
      row.maxOutputTokensSource = row.maxOutputTokensSource || "";
      row.maxOutputTokensStatus = row.maxOutputTokensStatus || "";
      row.maxOutputTokensSummary = row.maxOutputTokensSummary || "";
      row.rateLimited = Boolean(row.rateLimited) || isRateLimitedRow(row);
      const live = String(row.liveTest || "");
      if (live === "Test") {
        row.testState = "";
      } else if (row.rateLimited) {
        row.testState = "warning";
      } else if (live.includes("Error") || live.includes("Inactive")) {
        row.testState = "error";
      } else {
        const cl = String(row.contextLength || "");
        const mo = String(row.maxOutputTokens || "");
        if (cl.includes("No Limit") || mo.includes("No Limit")) {
          row.testState = "warning";
        } else {
          row.testState = "success";
        }
      }
    });

    if (!state.columns.includes(state.sortKey) && state.columns.length > 0) {
      state.sortKey = state.columns[0];
      state.sortDirection = "asc";
    }

    render();
  } catch (error) {
    setStatus(`Load failed: ${error.message}`);
  } finally {
    state.loading = false;
    refreshBtn.disabled = false;
  }
}



searchInput.addEventListener("input", (event) => {
  state.filterText = event.target.value || "";
  render();
});

filterInactiveChk.addEventListener("change", (event) => {
  state.excludeInactive = event.target.checked;
  render();
});

filterToolSupportChk.addEventListener("change", (event) => {
  state.toolSupportOnly = event.target.checked;
  render();
});

function showPopulateProgress(state) {
  batchProgressContainer.hidden = false;
  batchProgress.max = Math.max(state.total || 1, 1);
  batchProgress.value = state.completed || 0;
  const pct = state.total ? Math.round((state.completed / state.total) * 100) : 0;
  const tail = state.currentLabel ? ` — ${state.currentLabel}` : "";
  batchStatus.textContent =
    state.status === "running"
      ? `Refreshing model cards: ${state.completed}/${state.total} (${pct}%, context found: ${state.contextHits})${tail}`
      : state.status === "done"
      ? `Refreshed ${state.total} model cards (context found: ${state.contextHits})`
      : state.status === "failed"
      ? `Refresh failed: ${state.error || "unknown error"}`
      : "";
}

function hidePopulateProgress() {
  batchProgressContainer.hidden = true;
  batchStatus.textContent = "";
}

// Triggers the populate-specs job and resolves once the server finishes.
// Caller is responsible for any button/UI state outside the progress bar.
async function runPopulateWithProgress() {
  const startResp = await fetch("/api/populate-specs", { method: "POST" });
  if (!startResp.ok && startResp.status !== 202) {
    const body = await startResp.text().catch(() => "");
    throw new Error(`HTTP ${startResp.status}: ${body}`);
  }

  let lastState = await startResp.json();
  showPopulateProgress(lastState);

  while (lastState.status === "running") {
    await new Promise((r) => setTimeout(r, 600));
    const statusResp = await fetch("/api/populate-specs/status");
    lastState = await statusResp.json();
    showPopulateProgress(lastState);
  }

  if (lastState.status === "failed") {
    throw new Error(lastState.error || "populate failed");
  }

  return lastState;
}

// Force Refresh Data: reset probe cache, reload the model list, then refresh
// every model card from the catalog. This is the canonical "fetch latest from
// build.nvidia.com" action -- the only way these specs get updated.
async function forceRefreshAll({ applyDefaultSearch = false } = {}) {
  refreshBtn.disabled = true;
  try {
    await loadData(true);
    await runPopulateWithProgress();
    await loadData(false);
    if (applyDefaultSearch) {
      applyDefaultSearchFilter();
      render();
    }
    hidePopulateProgress();
  } catch (err) {
    console.error("Force Refresh failed:", err);
    batchStatus.textContent = `Refresh failed: ${err.message}`;
    setTimeout(() => {
      hidePopulateProgress();
      refreshBtn.disabled = false;
    }, 5000);
  }
}

refreshBtn.addEventListener("click", () => {
  forceRefreshAll();
});

// First-load behaviour: if model_specs.json is missing or empty, simulate
// pressing Force Refresh Data so the user lands on a populated table without
// having to click anything.
async function isFirstLoad() {
  try {
    const r = await fetch("/api/specs-meta");
    if (!r.ok) return false;
    const meta = await r.json();
    return !meta.exists || meta.entries === 0;
  } catch (e) {
    console.warn("Failed to check specs-meta:", e);
    return false;
  }
}

testDisplayedBtn.addEventListener("click", (e) => {
  // If user holds Shift while clicking, force test all elements
  runBatchTest(e.shiftKey);
});

usageCloseBtn.addEventListener("click", () => {
  hideUsagePopover();
});

usageCopyButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    if (!activeUsageSnippets) {
      return;
    }

    const target = button.dataset.copyTarget;
    const text = activeUsageSnippets[target];
    if (!text) {
      return;
    }

    const originalText = button.textContent;
    try {
      await copyTextToClipboard(text);
      button.textContent = "Copied";
    } catch (error) {
      button.textContent = "Copy failed";
      console.error(error);
    } finally {
      setTimeout(() => {
        button.textContent = originalText;
      }, 1200);
    }
  });
});

document.addEventListener("click", (event) => {
  if (usagePopover.hidden) {
    return;
  }

  if (usagePopover.contains(event.target)) {
    return;
  }

  hideUsagePopover();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideUsagePopover();
  }
});

(async () => {
  if (await isFirstLoad()) {
    setStatus("First-time setup: loading model list and refreshing model cards from build.nvidia.com...");
    await forceRefreshAll({ applyDefaultSearch: true });
  } else {
    await loadData(false);
    applyDefaultSearchFilter();
    render();
  }
})();
