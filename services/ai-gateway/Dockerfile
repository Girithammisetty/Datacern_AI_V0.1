# Build: resolve deps into a self-contained venv with uv
FROM python:3.12-slim AS build
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /srv
COPY libs/py-common /libs/py-common
COPY services/ai-gateway/pyproject.toml services/ai-gateway/uv.lock ./
RUN sed -i 's#\.\./\.\./libs/py-common#/libs/py-common#' pyproject.toml uv.lock \
    && uv export --no-dev --frozen --format requirements.txt -o requirements.txt \
    && uv pip install --system --no-cache -r requirements.txt
COPY services/ai-gateway/app ./app
COPY services/ai-gateway/migrations ./migrations
COPY services/ai-gateway/alembic.ini ./

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
EXPOSE 8092
ENTRYPOINT ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8092"]
