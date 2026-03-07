# Requirements Document

## 1. Project Overview
The purpose of this project is to display information about the free AI models provided on `build.nvidia.com`. The application serves as a lightweight, interactive dashboard to browse models, inspect their capabilities (especially token limits), and view code snippets on how to use them with the NVIDIA API.

## 2. Core Functional Requirements

1. **Model Listing & Filtering**
   * Fetch all models from the NVIDIA API.
   * **Only** display models that are active and usable. Any models marked as deprecated, retired, inactive, etc., must be hidden from the user interface.
   * Provide a real-time text filter allowing the user to search by model name, publisher, or any other metadata field.

2. **Metadata Display**
   * For each active model, fetch its complete metadata via the specific model metadata endpoint.
   * Present the metadata in a flattened, tabular format.
   * **Critical Fields**: Extract and prominently display `Context Length` and `Max Output Tokens`. If the API does not provide these natively, default to `"Not Tested"` and allow users to detect them via the Live Ping feature.
   * Include all other metadata information available in the API response.
   * Support sorting (ascending/descending) on all columns in the table.

3. **Live Ping & Limits Detection**
   * Each model row includes a "Ping" button to send a test request measuring latency and detecting actual context/output token limits via error response parsing.
   * Test results are persisted to `model_limits_cache.json` and survive page refreshes and server restarts.
   * Support batch testing of all displayed models with rate-limit protection.

4. **Usage Examples**
   * Allow users to right-click a row to see usage examples for that specific model.
   * Provide code snippets in cURL, Python, and JavaScript.
   * Code snippets must include the correct context length limits and the user's API key reference via environment variable `Sherman_NVDA_test`.
   * Provide a one-click "Copy" button for each code snippet.

5. **Manual Refresh**
   * Provide a manual "Force Refresh" button to fetch the latest model lists and metadata statuses on demand.
   * The backend caches API results in memory for 5 minutes to prevent excessive API calls.

## 3. Technical & Environmental Requirements

1. **Language & Localization**
   * All UI text, logs, and information must be presented in **English**.

2. **Authentication / API Key Handling**
   * The application must read the NVIDIA API key exclusively from the environment variable named `Sherman_NVDA_test`.
   * **Security Constraint**: `.env` files are strictly prohibited for storing or loading the API key. The application must rely purely on system UI or shell environments.

3. **Runtime Environment**
   * Node.js version 18 or above (relies on the native global `fetch` API).

4. **Browser Launch**
   * The application should automatically open the user's default browser to the dashboard URL on server startup.

5. **Theming**
   * The application follows the user's system light/dark mode preference automatically.
