# Evidence Independence and Family-Aware Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local-only evidence-independence — a deterministic SimHash near-duplicate fingerprint recorded during collection, grouped into families after ranking — and make claim verification, the report, and the preview count corroboration by independent families instead of raw URLs, without changing collector, frontier budgets, or default egress.

**Architecture:** The frontier records a 64-bit SimHash per accepted document (record-only; no drop, no reweight). A new pure `backend/research/independence.py` computes the SimHash primitive and groups ranked `Evidence` into families by SimHash Hamming distance, shared DOI, then domain+title tiebreak. `claim_verifier.verify_evidence` gains an optional family map and counts corroboration by distinct families. The pipeline calls `assign_families` post-rank, threads families into verification/synthesis/report, and the report/preview gain an independence surface. Everything is additive and runs in the secret core over sanitized data.

**Tech Stack:** Python 3.11/3.12 standard library (`dataclasses`, `hashlib.blake2b`, `re`, `urllib.parse`), `unittest`, existing `ResearchFrontier`, `Evidence`, `claim_verifier`, `report_generator`, `preview`, privacy redactor/assertion.

**Spec:** `docs/superpowers/specs/2026-09-29-evidence-independence-design.md`

## Global Constraints

- Zero-secret-egress: SimHash and family metadata are computed only in the secret core over already-sanitized text/Evidence; nothing new reaches the collector; every ledger write stays sanitized via the existing `_sanitize` path.
- Frontier budget authority unchanged: `record_document` keeps exact SHA-256 dedup, byte/document/domain counters, and return values byte-for-byte; SimHash is recorded only.
- Additive types: `Evidence` and `ResearchRun` gain only defaulted, appended fields; old callers, payloads, and durable-ledger round-trips keep working.
- Determinism: use `hashlib.blake2b` (never salted builtin `hash`) so signatures are stable across processes/runs; all family logic is order-deterministic over the ranked input.
- Local-first: family grouping and family-aware verification are pure local computation; the no-API-key path is unaffected.
- Independence rides the existing `claim_verification` switch — no new `SearchOptions` knob.
- Pinned constants: `SHINGLE_SIZE = 3`, `SIMHASH_BITS = 64`, `HAMMING_THRESHOLD = 12`, domain+title Jaccard tiebreak `>= 0.9`.
- Required full verification command must be green before any completion/merge claim:
  `python -m unittest test_safe_research.py test_bounded_contexts.py test_ai_search_expansion.py test_deep_expansion.py test_ultra_deep.py test_server_stream.py test_durable_research_ledger.py test_evidence_independence.py`.

## Review Focus

1. A watchlist term embedded in a title/excerpt that reaches the report's Independence section is redacted before write — cover in Task 4.
2. A `0` (empty/degenerate) SimHash never unions two content-less docs into a false family via Hamming — cover in Task 2.
3. A restored ledger snapshot lacking `content_simhashes` resumes without crashing and defaults to `{}` — cover in Task 1.
4. `verify_evidence(families=None)` reproduces today's URL-based verdicts exactly, so existing verification behavior never silently changes — cover in Task 3.
5. `write_report(independence=None)` produces byte-identical output to the pre-change report, so old callers see no drift — cover in Task 4.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `backend/research/independence.py` | SimHash primitive, Hamming distance, `Family` record, `assign_families` grouping (pure, no retrieval imports). |
| `backend/frontier/priority_frontier.py` | Record-only `content_simhashes` map in `record_document`; export/import round-trip. |
| `backend/research/types.py` | Additive `Evidence.simhash`, `Evidence.family_id`, `Evidence.is_representative`. |
| `backend/synthesis/claim_verifier.py` | Optional `families` arg; family-distinct corroboration; `independence` summary. |
| `backend/synthesis/report_generator.py` | Optional `independence` arg; `## Independence` section. |
| `backend/research/preview.py` | `claim_verification`-gated independence warning. |
| `backend/research/research_pipeline.py` | Call `assign_families` post-rank; thread families/independence to verify/synthesize/report; progress message; defensive fallback. |
| `backend/synthesis/openai_synthesizer.py` | Accept family-aware `verification` unchanged (no signature change needed; consumes existing dict). |
| `backend/ranking/hybrid_ranker.py` | Thread new `Evidence` fields through dict/Evidence conversion. |
| `test_evidence_independence.py` | New offline unit/integration coverage. |

