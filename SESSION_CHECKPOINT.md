# Deep Search - Session Checkpoint & Handoff

**Timestamp**: 2026-09-22 01:45 EDT  
**Repository**: `C:\code\deep-search`  
**Test Suite**: 41/41 Unit Tests Passing (`python -m unittest test_safe_research.py test_bounded_contexts.py`)  
**Status**: Stable, Verified, Production-Ready Deep Exploration, Pre-Run Estimation & Spending-Controlled Architecture  

---

## 1. Quick Resume Command (For New Chat Session)
To resume immediately in a fresh chat session, simply submit:
```text
Resume work on deep-search from SESSION_CHECKPOINT.md
```
The agent will read this file, `README.md`, and `AGENTS.md` and pick up with full context.

---

## 2. Core Architecture & Bounded Contexts

The codebase is strictly structured into domain-driven **bounded contexts**:

| Bounded Context | Path | Responsibilities |
| :--- | :--- | :--- |
| **Frontend UI** | [`frontend/`](file:///C:/code/deep-search/frontend/) | Modular HTML5 layout, CSS design tokens (`theme.css`, `layout.css`, `components.css`), and decoupled JavaScript modules (`api_client.js`, `state_manager.js`, `ui_renderer.js`, `app.js`). |
| **Security Guard** | [`backend/security_guard/`](file:///C:/code/deep-search/backend/security_guard/) | Socket-level air gap (`socket_airgap.py`), watchlist redaction/assertions (`watchlist_redactor.py`), token blinder (`token_blinder.py`), $k$-anonymity chaffing (`statistical_chaffer.py`), AES-256-GCM memory zeroization buffer (`encrypted_scratchpad.py`), and injection defense (`quarantine_zone.py`). |
| **Retrieval Engine** | [`backend/retrieval_engine/`](file:///C:/code/deep-search/backend/retrieval_engine/) | Isolated network worker (`collector_worker.py`), IPC client (`collector_client.py`), SSRF guard (`ssrf_validator.py`), Trafilatura cleaning (`content_cleaner.py`), bot challenge detection (`bot_barrier_detector.py`), and decoupled connectors in [`connectors/`](file:///C:/code/deep-search/backend/retrieval_engine/connectors/) (`openalex`, `arxiv`, `crossref`, `sec_edgar`, `brave`, `searxng`, `browser_crawler`). |
| **Meta Search** | [`backend/meta_search/`](file:///C:/code/deep-search/backend/meta_search/) | Local SearXNG-compatible server on `127.0.0.1:8080` (`searxng_server.py`), DuckDuckGo TLS 124 impersonator (`duckduckgo_search_engine.py`), Bing Base64 redirect decoder (`bing_search_engine.py`), and concurrent aggregator (`meta_search_aggregator.py`). |
| **Discovery Frontier** | [`backend/discovery_frontier/`](file:///C:/code/deep-search/backend/discovery_frontier/) | Bounded priority queue, multi-hop crawl budgets, domain rate limits, and thread-safe **territory reservation** (`in_flight_urls`) preventing duplicate fetches across parallel workers (`priority_frontier.py`). |
| **Relevance Ranking** | [`backend/relevance_ranking/`](file:///C:/code/deep-search/backend/relevance_ranking/) | Okapi BM25 frequency/length normalizer (`bm25_scorer.py`), FastEmbed ONNX dense embeddings (`dense_embedder.py`), and Reciprocal Rank Fusion (`reciprocal_rank_fusion.py`, `hybrid_ranker.py`). |
| **Synthesis Intelligence**| [`backend/synthesis_intelligence/`](file:///C:/code/deep-search/backend/synthesis_intelligence/)| Offline CPU extractive summarizer and gap analyzer (`local_synthesizer.py`), model-selectable cloud LLM synthesis with reasoning effort (`openai_synthesizer.py`), and timestamped report generator with metadata block headers (`report_generator.py`). |
| **Research Orchestrator**| [`backend/research_orchestrator/`](file:///C:/code/deep-search/backend/research_orchestrator/)| Multi-angle query planner (`query_planner.py`), thread-safe process cancellation & kill switch (`cancellation.py`), token/spend cap enforcement & pre-run workload estimation (`cost_estimator.py`), and concurrent multi-hop pipeline coordinator (`research_pipeline.py`). |
| **Server & Config** | [`backend/server/`](file:///C:/code/deep-search/backend/server/) | HTTP web server serving modular `frontend/` assets and `/api/*` endpoints (`web_server.py`), plus `.env` configuration manager (`configuration.py`). |

---

## 3. Deep Exploration, Concurrency, Estimation & Spending Controls

### Service-Tier Research Plans & Stealth Modes
The 4 operational modes are structured into service-tier comparison cards with explicit costs, LLM exposure levels, depths, and feature matrices:
- **Tier 1: Standard Local (`deterministic`)**: $0.00 / run. 100% Offline. Academic registries, SEC EDGAR & SearXNG retrieval with CPU extractive synthesis. Zero LLM exposure.
- **Tier 2: Cloaked Stealth (`extreme`) [RECOMMENDED FOR PRIVATE DEEP SEARCH]**: $0.00 / run. Maximum crawl depth + full privacy defense. Secret Core token blinding conceals watchlist terms into synthetic aliases, statistical decoy chaff masks queries from ISP/network sniffing, and zero bytes are sent to AI.
- **Tier 3: Smart Discovery (`expansion`)**: < $0.001 / run. Hybrid. Exactly 1 OpenAI query planning call expands the safe public topic into 4 diverse search angles. Scraped documents, evidence, and ranking remain 100% local.
- **Tier 4: Full AI Brief (`full`)**: ~$0.003 - $0.05+ / run. Full multi-hop retrieval with local redaction before cloud LLM executive synthesis (GPT-4o through GPT-5.6 / o1).

### Interactive Concurrency Controls
- **Dual Range Slider & Number Input**: Configure concurrency smoothly from 1 to 10 parallel workers.
- **Preset Quick Buttons**: Instant selection for `2 (Gentle)`, `4 (Standard)`, and `8 (Fast)`.
- **Territory Reservation**: Workers pull candidate URLs from `ResearchFrontier` with thread-safe `in_flight_urls` locking, ensuring distinct domains and preventing redundant fetches.

### Pre-Run Cost & Workload Estimator
- **Live Reactive Card**: Embedded directly above the launch button, updating dynamically on every parameter change (mode, model, effort, corpus size, concurrency, topic).
- **Workload Breakdown**: Displays expected OpenAI API calls (0 for offline modes, 1 for expansion, 2 for full synthesis), active model & reasoning effort token allocation, parallel worker assignment, and token volume (prompt vs output).
- **Spend Prediction**: Real-time USD range estimation before running (e.g. `~$0.003 USD` or `$0.00 (100% Free / Offline)`).
- **Backend API**: `POST /api/estimate` invokes `estimate_research_workload()` with fallback for offline environments.

### Model & Reasoning Effort Selection
- **Supported Models**: Full model catalog up to GPT-5.6 (`gpt-4o-mini`, `gpt-4o`, `gpt-4.5`, `gpt-5-mini`, `gpt-5`, `gpt-5.1`, `gpt-5.2`, `gpt-5.4`, `gpt-5.6`, `o3-mini`, `o1`, `o1-pro`).
- **Reasoning Effort**: Dropdown controls for `low`, `medium`, `high` reasoning intensity on reasoning-capable models (`o1`, `o1-pro`, `o3-mini`).
- **REST Catalog**: `/api/models` provides real-time pricing per million input/output tokens.

### Spending Cap & Live Cost Tracking
- **`CostTracker`** (`backend/research_orchestrator/cost_estimator.py`): Tracks prompt and completion tokens across all queries and syntheses.
- **Spending Cap (`max_spend_usd`)**: Hard cap (default: $2.00) that immediately triggers `SpendLimitExceededError` if exceeded, preventing API overspend.
- **Kill-Switch / Cancellation Button**: Prominent `🛑 Cancel / Stop Run` button in UI and `POST /api/cancel` endpoint signaling `cancellation_manager` to halt workers immediately and compile partial findings into a report.
- **Live Metrics Banner**: Displays execution duration, sources collected, estimated spend ($ USD), total tokens, and active model.

### Timestamped Report Archive & Dual-Write Guarantee
- **Archived Reports**: Stored in `reports/` with timestamp and sanitized topic slug (e.g., `reports/2026-09-22_012523_high-entropy-perovskite-oxides.md`).
- **Structured Metadata Block**: Includes date, mode, model, token counts, estimated spend, duration, and sources analyzed.
- **Backward Compatibility**: Dual-writes both the historical archive and `report.md` at root so legacy scripts and test suites never break.
- **UI Archive Drawer**: Displays archived reports with timestamp, file size, and direct view links (`GET /api/reports/view?file=...`).

---

## 4. Launchers & Access Points

- **Desktop Double-Click Launcher**: `C:\Users\kyleg\OneDrive\Desktop\Launch-DeepSearch.bat` (and `C:\Users\kyleg\Desktop\Launch-DeepSearch.bat`)  
  - Automatically launches the SearXNG meta-search engine (`127.0.0.1:8080`).
  - Launches the Secret Core web server (`127.0.0.1:8765`).
  - Opens your default web browser directly to the UI.
- **Desktop Interactive CLI Shell**: `C:\Users\kyleg\OneDrive\Desktop\DeepSearch-CLI.bat`  
  - Opens a Windows Command Prompt terminal inside `C:\code\deep-search` with example commands.
- **Repository Launcher**: `C:\code\deep-search\Start-DeepSearch.bat`
- **CLI Flags**:
  ```bash
  python safe_research.py \
    --topic topic.txt \
    --watchlist watchlist.txt \
    --mode full \
    --max-depth 3 \
    --max-docs 25 \
    --concurrency 4 \
    --max-duration 180 \
    --openai-model gpt-4o-mini \
    --reasoning-effort medium \
    --max-spend 2.00
  ```
- **Root Entrypoints**: `safe_research.py` (CLI & UI server) and `collector.py` (isolated network worker IPC) remain at root. Helper shims (`chaffing.py`, `ephemeral_scratch.py`, `frontier.py`, `local_llm.py`, `ranking.py`, `searxng_service.py`) have been retired in favor of direct bounded context imports.
- **Configuration & Keys**:
  - File: `C:\code\deep-search\.env`
  - Web UI: Top `⚙️ Provider Settings` drawer (hot-reloads without server restart).

---

## 5. Verification & Test Suite

All 41 unit tests pass cleanly:
```bash
python -m unittest test_safe_research.py test_bounded_contexts.py
```
- `test_safe_research.py` (29 tests): Validates socket air-gap, watchlist redaction, token blinding, chaffing entropy, RRF ranking, SSRF guards, and bot barrier handling.
- `test_bounded_contexts.py` (12 tests): Validates direct bounded context imports, pre-run workload estimation (`estimate_research_workload`), `CostTracker` token/spend cap enforcement, `cancellation_manager` kill switch, `ResearchFrontier` concurrency territory reservation, timestamped report archives, and frontend assets.

---

## 6. Recent Bug Fixes & Architectural Polish
1. **Root Directory Cleanup**:
   - Retired redundant root helper shims (`chaffing.py`, `ephemeral_scratch.py`, `frontier.py`, `local_llm.py`, `ranking.py`, `searxng_service.py`) in favor of direct imports from `backend/`.
   - Preserved primary entrypoints: [`safe_research.py`](file:///C:/code/deep-search/safe_research.py) (CLI & UI server) and [`collector.py`](file:///C:/code/deep-search/collector.py) (isolated network worker IPC).
2. **Real OpenAI API Key Support & Socket Air-Gap Resolution**:
   - **Socket Air-Gap Transport Resolution**: Updated [`backend/security_guard/socket_airgap.py`](file:///C:/code/deep-search/backend/security_guard/socket_airgap.py) to dynamically resolve and cache OpenAI Anycast/Cloudflare IPs (`api.openai.com`, `openai.com`). `socket.connect()` operates on IP addresses, so hostname substring checks had previously blocked valid connections with `PermissionError`.
   - **Mode-Specific Air-Gap Policy**: Updated [`backend/research_orchestrator/research_pipeline.py`](file:///C:/code/deep-search/backend/research_orchestrator/research_pipeline.py) to call `enforce_secret_core_socket_block(allow_openai=True)` when in `expansion` or `full` modes, and `allow_openai=False` in `deterministic` and `extreme` (Tier 2 Cloaked Stealth, 0 bytes to AI).
   - **Responses API Parameter & Token Mapping**: Fixed `reasoning={"effort": ...}` in [`query_planner.py`](file:///C:/code/deep-search/backend/research_orchestrator/query_planner.py) and [`openai_synthesizer.py`](file:///C:/code/deep-search/backend/synthesis_intelligence/openai_synthesizer.py) (replacing unsupported `reasoning_effort` kwarg) and mapped token usage to `input_tokens` and `output_tokens`.
   - **Web Server & UI Environment Sync**: Initialized `.env` loading in [`backend/server/web_server.py`](file:///C:/code/deep-search/backend/server/web_server.py) on module import and startup, and updated [`frontend/js/app.js`](file:///C:/code/deep-search/frontend/js/app.js) to pass typed API keys directly in `/api/research` payloads.
   - **Live End-to-End Verification**: Confirmed zero errors across all 4 modes (`deterministic`, `extreme`, `expansion`, `full`) with active OpenAI API keys.
