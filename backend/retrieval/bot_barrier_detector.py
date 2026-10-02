"""Bot Barrier & Anti-Scraping Challenge Detector.

Identifies Cloudflare challenges, Elsevier/Nature/Springer bot walls,
CAPTCHA prompts, and JavaScript-disabled error pages.
"""

import re

BOT_OR_JS_BARRIER_PATTERNS = [
    re.compile(r"javascript\s+is\s+disabled", re.IGNORECASE),
    re.compile(r"enable\s+javascript", re.IGNORECASE),
    re.compile(r"please\s+turn\s+javascript\s+on", re.IGNORECASE),
    re.compile(r"checking\s+your\s+browser", re.IGNORECASE),
    re.compile(r"attention\s+required.*cloudflare", re.IGNORECASE),
    re.compile(r"security\s+check\s+to\s+access", re.IGNORECASE),
    re.compile(r"verify\s+you\s+are\s+human", re.IGNORECASE),
    re.compile(r"just\s+a\s+moment\.\.\.", re.IGNORECASE),
    re.compile(r"403\s+forbidden", re.IGNORECASE),
    re.compile(r"access\s+denied", re.IGNORECASE),
    re.compile(r"there\s+was\s+a\s+problem\s+providing\s+the\s+content", re.IGNORECASE),
    re.compile(r"please\s+contact\s+our\s+support\s+team", re.IGNORECASE),
    re.compile(r"cpe00001", re.IGNORECASE),
    re.compile(r"errors\.edgesuite\.net", re.IGNORECASE),
    re.compile(r"you\s+don'?t\s+have\s+permission\s+to\s+access", re.IGNORECASE),
    re.compile(r"are\s+you\s+a\s+robot", re.IGNORECASE),
    re.compile(r"unusual\s+traffic\s+from\s+your", re.IGNORECASE),
    re.compile(r"request\s+unsuccessful\.\s+incapsula", re.IGNORECASE),
    re.compile(r"captcha", re.IGNORECASE),
]

# Long, real documents may legitimately mention "access denied" or "captcha";
# barrier pages are short, so only their opening is inspected.
_HEAD_CHARS = 1500


def is_bot_or_js_barrier(text: str) -> bool:
    """Check if content is a bot barrier, Cloudflare challenge, or JS-disabled error page."""
    if not text or not isinstance(text, str):
        return True
    text_lower = text.lower().strip()
    if not text_lower:
        return True
    if len(text_lower) > 6000:
        text_lower = text_lower[:_HEAD_CHARS]
    for pat in BOT_OR_JS_BARRIER_PATTERNS:
        if pat.search(text_lower):
            return True
    return False