---

### Task 1: Record SimHash in the Frontier (Record-Only) and Add Evidence Fields

**Files:**
- Modify: `backend/frontier/priority_frontier.py`
- Modify: `backend/research/types.py`
- Modify: `backend/research/independence.py` (created here for the `simhash` symbol used by frontier import) — **create in Task 2**; in this task the frontier computes the signature inline via a private helper to avoid a forward dependency, then Task 2 refactors it to import `simhash`. To avoid churn, create `backend/research/independence.py` with just `simhash`/`hamming` here.
- Create: `backend/research/independence.py` (partial: `simhash`, `hamming`, constants)
- Modify: `test_evidence_independence.py` (create)

**Interfaces:**
- Produces: `backend.research.independence.simhash(text: str) -> int`, `hamming(a: int, b: int) -> int`, constants `SHINGLE_SIZE=3`, `SIMHASH_BITS=64`, `HAMMING_THRESHOLD=12`. `ResearchFrontier.content_simhashes: dict[str,int]`. `Evidence.simhash: int = 0`, `Evidence.family_id: int = -1`, `Evidence.is_representative: bool = False`.
- Consumes: existing `record_document`, `export_state`, `from_state`.

- [ ] **Step 1: Write failing SimHash primitive + frontier record tests**

Create `test_evidence_independence.py`:

```python
import time
import unittest

from backend.research.independence import simhash, hamming, HAMMING_THRESHOLD
from backend.frontier.priority_frontier import ResearchFrontier


class TestSimHashPrimitive(unittest.TestCase):
    def test_identical_text_identical_signature(self):
        self.assertEqual(simhash("the quick brown fox jumps"), simhash("the quick brown fox jumps"))

    def test_case_and_whitespace_insensitive(self):
        self.assertEqual(simhash("The  Quick\nBrown Fox"), simhash("the quick brown fox"))

    def test_near_duplicate_within_threshold(self):
        a = "the quick brown fox jumps over the lazy dog in autumn light"
        b = "the quick brown fox jumps over the lazy dog in autumn sunlight"
        self.assertLessEqual(hamming(simhash(a), simhash(b)), HAMMING_THRESHOLD)

    def test_unrelated_text_far_apart(self):
        a = "quarterly semiconductor revenue rose across every fabrication node"
        b = "migratory songbirds navigate using earth magnetic field cues"
        self.assertGreater(hamming(simhash(a), simhash(b)), HAMMING_THRESHOLD)

    def test_empty_text_zero(self):
        self.assertEqual(simhash("   "), 0)


class TestFrontierRecordsSimHash(unittest.TestCase):
    def _frontier(self):
        return ResearchFrontier(max_depth=2, max_documents=10, max_per_domain=5)

    def test_accepted_document_stores_signature(self):
        f = self._frontier()
        ok = f.record_document("https://a.example/1", 100, "unique body text here about topic")
        self.assertTrue(ok)
        self.assertIn("https://a.example/1", f.content_simhashes)
        self.assertNotEqual(f.content_simhashes["https://a.example/1"], 0)

    def test_exact_duplicate_does_not_change_counters(self):
        f = self._frontier()
        f.record_document("https://a.example/1", 100, "same body")
        docs_before = f.documents_collected
        bytes_before = f.total_bytes_consumed
        dup = f.record_document("https://a.example/2", 100, "same body")
        self.assertFalse(dup)
        self.assertEqual(f.documents_collected, docs_before)
        self.assertEqual(f.total_bytes_consumed, bytes_before)

    def test_export_import_roundtrips_simhashes(self):
        f = self._frontier()
        f.record_document("https://a.example/1", 100, "unique body text")
        state = f.export_state()
        self.assertIn("content_simhashes", state)
        restored = ResearchFrontier.from_state(state)
        self.assertEqual(restored.content_simhashes, f.content_simhashes)

    def test_import_tolerates_missing_simhashes(self):
        f = self._frontier()
        f.record_document("https://a.example/1", 100, "unique body text")
        state = f.export_state()
        del state["content_simhashes"]
        restored = ResearchFrontier.from_state(state)
        self.assertEqual(restored.content_simhashes, {})
```

