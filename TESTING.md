# Testing Document

## 1. Overview
This document outlines the testing strategy, acceptance criteria, and quality judgment metrics for the `nvidia-model-info` project. The goal is to ensure the dashboard reliably fetches, filters, and interacts with the NVIDIA API under various conditions, including rate limits and malformed data.

## 2. How to Test

### 2.1 Environment Setup
1. Ensure Node.js v18+ is installed.
2. Export a valid NVIDIA API key to your environment: `export Sherman_NVDA_test="your_actual_key"`.
3. Launch the application using `./start.sh`.

### 2.2 Functional Testing Procedures
1. **Initial Load & Rendering**:
   - Verify the browser opens automatically to `http://localhost:4920`.
   - Verify the table renders with models.
   - Verify models correctly marked as "deprecated" or "inactive" by the API are NOT displayed.
2. **Filtering & Sorting**:
   - Type "llama" into the search bar. Verify the table instantly filters.
   - Click the "Exclude Inactive/Error" checkbox. Verify broken rows disappear immediately.
   - Click the "Model ID" and "Context Limit" column headers. Verify the sorting toggles correctly between ascending and descending.
3. **Live Ping Testing (Single Model)**:
   - Click the "Ping" button on any untested model.
   - Verify the button turns Blue ("Testing..."), then Green ("Re-test") if successful, or Red ("Re-test") on failure.
   - Verify that latency (e.g. `850ms (OK)`) is displayed.
   - Verify Context Limit and Max Output columns are populated with detected values (or "No Limit Reported").
4. **Batch Testing (Rate Limit Verification)**:
   - Click "Test Displayed Models".
   - Verify the progress bar appears.
   - Verify tests fire exactly 3.5 seconds apart to respect the 40 requests/minute NVIDIA limit.
   - Verify that models failing to yield numeric token limits turn Orange ("Retrying...") before falling back to Yellow ("No Limits") or Red ("Error").
   - Click "Stop Testing" mid-run and verify the batch process aborts immediately.
5. **Caching Verification**:
   - Refresh the page (`Cmd + R`).
   - Verify that models tested previously still display their test results immediately without needing a re-ping.

## 3. Acceptance Criteria

| Feature | Acceptance Criteria |
|---------|---------------------|
| Application Boot | Server starts successfully and opens browser exclusively via `./start.sh`. No `.env` files required. |
| UI Rendering | Table is responsive. High priority columns are pinned to the left edge. UI is fully translated to English. |
| Authentication | API key is securely read from `Sherman_NVDA_test`. Missing key continues gracefully, allowing open endpoints to still function. |
| Error Handling | Models timing out or returning 404s must degrade gracefully without crashing the server. UI must reflect "Error" or "Inactive", not lock up. |
| Cross-Platform | Works interchangeably across macOS, Linux, and Windows. |

## 4. Judging Implementation Quality

The quality of this project is judged based on the following dimensions:

1. **Performance**: Does the UI remain snappy when rendering 150+ flattened row configurations? Does the search box filter flawlessly without blocking the main browser thread?
2. **Robustness**: How well does the backend handle strange API outputs? (e.g., nesting depth limits, random null values from the NVIDIA API). The flattening logic must not throw strict exceptions that crash the process.
3. **UX (User Experience)**: Are the wait states clearly communicated? Features like the batch progress bar, the changing status colors (Blue -> Green/Yellow/Red), and the right-click copy-to-clipboard popup strongly influence UX quality.
4. **Code Cleanliness**: 
   - No dead code, unused CSS classes, or orphaned variables.
   - Single responsibility principle applied where possible (e.g. abstract table render functions separated from API fetch logic).
   - Strict adherence to the one-language rule (English only).
