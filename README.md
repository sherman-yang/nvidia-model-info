# NVIDIA Free Models Info Dashboard 🚀

## 📖 What is this project?
This project is a lightweight, zero-dependency dashboard designed as the ultimate companion tool for developers exploring the free AI models available at `build.nvidia.com`. 

### 💡 The Problem it Solves (Elevator Pitch)
When interacting with NVIDIA's massive model catalog, developers often struggle to find crucial metadata—specifically, the **Context Length** and **Max Output Tokens** limits, which are often hidden or undocumented. Furthermore, sifting through hundreds of models to find which ones are actually online and usable is tedious.

This dashboard solves that pain point by:
1. **Automatically parsing and flattening** complex metadata from NVIDIA APIs into an interactive table.
2. **Programmatically probing (Live Ping)** models to reverse-engineer their exact token limits via error-scraping.
3. **Instantly generating** ready-to-run code snippets (cURL, Python, JS) for your chosen model.

## Features

- **Active Models Only**: Automatically fetches and displays only models currently active and usable, filtering out anything deprecated, disabled, or retired.
- **Detailed Metadata**: Calls `GET https://integrate.api.nvidia.com/v1/models/{publisher}/{model}` for each model automatically.
- **Flattened Schema**: Explodes the nested metadata dictionaries into individual columns that are dynamically generated.
- **High-Priority Properties Pinned**: The most critical fields (Live Ping, Model ID, Publisher, Context Limit, Max Output, and Latency) are pinned to the left table edge for easy reference.
- **Live Ping & Limits Detection**: Click "Ping" on any model row to measure response latency and automatically detect context length and max output tokens via NVIDIA error response scraping. The button provides clear, real-time colored visual feedback (Testing, Retrying, Success, Error). Results are cached to `model_limits_cache.json` and persist across restarts.
- **Batch Testing**: Click "Test Displayed Models" to test all visible models sequentially with rate-limit protection (3.5s delay). Hold Shift+Click to force re-test all models.
- **Sorting & Filtering**: Click headers to swap ascending/descending sort. Use the global search box to perform a sub-string filter across all parameters, or toggle the "Exclude Inactive/Error" checkbox to instantly hide failed models.
- **Code Snippets**: Right-click on any row to open an interactive popover showing fully constructed cURL, Python, and JavaScript payload examples for Chat completions logic tailored specifically to that model.
- **Manual Refresh**: Click "Force Refresh Data" to re-fetch the latest model list and metadata from the NVIDIA API. The backend caches API results for 5 minutes to respect rate limits.
- **System Theme Support**: Automatically follows the system light/dark mode preference.

## 🗂 Documentation (The Transit Hub)

This repository strictly adheres to a 4-document architecture. Please refer to these dedicated documents for deep dives into specific areas of the project:

- 🎯 **[REQUIREMENTS.md](REQUIREMENTS.md)**: Details the project goals, core functional requirements, system compatibility, and API key handling rules.
- 🏗 **[IMPLEMENTATION.md](IMPLEMENTATION.md)**: Explains the Node.js/Express architecture, scraping heuristics, current system limitations, and future roadmaps.
- 🧪 **[TESTING.md](TESTING.md)**: Outlines functional test plans, UI acceptance criteria, and quality judgment metrics.
- 📖 **[USAGE.md](USAGE.md)**: The comprehensive, step-by-step user manual covering everything from installation to interpreting UI color codes.

## Quick Start

1. Install [Node.js](https://nodejs.org/) v18+
2. Set your environment variable: 
   ```bash
   export Sherman_NVDA_test="your_nvidia_api_key"
   ```
3. Run the application exclusively using the start script:
   ```bash
   ./start.sh
   ```
4. The browser will open automatically to `http://localhost:4920`.

## Configuration Options

While the application primarily drives itself off `Sherman_NVDA_test`, you can inject system environment variables to tweak the Node.js backend:
- `PORT`: Sets the local webserver bind port (default: `4920`)
- `MAX_CONCURRENCY`: Adjust the bounds of concurrent API fetching to build.nvidia.com (default: `12`)
- `REQUEST_TIMEOUT_MS`: Individual HTTP fetch timeout boundary (default: `20000` ms)
- `CACHE_TTL_MS`: Duration to hold HTTP cache payload mappings in memory (default: `300000` ms)
