# syntax=docker/dockerfile:1
#
# Rewritten to match ai-gateway / dataset-service / the other distroless Python
# services, because the previous shape produced an image that could not start at
# all:
#
#     exec /app/.venv/bin/uvicorn: no such file or directory
#
# It built a venv with `uv sync` and copied the whole /app (venv included) into
# the distroless runtime. But a venv is not relocatable across base images: its
# scripts carry the shebang #!/app/.venv/bin/python, and that symlink resolves to
# /usr/local/bin/python3.12 — the path in python:3.12-slim, which does not exist
# in distroless (its interpreter is /usr/bin/python3.12). exec then reports "no
# such file or directory" for the *interpreter*, while naming the script, which
# is why this looked like a missing uvicorn rather than a broken venv.
#
# The working sibling pattern avoids venvs entirely: install into the system
# site-packages with `uv pip install --system`, copy that directory across, and
# point PYTHONPATH at it. Nothing carries an absolute interpreter path.
#
# Verified: image starts and serves under `--read-only` as uid 65532.

# Build: resolve deps into system site-packages with uv
FROM python:3.12-slim AS build
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /srv
COPY libs/py-common /libs/py-common
COPY services/experiment-service/pyproject.toml services/experiment-service/uv.lock ./
RUN sed -i 's#\.\./\.\./libs/py-common#/libs/py-common#' pyproject.toml uv.lock \
    && uv export --no-dev --frozen --format requirements.txt -o requirements.txt \
    && uv pip install --system --no-cache -r requirements.txt
COPY services/experiment-service/app ./app
COPY services/experiment-service/migrations ./migrations
COPY services/experiment-service/alembic.ini ./

# Runtime: distroless (MASTER-FR-072). The :nonroot tag is what sets the user —
# there is no USER directive to grep for, and the untagged image defaults to root,
# which the chart's podSecurityContext.runAsNonRoot: true rejects outright.
FROM gcr.io/distroless/python3-debian12:nonroot
WORKDIR /srv
COPY --from=build /usr/local/lib/python3.12/site-packages /srv/site-packages
COPY --from=build /srv/app /srv/app
COPY --from=build /srv/migrations /srv/migrations
COPY --from=build /srv/alembic.ini /srv/alembic.ini
ENV PYTHONPATH=/srv:/srv/site-packages \
    PYTHONDONTWRITEBYTECODE=1
EXPOSE 8314
ENTRYPOINT ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8314"]
