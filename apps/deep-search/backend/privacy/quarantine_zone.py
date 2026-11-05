"""Sanitized Quarantine Zone for Ingested Payloads.

Ingests raw untrusted collector payloads, defangs prompt injections,
redacts secret variants, and securely stages data in encrypted scratch.
"""

import re
from typing import Optional
from backend.privacy.encrypted_scratchpad import SecureZeroBuffer, EphemeralEncryptedScratch


class SanitizedQuarantine:
    """Quarantine processing pipeline for untrusted scraped payloads."""

    INJECTION_PATTERNS = [
        re.compile(r"ignore\s+previous\s+instructions", re.IGNORECASE),
        re.compile(r"disregard\s+above", re.IGNORECASE),
        re.compile(r"system\s*prompt\s*:", re.IGNORECASE),
        re.compile(r"admin\s*override", re.IGNORECASE),
        re.compile(r"you\s+are\s+now\s+a", re.IGNORECASE),
    ]

    def __init__(self, scratch: Optional[EphemeralEncryptedScratch] = None):
        self.scratch = scratch or EphemeralEncryptedScratch()
        self._owns_scratch = scratch is None

    def process_payload(
        self,
        raw_payload: str | bytes,
        doc_id: str,
        redact_func=None,
        watchlist: list[str] | None = None
    ) -> str:
        """Sanitize raw payload in a SecureZeroBuffer, redact secrets, and store in encrypted scratch."""
        # 1. Load into ephemeral zero-scrubbed buffer
        with SecureZeroBuffer(raw_payload) as raw_buf:
            text = raw_buf.read_text()

            # 2. Defang prompt injection attempts
            for pattern in self.INJECTION_PATTERNS:
                text = pattern.sub("[REDACTED:prompt-injection-attempt]", text)

            # 3. Strip control characters
            text = "".join(c for c in text if c.isprintable() or c in "\n\r\t ")

            # 4. Redact watchlist matches and variants if redaction function provided
            if redact_func and watchlist:
                text = redact_func(text, watchlist)

            # 5. Store sanitized text in encrypted in-memory scratch
            self.scratch.store(doc_id, text)

        return text

    def get_sanitized(self, doc_id: str) -> str:
        """Retrieve sanitized text from encrypted scratch."""
        return self.scratch.retrieve(doc_id)

    def close(self) -> None:
        """Scrub all ephemeral scratch memory."""
        if self._owns_scratch and self.scratch:
            self.scratch.wipe()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
