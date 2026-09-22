# 🛡️ Deep Search

Deep Search is an air-gapped, privacy-preserving, zero-secret-egress deep research engine. It combines local academic registries, SEC EDGAR, an in-process SearXNG meta-search engine (DuckDuckGo + Bing with TLS 124 Chrome impersonation), Playwright Chromium stealth crawling, local FastEmbed ONNX dense vector embeddings (`bge-small-en-v1.5`), and offline CPU extractive synthesis.

---

## 🏗️ Architecture & Bounded Contexts

The codebase is organized into independent, domain-driven **bounded contexts** partitioned cleanly between `frontend/` and `backend/`.

```
deep-search/
├── frontend/                                # Independent Presentation Layer
│   ├── public/
│   │   └── index.html                       # Semantic HTML5 UI layout
│   ├── css/
│   │   ├── theme.css                        # CSS design tokens, dark palette, typography
│   │   ├── layout.css                       # Responsive grid, containers, headers
│   │   └── components.css                   # Form inputs, mode selectors, evidence cards, badges
│   └── js/
│       ├── api_client.js                    # REST API client (/api/research, /api/settings)
│       ├── state_manager.js                 # Reactive application state store
│       ├── ui_renderer.js                   # DOM rendering for results, citations, and summaries
│       └── app.js                           # App lifecycle, event wiring, and drawer toggles
│
├── backend/                                 # Domain Bounded Contexts
│   ├── security_guard/                      # Zero-Secret-Egress & Volatile Privacy Core
│   │   ├── socket_airgap.py                 # Socket-level physical air-gap enforcement
│   │   ├── watchlist_redactor.py            # Watchlist matching, normalization, and assertion
│   │   ├── token_blinder.py                 # Bidirectional token pseudonymization & rehydration
│   │   ├── statistical_chaffer.py           # k-Anonymity entropy analysis & decoy query generation
│   │   ├── encrypted_scratchpad.py          # AES-256-GCM in-memory buffer with memory zeroization
│   │   └── quarantine_zone.py               # Untrusted payload defanging & injection shielding
│   │
│   ├── retrieval_engine/                    # Network Ingestion & Isolated Retrieval Worker
│   │   ├── collector_worker.py              # Child process JSON-RPC worker loop
│   │   ├── collector_client.py              # Subprocess lifecycle client with outbound assertions
│   │   ├── ssrf_validator.py                # DNS resolution & private IP SSRF blocking
│   │   ├── content_cleaner.py               # Trafilatura article extractor & link discovery
│   │   ├── bot_barrier_detector.py          # Elsevier/Nature/Springer/Cloudflare wall detection
│   │   ├── task_validator.py                # Schema validation for incoming retrieval tasks
│   │   ├── retrieval_router.py              # Dispatch router across all active data connectors
│   │   └── connectors/                      # Decoupled Data Source Connectors
│   │       ├── openalex_connector.py        # OpenAlex scientific works API
│   │       ├── arxiv_connector.py           # arXiv Atom feed XML query connector
│   │       ├── crossref_connector.py        # Crossref DOI registry connector
│   │       ├── sec_edgar_connector.py       # SEC EDGAR corporate filings REST connector
│   │       ├── brave_search_connector.py    # Brave Search commercial web API
│   │       ├── searxng_connector.py         # Local/remote SearXNG connector with fallback
│   │       └── browser_crawler.py           # Playwright headless Chromium with stealth evasion
│   │
│   ├── meta_search/                         # Local SearXNG-Compatible Meta-Search Engine
│   │   ├── searxng_server.py                # HTTP server (127.0.0.1:8080) with SearXNG JSON API
│   │   ├── bing_search_engine.py            # Bing scraper with Base64 redirect decoding
│   │   ├── duckduckgo_search_engine.py      # DuckDuckGo scraper with TLS 124 impersonation
│   │   └── meta_search_aggregator.py        # Parallel search aggregator and deduplicator
│   │
│   ├── discovery_frontier/                  # Exploration Graph & Priority Crawl Frontier
│   │   ├── priority_frontier.py             # Bounded priority queue with domain budgets & territory reservation
│   │   └── url_canonicalizer.py             # URL canonicalization & tracking parameter stripping
│   │
│   ├── relevance_ranking/                   # Hybrid Lexical + Dense Vector Re-Ranking
│   │   ├── bm25_scorer.py                   # Okapi BM25 frequency & length normalizer
│   │   ├── dense_embedder.py                # FastEmbed ONNX (bge-small-en-v1.5) cosine similarity
│   │   ├── reciprocal_rank_fusion.py        # Reciprocal Rank Fusion (RRF) combiner
│   │   └── hybrid_ranker.py                 # Multi-signal ranker with 0-100% normalized scoring
│   │
│   ├── synthesis_intelligence/              # Air-Gapped Sourced Synthesis & LLM Reasoning
│   │   ├── local_synthesizer.py             # Offline CPU extractive summarization & gap analysis
│   │   ├── openai_synthesizer.py            # Cloud LLM synthesis with reasoning effort controls
│   │   └── report_generator.py              # Timestamped Markdown report archiver in reports/
│   │
│   ├── research_orchestrator/               # End-to-End Pipeline & Query Planning
│   │   ├── query_planner.py                 # Deterministic & decoy-chaffed query expansion
│   │   ├── cost_estimator.py                # Token consumption & spending cap kill switch
│   │   ├── cancellation.py                  # Thread-safe cancellation manager
│   │   └── research_pipeline.py             # Multi-hop retrieval loop with parallel workers
│   │
│   └── server/                              # Browser Web UI & REST API Server
│       ├── web_server.py                    # Static file serving, /api/cancel, /api/models, /api/reports
│       └── configuration.py                 # Environment (.env) loader and persistent store
│
├── reports/                                 # Persistent timestamped research reports archive
├── safe_research.py                         # Primary research orchestrator CLI & UI server entrypoint
├── collector.py                             # Isolated retrieval worker IPC entrypoint
├── Start-DeepSearch.bat                     # Windows desktop/CLI launch script
├── test_safe_research.py                    # Comprehensive security invariant test suite (29 tests)
├── test_bounded_contexts.py                 # Direct bounded context import test suite (12 tests)
├── .env / .env.example                      # Provider keys & endpoint configuration
├── topic.txt / watchlist.txt                # Default research inputs
└── report.md                                # Generated sanitized research report (backward-compatible)
```

