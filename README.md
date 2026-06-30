# 📦 OmniTrack Pro: Multi-Carrier Batch Logistics Tracker

A professional, high-productivity Chrome Extension designed for logistics operators and e-commerce teams to track hundreds of shipments concurrently, automate queries via RPA emulation, intercept clean API responses, and export standardized tracking reports.

Currently optimized for **Purolator**, with an extensible multi-carrier architecture designed to support Canada Post, UPS, FedEx, and other major carriers.

---

## ✨ Key Features

### 🤖 Intelligent RPA Automation
* **Human Emulation**: Simulates native keyboard keystrokes and coordinates-based mouse click cycles (`mousedown` -> `mouseup` -> `click`) to bypass heavy reactive frontend frameworks (React, Angular) and input fields nested in Shadow DOMs.
* **Anti-Suspension Engine**: Designed to work in background tabs/windows. Uses custom alarm schedules to bypass OS-level background thread rendering throttles.

### 🔌 MAIN-World API Interceptor
* **CSP Bypass**: Automatically injects a monkey-patch wrapper into the webpage's `MAIN` execution context, overriding `window.fetch` and `window.XMLHttpRequest` to capture clean response JSON payloads before they are rendered, completely bypassing page Content Security Policies (CSP).
* **Double-Insurance Parsing**: Merges direct API interception data with fallback DOM scrapers to ensure data integrity under all conditions.

### 🛡️ WAF Captcha Recovery & Active Alerts
* **Instant Detection**: Monitors gateway responses for `405 Method Not Allowed` or query timeouts to identify firewall challenges (AWS WAF / Captchas) instantly.
* **Multi-Channel Alerting**:
  * **OS Window Focus**: Automatically brings the automated query window to the front.
  * **Visual Attention Alerts**: Causes the Chrome app icon to **flash orange** in the Windows Taskbar or **bounce actively** in the macOS Dock.
  * **Text-to-Speech (TTS) Voice Alarm**: Utilizes Chrome's native Speech Synthesis engine to audibly announce: 🔊 *"Attention! Captcha detected, please handle it."*
* **Zero-Touch Auto-Resume**: The operator only needs to solve the captcha in the pop-up window. Once verified, the queue automatically resumes without requiring manual intervention.

### 📊 Granular Data Extraction & Export
* **Historical Timeline**: Captures and formats the **3 most recent status updates** (including Timestamp, Activity, and Location) instead of just the latest event.
* **Estimated Delivery Time (ETA)**: Directly extracts native delivery dates (`deliveryDateTime`) for *In Transit* packages. Shows `Not Available` if the carrier hasn't calculated it, matching the official site.
* **Auto-Pickup Address Merging**: When a shipment is available for self-pickup, the plugin automatically queries the carrier's locations API (`/api/locations/byID/`) in the background, bypasses CORS, parses structured coordinates, and resolves the exact physical address (e.g. *1550 Creditstone RD, Concord, ON L4K 5N1*).
* **Standardized Excel (CSV) Export**: Generates and downloads clean tabular summaries including status, ETA, self-pickup address, and detailed historical timelines.

---

## 🛠️ Installation Guide

As this is a developer-oriented Chrome Extension, install it locally via unpacked developer mode:

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/your-username/omnitrack-pro.git
   ```
2. **Open Chrome Extensions**:
   Navigate to `chrome://extensions/` in your Chrome browser.
3. **Enable Developer Mode**:
   Toggle the **"Developer mode"** switch in the top-right corner of the page.
4. **Load Unpacked Extension**:
   * Click the **"Load unpacked"** button in the top-left corner.
   * Select the root directory containing the cloned repository (the folder with `manifest.json`).
5. **Pin the Icon**:
   Click the puzzle piece icon in your Chrome toolbar, find **OmniTrack Pro**, and pin it.

---

## 🚀 Daily Operations Flow

### 1. Warm-Up Safety Token (WAF Token)
* Click the extension icon, select your target carrier (e.g. **Purolator**).
* Check the status indicator:
  * 🟢 **`WAF Token Ready`**: You are ready to start.
  * 🔴 **`WAF Token Expired / Missing`**: Click **"Refresh Token"** to open the official tracking site. Manually search for any tracking number once. The status will automatically turn green.

### 2. Run Batch Queries
* Paste your list of tracking numbers into the input text box (supports one per line, or separated by commas/spaces).
* Click **"▶ Start Query"**.
* A dedicated automation window will launch. **Do not minimize this window** (you can keep it behind your active browser window, but minimizing it will freeze background execution due to OS scheduling throttles).
* If a captcha triggers, solve it on screen when you hear the voice alert. The system will auto-resume.

### 3. Review & Export
* Click **"View Results Dashboard"** to open the real-time reporting console.
* Once the status voice announces: *"Query completed successfully"*, click **"Export Excel (CSV)"** to download the logistics report.

---

## 📂 Project Architecture

```text
omnitrack-pro/
├── manifest.json         # Extension configuration & MV3 permissions (storage, alarms, tts, hosts)
├── background.js         # Service Worker orchestrating RPA timers, direct APIs, and OS notifications
├── content.js            # Isolated DOM script executing keyboard emulation & DOM target scanning
├── interceptor.js        # Main-world injection script monkey-patching fetch & XHR requests
├── carriers.js           # Carrier configurations, schema parsers, and regex text sanitizers
├── popup.html / .js      # Popup configuration panel for input pasting and token warming
├── results.html / .js    # Live data dashboard rendering shipment rows and timelines
└── results.css           # Modern theme styling with responsive tables and status highlights
```

---

## 📄 License & Disclaimer

This project is licensed under the MIT License. This tool is intended for operational productivity assistance. Please use with reasonable query intervals to respect carrier servers and rate limits.