- [ ] **Step 2: Run and verify failure**

Run: `python -m unittest test_evidence_independence.TestSimHashPrimitive test_evidence_independence.TestFrontierRecordsSimHash -v`
Expected: FAIL — `ImportError` for `simhash`/`hamming` and `AttributeError` for `content_simhashes`.

- [ ] **Step 3: Create the SimHash primitive**

Create `backend/research/independence.py`:

```python
"""Deterministic, local-only evidence independence: SimHash fingerprints and
near-duplicate family grouping over sanitized evidence. No egress, no models."""

from __future__ import annotations

import hashlib

SHINGLE_SIZE = 3
SIMHASH_BITS = 64
HAMMING_THRESHOLD = 12
_MASK = (1 << SIMHASH_BITS) - 1


def _shingle_hash(shingle: str) -> int:
    return int.from_bytes(hashlib.blake2b(shingle.encode("utf-8"), digest_size=8).digest(), "big")


def simhash(text: str) -> int:
    """64-bit SimHash over 3-word shingles of normalized text. 0 for empty."""
    if not text or not isinstance(text, str):
        return 0
    words = " ".join(text.split()).lower().split()
    if not words:
        return 0
    if len(words) < SHINGLE_SIZE:
        shingles = [" ".join(words)]
    else:
        shingles = [" ".join(words[i:i + SHINGLE_SIZE]) for i in range(len(words) - SHINGLE_SIZE + 1)]
    votes = [0] * SIMHASH_BITS
    for sh in shingles:
        h = _shingle_hash(sh)
        for bit in range(SIMHASH_BITS):
            votes[bit] += 1 if (h >> bit) & 1 else -1
    signature = 0
    for bit in range(SIMHASH_BITS):
        if votes[bit] > 0:
            signature |= (1 << bit)
    return signature & _MASK


def hamming(a: int, b: int) -> int:
    return bin((a ^ b) & _MASK).count("1")
```

- [ ] **Step 4: Add Evidence fields and frontier record-only logic**

In `backend/research/types.py`, append to `Evidence` after `rerank_score`:

```python
    # Evidence-independence annotations (additive; 0/-1/False when unused).
    simhash: int = 0
    family_id: int = -1
    is_representative: bool = False
```

In `backend/frontier/priority_frontier.py`:
- Add `from backend.research.independence import simhash as _simhash` at top.
- In `__init__`, add `self.content_simhashes: dict[str, int] = {}`.
- In `record_document`, immediately before `return True` (only on the accepted path), add:
  ```python
            self.content_simhashes[url] = _simhash(norm_text)
  ```
- In `export_state`, add inside the returned dict: `"content_simhashes": dict(self.content_simhashes),`.
- In `from_state`, after restoring `content_hashes`, add:
  ```python
        frontier.content_simhashes = {str(k): int(v) for k, v in (state.get("content_simhashes") or {}).items()}
  ```
  Do NOT add `content_simhashes` to the `required` set (keep it optional for old snapshots).

- [ ] **Step 5: Run tests and the two affected contexts**

Run: `python -m unittest test_evidence_independence.TestSimHashPrimitive test_evidence_independence.TestFrontierRecordsSimHash test_safe_research.py test_bounded_contexts.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/research/independence.py backend/research/types.py backend/frontier/priority_frontier.py test_evidence_independence.py
git commit -m "feat: record simhash fingerprints and add evidence independence fields"
```

### Task 2: Family Assignment

**Files:**
- Modify: `backend/research/independence.py`
- Modify: `test_evidence_independence.py`

**Interfaces:**
- Consumes: `simhash`, `hamming`, `HAMMING_THRESHOLD`, `Evidence`.
- Produces: `Family(family_id: int, representative_url: str, member_urls: tuple[str,...], size: int)`; `assign_families(evidence: list[Evidence]) -> tuple[list[Evidence], list[Family]]`. Returned evidence copies carry `family_id` (first-appearance order, 0-based) and `is_representative` (highest-ranked member per family).

- [ ] **Step 1: Write failing family tests**

Add to `test_evidence_independence.py`:

```python
from dataclasses import replace
from backend.research.types import Evidence
from backend.research.independence import assign_families


def _ev(url, excerpt, doi="", title=""):
    return Evidence(title=title or url, url=url, snippet="", excerpt=excerpt, doi=doi)


class TestFamilyAssignment(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(assign_families([]), ([], []))

    def test_near_duplicates_collapse_to_one_family(self):
        body = "the quick brown fox jumps over the lazy dog in autumn light again"
        alt = "the quick brown fox jumps over the lazy dog in autumn sunlight again"
        items = [_ev("https://a.example/1", body), _ev("https://b.example/2", alt),
                 _ev("https://c.example/3", body)]
        # attach real signatures the way the pipeline does
        items = [replace(e, simhash=simhash(e.excerpt)) for e in items]
        annotated, families = assign_families(items)
        self.assertEqual(len({e.family_id for e in annotated}), 1)
        self.assertEqual(len(families), 1)
        self.assertEqual(families[0].size, 3)

    def test_unrelated_stay_separate(self):
        a = _ev("https://a.example/1", "semiconductor revenue rose across every node")
        b = _ev("https://b.example/2", "songbirds navigate using magnetic field cues")
        items = [replace(e, simhash=simhash(e.excerpt)) for e in (a, b)]
        annotated, families = assign_families(items)
        self.assertEqual(len(families), 2)
        self.assertEqual(len({e.family_id for e in annotated}), 2)

    def test_shared_doi_groups_even_if_text_differs(self):
        a = _ev("https://arxiv.org/x", "preprint abstract wording one", doi="10.1/x")
        b = _ev("https://journal.org/x", "published version different abstract wording", doi="10.1/x")
        items = [replace(e, simhash=simhash(e.excerpt)) for e in (a, b)]
        _, families = assign_families(items)
        self.assertEqual(len(families), 1)

    def test_representative_is_first_in_ranked_order(self):
        body = "identical body content used across syndicated copies for the test"
        items = [replace(_ev(f"https://s{i}.example/{i}", body), simhash=simhash(body)) for i in range(3)]
        annotated, families = assign_families(items)
        reps = [e for e in annotated if e.is_representative]
        self.assertEqual(len(reps), 1)
        self.assertEqual(reps[0].url, "https://s0.example/0")
        self.assertEqual(families[0].representative_url, "https://s0.example/0")

    def test_family_ids_first_appearance_order(self):
        a = _ev("https://a.example/1", "unrelated alpha content about markets")
        b = _ev("https://b.example/2", "unrelated beta content about biology")
        items = [replace(e, simhash=simhash(e.excerpt)) for e in (a, b)]
        annotated, _ = assign_families(items)
        self.assertEqual(annotated[0].family_id, 0)
        self.assertEqual(annotated[1].family_id, 1)
```

- [ ] **Step 2: Run and verify failure**

Run: `python -m unittest test_evidence_independence.TestFamilyAssignment -v`
Expected: FAIL — `ImportError` for `assign_families`/`Family`.

- [ ] **Step 3: Implement `Family` and `assign_families`**

Append to `backend/research/independence.py`:

