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
The application reads your API key securely from your system environment variables. You must set the `NVIDIA_API_KEY` variable. DO NOT create `.env` files for this key.

**On macOS/Linux**:
```bash
export NVIDIA_API_KEY="your_actual_nvidia_api_key_here"
```

**On Windows (Command Prompt)**:
```cmd
set NVIDIA_API_KEY=your_actual_nvidia_api_key_here
```

**On Windows (PowerShell)**:
```powershell
$env:NVIDIA_API_KEY="your_actual_nvidia_api_key_here"
```

## 4. Running the Application
Start the Node.js server using the provided start script. This helper script checks your Node.js version, ensures the environment variable is present, installs dependencies automatically, and starts the server.

```bash
./start.sh
```

The browser will open automatically to `http://localhost:4920`.

## 5. Using the Application

- **Browsing**: Scroll left or right to view all the flattened metadata fields dynamically.
- **Essential Information**: Key fields like `Context Limit`, `Max Output`, `Latency (ms)`, and `Tool Support` are pinned to the left of the table.
- **Sorting**: Click on any column header to toggle ascending/descending sorting for that column.
- **Searching**: Use the "Search" input near the top to filter the table globally by model Name, Publisher, or any available text.
- **Filter Inactive/Error**: Check the "Exclude Inactive/Error" box next to the search bar to instantly hide models that failed their test or are offline.
- **Tool Support Filter**: Check the `tool support` box near the refresh button to show only models that have been verified to support tool calling.
- **Live Ping**: Click the `Ping` button on any row. This instantly sends a tiny Chat request to measure Response Latency (ms), a purposely oversized `max_tokens` request to detect the model's exact *Context Length* and *Max Output Tokens* from NVIDIA's error responses, and a forced `tools` request to detect *Tool Support*. Results are cached permanently. 
  - The Ping button provides colored visual feedback: 🔵 **Blue** (Testing), 🟠 **Orange** (Retrying), 🟢 **Green** (Success), 🟡 **Yellow** (No Limits Reported), and 🔴 **Red** (Error/Offline).
- **Batch Testing**: Click "Test Displayed Models" to sequentially test all currently visible models with a 5 second delay to avoid rate limits. Models that were previously tested but never got a `tool support` result are automatically retested. If a test still fails to detect numeric limits, the frontend automatically retries once (with a 5 second delay) before moving to the next model. Hold **Shift+Click** to force re-test all models (even those already tested). A progress bar shows the current status, and you can click "Stop Testing" to cancel.
- **Viewing Code Snippets**: Right-click on any model's row to view a popup window containing cURL, Python, and JavaScript usage examples for that exact model. Click the "Copy" buttons to copy the snippets securely. All snippets use the `NVIDIA_API_KEY` environment variable for authentication.
- **Refreshing**: Click the "Force Refresh Data" button to reset the current dashboard state, clear all saved test results from `model_limits_cache.json`, ignore in-memory cache, and fetch a fresh model list and metadata snapshot from the NVIDIA API.
- **Theme**: The application automatically follows your system's light/dark mode preference.

---

## 6. Bulk Testing (Optional)
If you do not want to click `Live Ping` for every model individually, you can automatically test all 180+ models in the background.

To prevent hitting NVIDIA's strict rate limits (e.g. 40 requests per minute), we have included a safe background script. While the main server is running, open a **new** terminal window and run:

```bash
node bulk_test.js
```

This crawler deliberately pauses for roughly 5 seconds between each model. It will take longer than before to run through the entire catalog because each test now also probes tool calling support.
Results are automatically saved to `model_limits_cache.json`.
The dashboard will instantly detect this file and populate the `Context Limit`, `Max Output`, and `Tool Support` columns for you automatically on your next page refresh!

## 7. Troubleshooting

- **"Not Tested" values**: If you see "Not Tested" in the Context Limit or Max Output columns, it means the model hasn't been tested yet. Click "Ping" on that row or run a batch test.
- **"Unknown" values**: The model responded successfully but didn't reveal its limits through error messages. This is normal for some models.
- **"No Limit Reported" values**: The model accepted an extremely large `max_tokens` value (99999999) without error, meaning it doesn't enforce or report token limits externally.
- **"Inactive" values**: The model returned a 404 error, meaning it's currently unavailable on NVIDIA's servers.
- **Rate limit errors**: If you see test failures during batch testing, the rate limit (40 req/min) may have been exceeded. Wait a minute and try again.
- **API Key not configured**: Ensure `NVIDIA_API_KEY` is exported in your shell. Run `echo $NVIDIA_API_KEY` to verify.
- **Port conflict**: If port 4920 is in use, set a custom port: `PORT=5000 ./start.sh`.
