FROM python:3.14-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# The backend keeps its monorepo layout (/app/apps/lifeos/backend): kernel/db.py
# finds db/migrations and the default var/ path relative to its own file, so
# the service runs from this source tree, not a site-packages copy (#562).
WORKDIR /app/apps/lifeos/backend
COPY pyproject.toml ./
COPY src ./src
COPY db ./db
# The one-time Needs Me schema migration (run by an owner-approved Core Deploy step).
# Only its own modules are copied: no other operator script ships in the image.
COPY scripts/__init__.py scripts/type_redefinition.py scripts/migrate_intention_needs_me.py ./scripts/
RUN pip install . && useradd --system lifeos
ENV PYTHONPATH=/app/apps/lifeos/backend/src
WORKDIR /app
# The document blob store (ADR 015). Created owned by `lifeos` so the compose
# named volume mounted here inherits that ownership and the non-root app can
# write to it.
RUN mkdir -p /app/var/lifeos/blobs && chown -R lifeos /app/var

USER lifeos
EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
