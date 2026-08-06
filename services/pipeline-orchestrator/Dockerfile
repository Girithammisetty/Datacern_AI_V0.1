# pipeline-orchestrator — multi-stage build.
FROM python:3.12-slim AS build
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /srv
COPY libs/py-common /libs/py-common
COPY services/pipeline-orchestrator/pyproject.toml services/pipeline-orchestrator/uv.lock ./
RUN sed -i 's#\.\./\.\./libs/py-common#/libs/py-common#' pyproject.toml uv.lock \
    && uv export --no-dev --frozen --format requirements.txt -o requirements.txt \
    && uv pip install --system --no-cache -r requirements.txt

FROM python:3.12-slim
# Non-root, matching ingestion-service's uid 10001. Without this the image runs
# as root and the chart's podSecurityContext.runAsNonRoot: true refuses to start
# any pod from it. python:*-slim has no default user, unlike the distroless
# :nonroot bases the other Python services use.
RUN useradd --uid 10001 --no-create-home datacern
WORKDIR /app
COPY --from=build /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
# py-common is an EDITABLE path dependency (pyproject.toml: datacern-common =
# { path = "../../libs/py-common", editable = true }), so `uv pip install
# --system` leaves only a .pth file in site-packages pointing at /libs/py-common.
# Copying site-packages alone therefore ships a pointer to a directory that does
# not exist in this stage, and the service dies on first import with
#   ModuleNotFoundError: No module named 'datacern_common'
# Pre-existing and independent of the non-root change above — the previously
# published root image fails this import identically.
COPY --from=build /libs/py-common /libs/py-common
COPY services/pipeline-orchestrator/app ./app
COPY services/pipeline-orchestrator/migrations ./migrations
COPY services/pipeline-orchestrator/alembic.ini ./
# The chart also sets readOnlyRootFilesystem: true, so bytecode writes would fail;
# Python tolerates an unwritable __pycache__ but skipping the attempt is cleaner.
ENV PYTHONDONTWRITEBYTECODE=1
USER 10001
EXPOSE 8087
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8087"]