---

## 🔒 Security Invariants

1. **Zero Secret Egress**: The Secret Core controller (`backend.security_guard`) asserts that sensitive watchlist tokens, raw private queries, reverse alias maps, or secret-bearing documents never touch network workers or external services.
2. **Socket Layer Air-Gap**: All outbound network connections from Secret Core are physically blocked at the socket layer (`socket_airgap.py`), allowing only localhost loopback communication.
3. **SSRF Guard**: The network worker (`retrieval_engine`) strictly validates all candidate URLs, rejecting loopback, private IPv4/IPv6 subnets, link-local, and cloud metadata endpoints.
4. **Quarantine & Memory Zeroization**: Inbound scraped content is staged in volatile memory buffers (`SecureZeroBuffer`) and scrubbed with zeros (`ctypes.memset`) immediately upon release.
5. **Simultaneous Dual Discovery**: Deep queries execute across academic repositories (OpenAlex, arXiv, Crossref), regulatory registries (SEC EDGAR), and open meta-search (DuckDuckGo + Bing) concurrently.

---

## 🎛️ Deep Exploration, Pre-Run Estimation & Spending Controls

- **Pre-Run Cost & Workload Estimator**: Live reactive estimate card calculating estimated OpenAI API calls (0 for offline modes, 1 for expansion, 2 for full synthesis), prompt/output tokens, reasoning effort allocation, and USD spend before launching research.
- **Interactive Concurrency & Territory Reservation**: Dual range slider + numeric input with quick preset buttons (`2 Gentle`, `4 Standard`, `8 Fast`). Parallel workers execute concurrently with thread-safe `in_flight_urls` locking, ensuring distinct domains and preventing redundant fetches.
- **Long-Running Exploration**: Configurable multi-hop crawl depth (`max_depth`: 1-10 hops), document corpus limits (`max_documents`: 5-100+ sources), and execution time budget (`max_duration_sec`: 30-1800s).
- **Model Selection & Reasoning Effort**: UI and API controls for `gpt-4o-mini`, `gpt-4o`, `gpt-4.5`, `gpt-5-mini`, `gpt-5`, `gpt-5.1`, `gpt-5.2`, `gpt-5.4`, `gpt-5.6`, `o3-mini`, `o1`, and `o1-pro`, with reasoning effort toggles (`low`, `medium`, `high`).
- **Spending Cap & Kill Switch**: Live token counting, USD expenditure estimation, configurable max spend cap ($ USD), and a `🛑 Cancel / Stop Run` button that halts workers immediately and saves partial findings.
- **Report Archiving**: All research runs produce timestamped files in `reports/YYYY-MM-DD_HHMMSS_<slug>.md` with structured metadata headers, while maintaining `report.md` for backward compatibility.

---

## 🚀 Quick Start

### 1. Launch via Desktop or CLI Launcher
Double-click `Start-DeepSearch.bat` or run:
```bash
python safe_research.py --ui
```
This automatically starts:
- The local SearXNG meta-search engine on `http://127.0.0.1:8080`
- The Deep Search Web UI on `http://127.0.0.1:8765`
- Opens your browser to the research interface

### 2. Run Headless CLI Research
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

Available modes:
- `deterministic`: 100% Zero-LLM. Multi-hop scraping + local BM25/FastEmbed RRF ranking + extractive CPU summary. Zero bytes to cloud AI.
- `extreme`: Token pseudonymization + k-anonymity decoy chaffing + air-gapped RRF ranking.
- `expansion`: AI expands safe public topic into multi-angle queries; scraping & ranking remain local.
- `full`: Multi-hop deep retrieval with sourced executive summary.

---

## 🧪 Running Tests

Run the full test suite (41 tests):
```bash
python -m unittest test_safe_research.py test_bounded_contexts.py
```
Or run individual suites:
```bash
# Security invariants and architecture benchmarks (29 tests)
python -m unittest test_safe_research.py

# Direct bounded context and deep search benchmarks (12 tests)
python -m unittest test_bounded_contexts.py
```
