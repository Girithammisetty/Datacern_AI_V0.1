UV ?= uv

.PHONY: install run migrate test lint

install:
	$(UV) sync

migrate: install
	$(UV) run alembic upgrade head

run: install
	$(UV) run uvicorn app.main:app --host 0.0.0.0 --port 8309

test: install
	$(UV) run pytest -q

lint:
	$(UV) run ruff check app tests
