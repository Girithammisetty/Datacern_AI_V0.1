# agent-runtime + agent-registry (BRD 14). Serves the API and (in-process) the
# Temporal worker. Real adapters by default (AR_USE_REAL_ADAPTERS=true).
FROM python:3.12-slim AS base

# PATH points at the venv uv builds below, NOT /root/.local/bin: this image runs
# as a non-root user (see USER at the end), which cannot read /root at all.
# Putting the venv first also fixes the migrate Job, whose command is a bare
# `python` — previously that resolved to the system interpreter, which has none
# of this service's dependencies installed.
# PYTHONDONTWRITEBYTECODE because the chart sets readOnlyRootFilesystem: true.
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/app/.venv/bin:$PATH"

RUN pip install --no-cache-dir uv

RUN useradd --uid 10001 --no-create-home datacern

WORKDIR /app

# py-common path dependency must be present at build context root ../../libs.
COPY libs/py-common /libs/py-common
COPY services/agent-runtime/pyproject.toml services/agent-runtime/uv.lock* ./
# Rewrite the path source to the copied location.
RUN sed -i 's#../../libs/py-common#/libs/py-common#' pyproject.toml

RUN uv sync --no-dev || uv sync

COPY services/agent-runtime/ ./

USER 10001

EXPOSE 8086

# app.main:app wires REAL adapters by default (CONVENTIONS END STATE).
# Invoked directly rather than through `uv run`: uv resolves and may write to the
# environment on every start, which fails as a non-root user on a read-only root
# filesystem. The venv is already on PATH, so this is the same interpreter.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8086"]
