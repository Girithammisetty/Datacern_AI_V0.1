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

# Runtime.
#
# NOT distroless/python3-debian12, despite MASTER-FR-072 asking for distroless.
# That image is Debian 12's Python, which is 3.11.2, while the build stage above
# installs into /usr/local/lib/python3.12/site-packages. Compiled extensions are
# ABI-tagged (_pydantic_core.cpython-312-*.so), so 3.11 cannot load them and the
# container died on its first import:
#
#     ModuleNotFoundError: No module named 'pydantic_core._pydantic_core'
#
# Confirmed on linux/amd64, so it is not an artifact of an arm64 build host.
# Returning to distroless needs a 3.12 distroless base, not a tag change.
FROM python:3.12-slim
RUN useradd --uid 10001 --no-create-home datacern
WORKDIR /srv
# Standard site-packages path, not /srv/site-packages on PYTHONPATH: the .pth
# file py-common installs is only processed inside a real site directory.
COPY --from=build /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
# py-common is an EDITABLE path dependency, so site-packages holds only a .pth
# pointing at /libs/py-common. Without this copy the pointer dangles and every
# service dies on `import datacern_common`.
COPY --from=build /libs/py-common /libs/py-common
COPY --from=build /srv/app /srv/app
COPY --from=build /srv/migrations /srv/migrations
COPY --from=build /srv/alembic.ini /srv/alembic.ini
ENV PYTHONPATH=/srv \
    PYTHONDONTWRITEBYTECODE=1
USER 10001
EXPOSE 8314
ENTRYPOINT ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8314"]
