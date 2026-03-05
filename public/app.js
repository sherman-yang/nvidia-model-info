const statusEl = document.getElementById("status");
const searchInput = document.getElementById("search-input");
const refreshBtn = document.getElementById("refresh-btn");
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
const DEFAULT_AUTO_REFRESH_MS = 10 * 60 * 1000;
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
  sortKey: "modelId",
  sortDirection: "asc",
  autoRefreshMs: DEFAULT_AUTO_REFRESH_MS,
  nextAutoRefreshAt: Date.now() + DEFAULT_AUTO_REFRESH_MS,
  activeUsageModelId: ""
};

let autoRefreshTimer = null;
let activeUsageSnippets = null;

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

  return String(aNorm).localeCompare(String(bNorm), "zh-CN", {
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
  const contextLengthText = contextLengthValue !== null ? String(contextLengthValue) : "未知";
  const maxOutputText = maxOutputTokensValue !== null ? String(maxOutputTokensValue) : "未知";

  const payload = {
    model: modelId,
    messages: [{ role: "user", content: "请简单介绍这个模型的最佳使用场景。" }],
    max_tokens: maxTokens,
    temperature: 0.2
  };

  const payloadJsonCompact = JSON.stringify(payload);
  const payloadJson = JSON.stringify(payload, null, 2);

  const curlPayloadForShell = payloadJsonCompact.replace(/'/g, "'\"'\"'");
  const curl = `curl -X POST "${CHAT_COMPLETIONS_URL}" \\\n  -H "Authorization: Bearer <YOUR_NVIDIA_API_KEY>" \\\n  -H "Content-Type: application/json" \\\n  -d '${curlPayloadForShell}'`;

  const python = `import requests\n\nurl = "${CHAT_COMPLETIONS_URL}"\nheaders = {\n    "Authorization": "Bearer <YOUR_NVIDIA_API_KEY>",\n    "Content-Type": "application/json"\n}\npayload = ${payloadJson}\n\nresp = requests.post(url, headers=headers, json=payload, timeout=60)\nresp.raise_for_status()\nprint(resp.json())`;

  const javascript = `const url = "${CHAT_COMPLETIONS_URL}";\nconst payload = ${payloadJson};\n\nconst resp = await fetch(url, {\n  method: "POST",\n  headers: {\n    Authorization: "Bearer <YOUR_NVIDIA_API_KEY>",\n    "Content-Type": "application/json"\n  },\n  body: JSON.stringify(payload)\n});\n\nif (!resp.ok) {\n  throw new Error(\`HTTP \${resp.status}: \${await resp.text()}\`);\n}\n\nconsole.log(await resp.json());`;

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

  usageTitle.textContent = "模型使用示例";
  usageSubtitle.textContent = `Model: ${usage.modelId}`;
  usageMeta.textContent = `context_length: ${usage.contextLengthText} | max_output_tokens: ${usage.maxOutputText} | API Key 环境变量: Sherman_NVDA_test`;
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

  const filtered = filter
    ? state.rows.filter((row) => {
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
      })
    : [...state.rows];

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
  if (columnKey === "modelId") return "Model ID";
  if (columnKey === "publisher") return "Publisher";
  if (columnKey === "modelName") return "Model Name";
  return columnKey;
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
      td.textContent = value === null || value === undefined ? "" : String(value);

      if (index <= 2) {
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
  const keyLabel = state.apiKeyConfigured ? "已配置" : "未配置";
  const nextRefreshLabel = state.nextAutoRefreshAt
    ? new Date(state.nextAutoRefreshAt).toLocaleTimeString()
    : "-";
  const refreshEveryLabel = `${Math.round(state.autoRefreshMs / 60000)} 分钟`;
  const totalLabel = state.totalModelCount > 0 ? state.totalModelCount : state.modelCount;

  setStatus(
    `可用(Active)模型: ${state.modelCount} / 全部: ${totalLabel} | 当前显示: ${visibleRows} | 已过滤: ${state.filteredOutCount} | 排序: ${sortLabel} | API Key: ${keyLabel} | 数据时间: ${fetchedAtLabel} | 自动刷新: 每 ${refreshEveryLabel} | 下次刷新: ${nextRefreshLabel}`
  );
}

function render() {
  hideUsagePopover();
  renderTableHeader();

  const visibleRows = getFilteredAndSortedRows();
  renderTableBody(visibleRows);
  renderStatus(visibleRows.length);
}

async function loadData(forceRefresh = false) {
  if (state.loading) {
    return;
  }

  state.loading = true;
  refreshBtn.disabled = true;
  setStatus("正在加载模型列表和 metadata，请稍候...");

  try {
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

    if (!state.columns.includes(state.sortKey) && state.columns.length > 0) {
      state.sortKey = state.columns[0];
      state.sortDirection = "asc";
    }

    render();
  } catch (error) {
    setStatus(`加载失败: ${error.message}`);
  } finally {
    state.loading = false;
    refreshBtn.disabled = false;
    state.nextAutoRefreshAt = Date.now() + state.autoRefreshMs;
  }
}

function startAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
  }

  autoRefreshTimer = setInterval(() => {
    loadData(true);
  }, state.autoRefreshMs);
}

searchInput.addEventListener("input", (event) => {
  state.filterText = event.target.value || "";
  render();
});

refreshBtn.addEventListener("click", () => {
  loadData(true);
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
      button.textContent = "已复制";
    } catch (error) {
      button.textContent = "复制失败";
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
startAutoRefresh();