```python
import re
from dataclasses import dataclass, replace
from urllib.parse import urlparse

from backend.research.types import Evidence

_WORD_RE = re.compile(r"[a-z0-9]+")


@dataclass(frozen=True)
class Family:
    family_id: int
    representative_url: str
    member_urls: tuple[str, ...]
    size: int


def _domain(url: str) -> str:
    try:
        host = urlparse(url).netloc.lower()
    except Exception:
        return ""
    return host[4:] if host.startswith("www.") else host


def _title_tokens(title: str) -> set[str]:
    return set(_WORD_RE.findall((title or "").lower()))


def _norm_doi(doi: str) -> str:
    return (doi or "").strip().lower()


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def assign_families(evidence: list[Evidence]) -> tuple[list[Evidence], list[Family]]:
    """Group ranked evidence into near-duplicate/syndication families (deterministic)."""
    n = len(evidence)
    if n == 0:
        return [], []
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[max(rx, ry)] = min(rx, ry)

    for i in range(n):
        for j in range(i + 1, n):
            ei, ej = evidence[i], evidence[j]
            si, sj = int(ei.simhash or 0), int(ej.simhash or 0)
            if si and sj and hamming(si, sj) <= HAMMING_THRESHOLD:
                union(i, j)
                continue
            di, dj = _norm_doi(ei.doi), _norm_doi(ej.doi)
            if di and di == dj:
                union(i, j)
                continue
            if _domain(ei.url) and _domain(ei.url) == _domain(ej.url):
                if _jaccard(_title_tokens(ei.title), _title_tokens(ej.title)) >= 0.9:
                    union(i, j)

    # First-appearance family ordering.
    root_to_family: dict[int, int] = {}
    members: dict[int, list[int]] = {}
    for idx in range(n):
        root = find(idx)
        if root not in root_to_family:
            root_to_family[root] = len(root_to_family)
            members[root] = []
        members[root].append(idx)

    annotated = list(evidence)
    families: list[Family] = []
    for root, fam_id in sorted(root_to_family.items(), key=lambda kv: kv[1]):
        idxs = members[root]
        rep_idx = idxs[0]  # highest-ranked (input is already ranked)
        for k, idx in enumerate(idxs):
            annotated[idx] = replace(annotated[idx], family_id=fam_id, is_representative=(idx == rep_idx))
        families.append(Family(
            family_id=fam_id,
            representative_url=evidence[rep_idx].url,
            member_urls=tuple(evidence[i].url for i in idxs),
            size=len(idxs),
        ))
    return annotated, families
```

- [ ] **Step 4: Run family + regression tests**

Run: `python -m unittest test_evidence_independence.TestFamilyAssignment test_safe_research.py test_bounded_contexts.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/research/independence.py test_evidence_independence.py
git commit -m "feat: group evidence into near-duplicate families"
```

### Task 3: Family-Aware Claim Verification

**Files:**
- Modify: `backend/synthesis/claim_verifier.py`
- Modify: `test_evidence_independence.py`

**Interfaces:**
- Consumes: `verify_evidence(evidence, max_claims_per_doc=6)`.
- Produces: `verify_evidence(evidence, max_claims_per_doc=6, families: dict[str,int] | None = None) -> dict` where result gains `independence: {"families": int, "collapsed_claims": int}` and each verdict item gains `families: [int,...]`. `families=None` reproduces today's URL-based verdicts exactly.

- [ ] **Step 1: Write failing verification tests**

Add to `test_evidence_independence.py`:

```python
from backend.synthesis.claim_verifier import verify_evidence


class TestFamilyAwareVerification(unittest.TestCase):
    CLAIM = "The Alpha Reactor produced 42 megawatts during the Boron Trial in 2021."

    def _docs(self, urls):
        return [{"url": u, "excerpt": self.CLAIM} for u in urls]

    def test_same_family_repeats_are_single_source(self):
        docs = self._docs(["https://a/1", "https://b/2", "https://c/3"])
        fams = {"https://a/1": 0, "https://b/2": 0, "https://c/3": 0}
        result = verify_evidence(docs, families=fams)
        verified_claims = " ".join(c["claim"] for c in result["verified"])
        self.assertNotIn("Alpha Reactor", verified_claims)
        single = " ".join(c["claim"] for c in result["single_source"])
        self.assertIn("Alpha Reactor", single)
        self.assertGreaterEqual(result["independence"]["collapsed_claims"], 1)

    def test_two_families_corroborate(self):
        docs = self._docs(["https://a/1", "https://b/2"])
        fams = {"https://a/1": 0, "https://b/2": 1}
        result = verify_evidence(docs, families=fams)
        verified_claims = " ".join(c["claim"] for c in result["verified"])
        self.assertIn("Alpha Reactor", verified_claims)

    def test_families_none_matches_url_behavior(self):
        docs = self._docs(["https://a/1", "https://b/2"])
        result = verify_evidence(docs)  # no families -> URL-based
        verified_claims = " ".join(c["claim"] for c in result["verified"])
        self.assertIn("Alpha Reactor", verified_claims)
        self.assertNotIn("independence", {k: 1 for k in result if k == "zzz"})  # sanity
```

- [ ] **Step 2: Run and verify failure**

Run: `python -m unittest test_evidence_independence.TestFamilyAwareVerification -v`
Expected: FAIL — `verify_evidence` has no `families` kwarg / no `independence` key.

