"""Local Small Language Model (SLM) & Extractive Synthesis Engine.

Provides 100% offline, air-gapped intelligence inside Secret Core:
- Local Sourced Synthesis: Generates structured executive summaries with inline citations without sending data to cloud APIs.
- Gap Analysis: Identifies research deficiencies and missing sub-facets to inform next-hop frontier scheduling.
- Optional Local Inference Server: Supports local OpenAI-compatible endpoints (Ollama, LM Studio, vLLM) on localhost.
"""

import os
import re
import urllib.parse
import httpx


class LocalSLMEngine:
    """Local offline inference and extractive synthesis engine."""

    def __init__(self, local_api_url: str | None = None, model_name: str | None = None):
        self.local_api_url = local_api_url or os.environ.get("LOCAL_LLM_URL", "http://127.0.0.1:11434/v1")
        self.model_name = model_name or os.environ.get("LOCAL_LLM_MODEL", "qwen2.5:0.5b")
        self.has_local_server = self._probe_local_server()

    def _probe_local_server(self) -> bool:
        """Check if a local LLM server (Ollama, LM-Studio, vLLM) is running on localhost."""
        try:
            parsed = urllib.parse.urlparse(self.local_api_url)
            if parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
                return False
            with httpx.Client(timeout=0.5) as client:
                r = client.get(f"{self.local_api_url}/models")
                return r.status_code == 200
        except Exception:
            return False

    def synthesize(self, topic: str, evidence: list[dict]) -> str:
        """Generate structured executive summary using local server if available, or deterministic extractive synthesis."""
        if not evidence:
            return "Summary not available (no evidence collected)."

        if self.has_local_server:
            try:
                return self._synthesize_with_local_api(topic, evidence)
            except Exception:
                pass

        return self._synthesize_extractive(topic, evidence)

    def _synthesize_with_local_api(self, topic: str, evidence: list[dict]) -> str:
        """Call local OpenAI-compatible server on localhost."""
        sources_text = []
        for idx, item in enumerate(evidence[:5], start=1):
            title = item.get("title", f"Source {idx}")
            url = item.get("url", "")
            content = item.get("excerpt", "") or item.get("content", "")
            sources_text.append(f"Source [{idx}]: {title} ({url})\n{content[:800]}")

        prompt = (
            f"You are an air-gapped research analyst. Provide an executive summary with inline source citations for the topic.\n\n"
            f"Topic: {topic}\n\n"
            f"Evidence:\n" + "\n\n".join(sources_text) + "\n\n"
            f"Write a concise executive summary citing sources with [1], [2], etc."
        )

        payload = {
            "model": self.model_name,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.3,
            "max_tokens": 500
        }

        with httpx.Client(timeout=15.0) as client:
            resp = client.post(f"{self.local_api_url}/chat/completions", json=payload)
            if resp.status_code == 200:
                data = resp.json()
                return data["choices"][0]["message"]["content"].strip()

        raise RuntimeError("Local LLM API error")

    def _synthesize_extractive(self, topic: str, evidence: list[dict]) -> str:
        """Deterministic, air-gapped extractive summarization with inline citations."""
        topic_words = set(re.findall(r"\w+", topic.lower()))
        stopwords = {"the", "a", "an", "and", "or", "in", "on", "of", "to", "for", "with", "at", "by", "from", "is", "are", "was", "were", "what", "how", "why"}
        core_topic_words = {w for w in topic_words if w not in stopwords and len(w) > 2}

        key_findings = []

        for idx, item in enumerate(evidence[:5], start=1):
            text = item.get("excerpt", "") or item.get("content", "")
            if not text:
                continue

            sentences = re.split(r"(?<=[.!?])\s+", text)
            scored_sentences = []

            for s in sentences:
                s_clean = s.strip()
                if len(s_clean) < 40 or len(s_clean) > 350:
                    continue
                s_words = set(re.findall(r"\w+", s_clean.lower()))
                overlap = len(s_words & core_topic_words)
                if overlap > 0:
                    scored_sentences.append((overlap, s_clean))

            scored_sentences.sort(key=lambda x: x[0], reverse=True)
            for _, top_s in scored_sentences[:2]:
                finding = f"- {top_s} [Source {idx}: {item.get('url', '')}]"
                if finding not in key_findings:
                    key_findings.append(finding)

        if not key_findings:
            return "No salient sentences identified for executive summary."

        header = f"### Key Research Findings on: {topic}\n\n"
        body = "\n\n".join(key_findings[:6])
        footer = "\n\n*Synthesized locally using air-gapped extractive ranking.*"
        return header + body + footer

    def analyze_gaps(self, topic: str, evidence: list[dict]) -> list[str]:
        """Identify missing technical angles and candidate discovery facets."""
        topic_words = set(re.findall(r"\w+", topic.lower()))
        stopwords = {"the", "a", "an", "and", "or", "in", "on", "of", "to", "for", "with", "at", "by", "from", "is", "are", "was", "were"}
        core_topic_words = {w for w in topic_words if w not in stopwords and len(w) > 2}

        corpus_text = " ".join([it.get("excerpt", "") + " " + it.get("content", "") for it in evidence]).lower()
        corpus_words = set(re.findall(r"\w+", corpus_text))

        standard_angles = [
            "manufacturing yield and defect rates",
            "lifecycle degradation and aging mechanisms",
            "thermal runaway and safety metrics",
            "regulatory compliance and standard benchmarks",
            "cost per unit and economic scalability",
        ]

        gaps = []
        for angle in standard_angles:
            angle_words = set(re.findall(r"\w+", angle))
            # If fewer than 2 words of the angle appear in the corpus, flag as gap
            if len(angle_words & corpus_words) < 2:
                gaps.append(f"{' '.join(list(core_topic_words)[:2])} {angle}")

        return gaps[:3]
