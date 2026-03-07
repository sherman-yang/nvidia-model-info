# Usage Document

This guide explains how to install and run the `nvidia-model-info` dashboard on your local machine.

## 1. Prerequisites
- **Node.js**: Ensure Node.js version 18 or higher is installed.
- **NVIDIA API Key**: You must obtain an API key from `build.nvidia.com`.

## 2. Installation
Clone the repository, navigate into the project directory, and install the required dependencies using `npm`.

```bash
git clone <repository_url>
cd nvidia-model-info
npm install
```

## 3. Configuration
The application reads your API key securely from your system environment variables. You must set the `Sherman_NVDA_test` variable. DO NOT create `.env` files for this key.

**On macOS/Linux**:
```bash
export Sherman_NVDA_test="your_actual_nvidia_api_key_here"
```

**On Windows (Command Prompt)**:
```cmd
set Sherman_NVDA_test=your_actual_nvidia_api_key_here
```

**On Windows (PowerShell)**:
```powershell
$env:Sherman_NVDA_test="your_actual_nvidia_api_key_here"
```

## 4. Running the Application
Start the Node.js server using the provided start script. This helper script checks your Node.js version, ensures the environment variable is present, installs dependencies automatically, and starts the server.

```bash
./start.sh
```

The browser will open automatically to `http://localhost:4920`.

## 5. Using the Application

- **Browsing**: Scroll left or right to view all the flattened metadata fields dynamically.
- **Essential Information**: Key fields like `Context Limit`, `Max Output`, and `Latency (ms)` are pinned to the left of the table.
- **Sorting**: Click on any column header to toggle ascending/descending sorting for that column.
- **Searching**: Use the "Search" input near the top to filter the table globally by model Name, Publisher, or any available text.
- **Live Ping**: Click the `Ping` button on any row. This instantly sends a tiny Chat request to measure Response Latency (ms) and a purposely oversized `max_tokens` request to detect the model's exact *Context Length* and *Max Output Tokens* from NVIDIA's error responses. Results are cached permanently.
- **Batch Testing**: Click "Test Displayed Models" to sequentially test all currently visible models with a 3.5s delay to avoid rate limits. Models that were previously tested but didn't get numeric limits are automatically retested. If a test still fails to detect numeric limits, the frontend automatically retries once (with a 3.5s delay) before moving to the next model. Hold **Shift+Click** to force re-test all models (even those already tested). A progress bar shows the current status, and you can click "Stop Testing" to cancel.
- **Viewing Code Snippets**: Right-click on any model's row to view a popup window containing cURL, Python, and JavaScript usage examples for that exact model. Click the "Copy" buttons to copy the snippets securely. All snippets use the `Sherman_NVDA_test` environment variable for authentication.
- **Refreshing**: Click the "Force Refresh Data" button to fetch the latest state from the NVIDIA API. The backend caches API data for 5 minutes to respect rate limits.
- **Theme**: The application automatically follows your system's light/dark mode preference.

---

## 6. Bulk Testing (Optional)
If you do not want to click `Live Ping` for every model individually, you can automatically test all 180+ models in the background.

To prevent hitting NVIDIA's strict rate limits (e.g. 40 requests per minute), we have included a safe background script. While the main server is running, open a **new** terminal window and run:

```bash
node bulk_test.js
```

This crawler deliberately pauses for roughly 3.5 seconds between each model. It will take about 10-15 minutes to run through the entire catalog.
Results are automatically saved to `model_limits_cache.json`.
The dashboard will instantly detect this file and populate the `Context Limit` and `Max Output` columns for you automatically on your next page refresh!

## 7. Troubleshooting

- **"Not Tested" values**: If you see "Not Tested" in the Context Limit or Max Output columns, it means the model hasn't been tested yet. Click "Ping" on that row or run a batch test.
- **"Unknown" values**: The model responded successfully but didn't reveal its limits through error messages. This is normal for some models.
- **"No Limit Reported" values**: The model accepted an extremely large `max_tokens` value (99999999) without error, meaning it doesn't enforce or report token limits externally.
- **"Inactive" values**: The model returned a 404 error, meaning it's currently unavailable on NVIDIA's servers.
- **Rate limit errors**: If you see test failures during batch testing, the rate limit (40 req/min) may have been exceeded. Wait a minute and try again.
- **API Key not configured**: Ensure `Sherman_NVDA_test` is exported in your shell. Run `echo $Sherman_NVDA_test` to verify.
- **Port conflict**: If port 4920 is in use, set a custom port: `PORT=5000 ./start.sh`.