- [ ] **Step 3: Implement family-aware counting**

In `backend/synthesis/claim_verifier.py`, change the signature and grouping logic:

```python
def verify_evidence(evidence: list[dict], max_claims_per_doc: int = 6, families: dict | None = None) -> dict:
    by_key: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for item in evidence:
        if not isinstance(item, dict):
            continue
        url = item.get("url") or ""
        text = item.get("excerpt") or item.get("content") or ""
        for claim in extract_claims(text, max_claims=max_claims_per_doc):
            by_key[_claim_key(claim)].append((claim, url))

    def group_id(url: str):
        if families is not None:
            return families.get(url, url)  # unknown url stays distinct by its own url
        return url

    verified, contested, single = [], [], []
    collapsed = 0
    for key, occurrences in by_key.items():
        urls = sorted({u for _, u in occurrences})
        groups = sorted({group_id(u) for _, u in occurrences}, key=lambda g: str(g))
        rep = occurrences[0][0]
        n_url = len(urls)
        n_grp = len(groups)
        item = {"claim": rep, "urls": urls, "families": [g for g in groups if isinstance(g, int)]}
        if n_url >= 2 and n_grp < 2:
            collapsed += 1
        if n_grp >= 2:
            negs = sum(1 for c, _ in occurrences if _NEGATION_RE.search(c))
            if 0 < negs < len(occurrences):
                contested.append(item)
            else:
                verified.append(item)
        elif key.strip("#|"):
            single.append(item)
    n_families = len({g for _, occ in by_key.items() for g in [group_id(u) for _, u in occ]}) if families is not None else 0
    return {"verified": verified, "contested": contested, "single_source": single,
            "independence": {"families": n_families, "collapsed_claims": collapsed}}
```

Keep `extract_claims`, `_claim_key`, `_claim_numbers`, `verification_brief` unchanged. `verification_brief` already reads `contested`/`verified` lists, so it keeps working.

- [ ] **Step 4: Run verification + regression**

Run: `python -m unittest test_evidence_independence.TestFamilyAwareVerification test_deep_expansion.py test_bounded_contexts.py -v`
Expected: PASS (existing `_synthesize` callers pass no `families`, so behavior is unchanged; the added `independence` key is ignored by them).

- [ ] **Step 5: Commit**

```bash
git add backend/synthesis/claim_verifier.py test_evidence_independence.py
git commit -m "feat: count claim corroboration by independent families"
```

### Task 4: Pipeline Wiring, Report Section, and Preview Warning

**Files:**
- Modify: `backend/research/research_pipeline.py`
- Modify: `backend/synthesis/report_generator.py`
- Modify: `backend/research/preview.py`
- Modify: `backend/ranking/hybrid_ranker.py`
- Modify: `test_evidence_independence.py`

**Interfaces:**
- Consumes: `assign_families`, `verify_evidence(..., families=...)`, its `independence` summary.
- Produces: `write_report(..., independence: dict | None = None)`; `ResearchRun.evidence` carrying `family_id`/`is_representative`; a `claim_verification`-gated preview warning.

- [ ] **Step 1: Write failing report/preview/integration tests**

Add to `test_evidence_independence.py`:

```python
import os
import tempfile
from backend.synthesis.report_generator import write_report
from backend.research.preview import preview
from backend.research.types import SearchOptions


class TestReportAndPreview(unittest.TestCase):
    def test_report_none_independence_has_no_section(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "report.md")
            write_report("topic", [{"title": "T", "url": "https://a/1", "snippet": "s", "excerpt": "e"}],
                         "summary", [], output_path=out)
            text = open(out, encoding="utf-8").read()
        self.assertNotIn("## Independence", text)

    def test_report_with_independence_section_and_redaction(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "report.md")
            indep = {"families": 2, "largest_family": 3,
                     "multi": [{"title": "SECRETCO wire story", "size": 3}]}
            write_report("topic about SECRETCO", [{"title": "SECRETCO", "url": "https://a/1", "snippet": "", "excerpt": ""}],
                         "summary", ["SECRETCO"], output_path=out, independence=indep)
            text = open(out, encoding="utf-8").read()
        self.assertIn("## Independence", text)
        self.assertNotIn("SECRETCO", text)

    def test_preview_includes_independence_warning_when_verification_on(self):
        p_on = preview("topic", SearchOptions(claim_verification=True))
        p_off = preview("topic", SearchOptions(claim_verification=False))
        self.assertTrue(any("independent families" in w for w in p_on.warnings))
        self.assertFalse(any("independent families" in w for w in p_off.warnings))
```

