"""Deep Search Backend Package.

Architected via Domain Bounded Contexts:
- security_guard: Air-gap socket protection, token blinding, k-anonymity chaffing, encrypted scratchpad
- retrieval_engine: Isolated network retrieval worker, SSRF protection, anti-bot challenge detection
- meta_search: Local SearXNG-compatible meta-search engine (DuckDuckGo + Bing)
- discovery_frontier: Multi-hop graph exploration, priority queue, cycle detection, SHA-256 deduplication
- relevance_ranking: Local Okapi BM25 + ONNX FastEmbed dense vector RRF ranking
- synthesis_intelligence: Offline extractive synthesis, gap analysis, and Markdown reporting
- research_orchestrator: End-to-end research pipeline and query expansion planner
- server: Modular Web UI and REST API server
"""
