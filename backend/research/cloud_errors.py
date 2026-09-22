"""Errors from optional cloud LLM calls. Never include secrets in the message."""


class CloudCallError(Exception):
    """A planning or summary API call failed. The run should continue locally."""

    def __init__(self, stage: str, cause: BaseException | None = None):
        self.stage = stage
        self.cause_type = type(cause).__name__ if cause else "Error"
        super().__init__(f"{stage} failed ({self.cause_type})")
