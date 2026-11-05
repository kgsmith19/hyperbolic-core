"""Deep Search Backend Package.

Architected via Domain Bounded Contexts:
- privacy: Air-gap socket protection, token blinding, k-anonymity chaffing, encrypted scratchpad
- retrieval: Isolated network retrieval worker, SSRF protection, meta-search adapters
- frontier: Multi-hop graph exploration, priority queue, cycle detection, SHA-256 deduplication
- ranking: Local Okapi BM25 + ONNX FastEmbed dense vector RRF ranking
- synthesis: Offline extractive synthesis, gap analysis, and Markdown reporting
- research: End-to-end search pipeline and query planner
- server: Modular Web UI and REST API server
"""
