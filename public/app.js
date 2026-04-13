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
const usageCurl = document.getElementById("usage-curl");
const usagePython = document.getElementById("usage-python");
const usageJavascript = document.getElementById("usage-javascript");
const usageCloseBtn = document.getElementById("usage-close-btn");
const usageCopyButtons = document.querySelectorAll("[data-copy-target]");

const CHAT_COMPLETIONS_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

const state = {
  loading: false,
  columns: [],
  rows: [],
  fetchedAt: null,
  modelCount: 0,
  totalModelCount: 0,
  filteredOutCount: 0,
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

function setStatus(text) {
  statusEl.textContent = text;
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

function isFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n);
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

  const contextLengthValue = findValueByKeyCandidates(row, [
    "context_length",
    "contextlength",
    "context_window",
    "contextwindow",
    "max_input_tokens",
    "maxinputtokens",
    "input_token_limit"
  ]);

  const maxOutputTokensValue = findValueByKeyCandidates(row, [
    "max_output_tokens",
    "maxoutputtokens",
    "output_token_limit",
    "max_tokens",
    "completion_token_limit"
  ]);

  const maxTokens = isFiniteNumber(maxOutputTokensValue) ? Number(maxOutputTokensValue) : 512;
  const contextLengthText = contextLengthValue !== null ? String(contextLengthValue) : "Unknown";
  const maxOutputText = maxOutputTokensValue !== null ? String(maxOutputTokensValue) : "Unknown";

  const payload = {
    model: modelId,
    messages: [{ role: "user", content: "Please briefly introduce the best use cases for this model." }],
    max_tokens: maxTokens,
    temperature: 0.2
  };

  const payloadJsonCompact = JSON.stringify(payload);
  const payloadJson = JSON.stringify(payload, null, 2);

  const curlPayloadForShell = payloadJsonCompact.replace(/'/g, "'\"'\"'");
  const curl = `curl -X POST "${CHAT_COMPLETIONS_URL}" \\
  -H "Authorization: Bearer $NVIDIA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${curlPayloadForShell}'`;

  const python = `import os\nimport requests\n\nurl = "${CHAT_COMPLETIONS_URL}"\nheaders = {\n    "Authorization": f"Bearer {os.environ['NVIDIA_API_KEY']}",\n    "Content-Type": "application/json"\n}\npayload = ${payloadJson}\n\nresp = requests.post(url, headers=headers, json=payload, timeout=60)\nresp.raise_for_status()\nprint(resp.json())`;

  const javascript = `const url = "${CHAT_COMPLETIONS_URL}";\nconst payload = ${payloadJson};\n\nconst resp = await fetch(url, {\n  method: "POST",\n  headers: {\n    Authorization: \`Bearer \${process.env.NVIDIA_API_KEY}\`,\n    "Content-Type": "application/json"\n  },\n  body: JSON.stringify(payload)\n});\n\nif (!resp.ok) {\n  throw new Error(\`HTTP \${resp.status}: \${await resp.text()}\`);\n}\n\nconsole.log(await resp.json());`;

  return {
    modelId,
    contextLengthText,
    maxOutputText,
    snippets: {
      curl,
      python,
      javascript
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
  usageMeta.textContent = `context_length: ${usage.contextLengthText} | max_output_tokens: ${usage.maxOutputText} | API Key Env Var: NVIDIA_API_KEY`;
  usageCurl.textContent = usage.snippets.curl;
  usagePython.textContent = usage.snippets.python;
  usageJavascript.textContent = usage.snippets.javascript;

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
  const filter = state.filterText.trim().toLowerCase();
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

    if (!filter) {
      return true;
    }

    for (const key of state.columns) {
      const value = row[key];
      if (value === null || value === undefined) {
        continue;
      }

      if (String(value).toLowerCase().includes(filter)) {
        return true;
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
  if (columnKey === "contextLength") return "Context Limit";
  if (columnKey === "maxOutputTokens") return "Max Output";
  if (columnKey === "latencyMs") return "Latency (ms)";
  if (columnKey === "toolSupport") return "Tool Support";
  if (columnKey === "testedAt") return "Tested At";
  return columnKey;
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
    row.liveTest = `${data.latencyMs}ms (${data.isAvailable ? 'OK' : 'Fail'})`;
    row.latencyMs = data.latencyMs;
    row.contextLength = data.contextLength;
    row.maxOutputTokens = data.maxOutputTokens;
    row.toolSupport = data.toolSupportChecked ? Boolean(data.toolSupport) : "";
    row.toolSupportChecked = Boolean(data.toolSupportChecked);
    row.testedAt = data.testedAt || "";

    // Determine state
    if (!data.isAvailable) {
      row.testState = "error";
    } else {
      const hasNumbers = typeof data.contextLength === 'number' || typeof data.maxOutputTokens === 'number';
      row.testState = hasNumbers ? "success" : "warning";
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
    const hasNumericLimits = typeof row.contextLength === 'number' && typeof row.maxOutputTokens === 'number';
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
    // Models that were tested but got non-numeric results (Error, No Limit Reported, etc.) are retested
    const hasNumericLimits = typeof row.contextLength === 'number' && typeof row.maxOutputTokens === 'number';
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
    batchStatus.textContent = `Batch testing ${force ? '(Forced) ' : ''}${count}/${visibleRows.length}: ${row.modelId}... (5s delay to avoid rate limits)`;

    const tr = document.querySelector(`tr[data-model-id="${row.modelId}"]`);
    const btn = tr ? tr.querySelector('.live-test-btn') : null;

    await runLiveTest(row, btn);

    // Check if we need to retry — no numeric limits found
    const gotNumericCtx = typeof row.contextLength === "number";
    const gotNumericOut = typeof row.maxOutputTokens === "number";
    const needsRetry = !gotNumericCtx && !gotNumericOut;

    if (needsRetry && !signal.aborted) {
      // Update batchStatus text — this element is NEVER destroyed by render()
      batchStatus.textContent = `⟳ Retrying ${count}/${visibleRows.length}: ${row.modelId}... (waiting 5s)`;

      // Re-query button from fresh DOM (render() rebuilt the table)
      const freshBtn = document.querySelector(`tr[data-model-id="${row.modelId}"] .live-test-btn`);
      if (freshBtn) {
        freshBtn.textContent = "Retrying...";
        freshBtn.classList.add("retry");
        freshBtn.disabled = false;
      }

      // Wait before retry
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(resolve, 5000);
          signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(new Error('Aborted'));
          });
        });
      } catch (e) {
        break; // aborted
      }

      if (!signal.aborted) {
        // Re-query again since we just waited
        const retryBtn = document.querySelector(`tr[data-model-id="${row.modelId}"] .live-test-btn`);
        await runLiveTest(row, retryBtn, true);
      }
    }

    // Wait ~5000ms before next test to stay under 40 requests/min
    if (count < visibleRows.length && !signal.aborted) {
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(resolve, 5000);
          signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(new Error('Aborted'));
          });
        });
      } catch (e) {
        break; // aborted
      }
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

    const button = document.createElement("button");
    button.type = "button";
    button.className = "sort-btn";
    button.textContent = makeHeaderLabel(columnKey);
    button.addEventListener("click", () => toggleSort(columnKey));

    if (state.sortKey === columnKey) {
      button.dataset.sortDirection = state.sortDirection;
    }

    th.appendChild(button);

    if (index <= 2) {
      th.classList.add("pinned");
      th.style.left = `${index * 240}px`;
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
      const value = row[columnKey];

      if (columnKey === "liveTest") {
        if (row.testState) {
          td.classList.add(`status-${row.testState}`);
        }
        
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
        btn.onclick = (e) => {
          e.stopPropagation();
          runLiveTest(row, btn);
        };
        td.appendChild(btn);
      } else if (columnKey === "contextLength" || columnKey === "maxOutputTokens") {
        td.textContent = value === null || value === undefined ? "" : formatTokensToK(value);
      } else if (columnKey === "toolSupport") {
        td.textContent = row.toolSupportChecked === true ? (value === true ? "true" : "false") : "";
      } else {
        td.textContent = value === null || value === undefined ? "" : String(value);
      }

      if (index <= 3) {
        td.classList.add("pinned");
        td.style.left = `${index * 240}px`;
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
    `Active Models: ${dynamicActiveCount} / Total: ${totalLabel} | Displaying: ${visibleRows} | Filtered: ${dynamicallyFilteredCount} | Sort: ${sortLabel} | API Key: ${keyLabel} | Data from: ${fetchedAtLabel}`
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
    state.apiKeyConfigured = Boolean(payload.apiKeyConfigured);

    // Reconstruct the visual testState from the loaded string values
    state.rows.forEach(row => {
      row.toolSupportChecked = row.toolSupportChecked === true;
      row.toolSupport = row.toolSupportChecked ? row.toolSupport === true : "";
      const live = String(row.liveTest || "");
      if (live === "Test") {
        row.testState = "";
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

refreshBtn.addEventListener("click", () => {
  loadData(true);
});

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

loadData(false);
