FROM python:3.14-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install . && useradd --system lifeos
# The document blob store (ADR 015). Created owned by `lifeos` so the compose
# named volume mounted here inherits that ownership and the non-root app can
# write to it.
RUN mkdir -p /app/var/blobs && chown -R lifeos /app/var

USER lifeos
EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