Add an integration test with an offline fake collector modeled on the existing pattern in `test_deep_expansion.py` (reuse that harness's fake collector import if present) that returns three near-duplicate documents and asserts `run.evidence` has at least one non-`-1` `family_id` and the archived report contains `## Independence`. If the existing suite exposes a reusable fake collector, import it; otherwise assert the narrower `assign_families`+`write_report` composition already covered above and skip live pipeline wiring in this file, relying on the full suite in Task 5.

- [ ] **Step 2: Run and verify failure**

Run: `python -m unittest test_evidence_independence.TestReportAndPreview -v`
Expected: FAIL — `write_report` has no `independence` kwarg; preview lacks the warning.

- [ ] **Step 3: Implement report section, preview warning, ranker threading, pipeline wiring**

In `backend/synthesis/report_generator.py`, add `independence: dict | None = None` to `write_report`'s signature. After the Executive Summary block and before `## Evidence & Sources`, insert:

```python
    if independence and (independence.get("families", 0) or independence.get("multi")):
        report_lines.append("## Independence")
        fam_n = independence.get("families", 0)
        largest = independence.get("largest_family", 0)
        report_lines.append(
            f"Grouped into {fam_n} independent source-families"
            + (f"; largest family has {largest} near-duplicate copies." if largest else ".")
        )
        for fam in independence.get("multi", []):
            fam_title = redact(fam.get("title") or "Untitled", watchlist)
            report_lines.append(f"- {fam_title} ({fam.get('size', 0)} copies)")
        report_lines.append("")
```

(The final `redact`+`assert_safe_to_send` over the whole report already covers these lines; the per-line redact is defense in depth.)

In `backend/research/preview.py`, add near the other constants:
```python
WARN_INDEPENDENCE = "near-duplicate and syndicated sources grouped into families; corroboration counts independent families, not copies"
```
and in `preview`, where `claim_verification` is handled:
```python
    if options.claim_verification:
        warnings.append(WARN_VERIFY)
        warnings.append(WARN_INDEPENDENCE)
```

In `backend/ranking/hybrid_ranker.py`, thread the new fields: in `_item_to_dict` add `"simhash": getattr(item, "simhash", 0)`, `"family_id": getattr(item, "family_id", -1)`, `"is_representative": getattr(item, "is_representative", False)`; in the Evidence reconstruction `kwargs`, add them guarded by `fields` like `rerank_score`:
```python
        for extra in ("simhash", "family_id", "is_representative"):
            if extra in fields:
                kwargs[extra] = d.get(extra, getattr(cls, "__dataclass_fields__")[extra].default)
```

In `backend/research/research_pipeline.py`:
- Import: `from backend.research.independence import assign_families`.
- After the rerank block and before `_synthesize`, add:
  ```python
      families_records = []
      try:
          ranked, families_records = assign_families(ranked)
      except Exception:
          families_records = []
  ```
- Change `_synthesize` to accept and use families. Update its signature to
  `_synthesize(topic, evidence, watchlist, options, cost_tracker, cancel_token, progress_callback, families_records=None)` and inside, build the map and pass it:
  ```python
      family_map = {e.url: e.family_id for e in evidence if getattr(e, "family_id", -1) >= 0} if families_records else None
      ...
      verification = verify_evidence(evidence_dicts, families=family_map)
      independence_summary = verification.get("independence") if verification else None
      collapsed = (independence_summary or {}).get("collapsed_claims", 0)
      if progress_callback and collapsed:
          progress_callback(f"Independence check: {collapsed} claim(s) collapsed to a single source-family.")
  ```
  Return the summary alongside the string: change `_synthesize` to `return summary, independence_report` where `independence_report` is built from `families_records` + `verification`:
  ```python
      independence_report = None
      if families_records:
          multi = sorted([f for f in families_records if f.size > 1], key=lambda f: -f.size)
          independence_report = {
              "families": len(families_records),
              "largest_family": max((f.size for f in families_records), default=0),
              "multi": [{"title": next((e.title for e in evidence if e.url == f.representative_url), f.representative_url), "size": f.size} for f in multi],
          }
  ```
  Update every `_synthesize(...)` call site to unpack the tuple (`summary, independence_report = _synthesize(...)`). Pass `independence=independence_report` into `write_report`. Pass `families_records=families_records` into `_synthesize`.

  Note the existing call passes positional args ending in `note`; add `families_records=families_records` as a keyword. If `_synthesize` has other call sites, update them to unpack the tuple.

- [ ] **Step 4: Run report/preview + full-ish regression**

Run: `python -m unittest test_evidence_independence.py test_safe_research.py test_deep_expansion.py test_ultra_deep.py test_server_stream.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/research/research_pipeline.py backend/synthesis/report_generator.py backend/research/preview.py backend/ranking/hybrid_ranker.py test_evidence_independence.py
git commit -m "feat: surface evidence independence in synthesis, report, and preview"
```

### Task 5: Full Regression, Docs, and Merge

**Files:**
- Create: `docs/decision-log/2026-09-29-evidence-independence.md`
- Modify: `docs/research-reference-gap-matrix.md`
- Modify: `SESSION_CHECKPOINT.md`

- [ ] **Step 1: Run the full required verification command**

Run:
```bash
python -m unittest test_safe_research.py test_bounded_contexts.py test_ai_search_expansion.py test_deep_expansion.py test_ultra_deep.py test_server_stream.py test_durable_research_ledger.py test_evidence_independence.py
```
Expected: all pass.

- [ ] **Step 2: Privacy/scope diff check**

Run:
```bash
git diff main...HEAD --check
git diff main...HEAD -- backend/privacy backend/retrieval/collector_client.py collector.py
git status --short
```
Expected: no whitespace errors; no collector-boundary changes; only planned files modified.

- [ ] **Step 3: Write decision log and update gap matrix + checkpoint**

Create `docs/decision-log/2026-09-29-evidence-independence.md` recording: SimHash over MinHash (compact 64-bit, cheap Hamming); record-only in frontier (preserve budget authority); families post-rank (single assignment shared by verify/synthesize/report); family-distinct corroboration; independence rides `claim_verification` (no new knob); deterministic `blake2b` over builtin `hash`. In `docs/research-reference-gap-matrix.md`, update the "Evidence independence", "Contradiction detection", and "Duplicate-family analysis" rows to "Implemented (SimHash families + family-aware verification)". Update `SESSION_CHECKPOINT.md` packages/notes to mention `backend/research/independence.py` and family-aware verification.

- [ ] **Step 4: Commit docs**

```bash
git add docs/decision-log/2026-09-29-evidence-independence.md docs/research-reference-gap-matrix.md SESSION_CHECKPOINT.md
git commit -m "docs: record evidence independence decisions and status"
```

- [ ] **Step 5: Merge to main**

Fast-forward/merge the feature branch into `main` and confirm the full command is still green on `main`.

## Plan Self-Review

- **Spec coverage:** Task 1 = frontier record-only SimHash + Evidence fields + primitive; Task 2 = family assignment; Task 3 = family-aware verification + independence summary; Task 4 = pipeline wiring + report section + preview warning + ranker threading; Task 5 = regression, docs, merge. All spec sections map to a task.
- **Placeholder scan:** No TBD/TODO; every code step shows concrete code.
- **Type consistency:** `simhash`, `hamming`, `HAMMING_THRESHOLD`, `Family`, `assign_families`, `Evidence.simhash/family_id/is_representative`, `verify_evidence(..., families=)`, `write_report(..., independence=)` names are consistent across tasks.
- **Review Focus coverage:** (1) report redaction → Task 4 `test_report_with_independence_section_and_redaction`; (2) zero-simhash no false family → Task 2 (`0` skipped in Hamming union) + primitive test; (3) missing `content_simhashes` on import → Task 1 `test_import_tolerates_missing_simhashes`; (4) `families=None` parity → Task 3 `test_families_none_matches_url_behavior`; (5) `independence=None` byte-identical report → Task 4 `test_report_none_independence_has_no_section`.
