# BRD 03 — ingestion-service

**Service:** ingestion-service · **Language:** Python (FastAPI) · **Phase:** 1
**Inherits:** `00_MASTER_BRD.md` (all MASTER-FR apply) · **Architecture:** `../../WINDROSE_PLATFORM_ARCHITECTURE.md` §6, §9
**V1 sources mined:** `ido/app/models/{connection,datasource,ingestion}.rb`, `ido/db/seeds/files/datasources.json`, `ido/app/poros/{batch_ingestion_creator,ingestion_creator}.rb`, `ido/config/settings.yml`

---

## 1. Overview

**Purpose.** ingestion-service owns how external data enters Windrose: source **connections** (databases, cloud storage, SFTP/FTP, HTTP APIs), **ingestion jobs** (file upload, query pull, scheduled/incremental, webhook push), and the streaming path that lands data in the **Iceberg bronze layer**. It replaces the connection/ingestion half of the V1 `ido` Rails service.

**Business value.** Every downstream capability (profiling, training, dashboards, triage) starts with ingested data. V1 failures — in-memory file buffering (OOM at ~2GB), unauthenticated lambda callbacks, cron-less "batch versions", opaque errors — directly block customer onboarding. The rebuild must ingest a 10GB file without exceeding a 512MB memory envelope, resume interrupted uploads, and report progress in real time.

**In scope:** connection CRUD + credential handling (Vault) + test-connection; ingestion job lifecycle; chunked resumable multipart upload; query-based pulls; Temporal-managed schedules with incremental watermarks; webhook push endpoints; format decoding (csv/tsv/json/jsonl/parquet/avro); Iceberg append + dataset-service registration handoff; failure handling and DLQ.

**Out of scope:** profiling (dataset-service, BRD 04); querying ingested data (query-service, BRD 05); CDC/streaming sources like Kafka-connect and Debezium source connectors (future, §11); transformation (pipeline-orchestrator).

## 2. Actors & user stories

Personas: **Data Engineer (DE)**, **Analyst (AN)**, **Tenant Admin (TA)**, **Data-Onboarding Agent (AG)** (MCP, read + write-proposal), **Platform Operator (OP)**.

- **US-1** As a DE, I create a connection to my PostgreSQL warehouse by supplying host/port/database/credentials, and the service verifies connectivity before saving, so broken configs never persist silently.
- **US-2** As a DE, I upload a 10GB CSV from the browser in resumable chunks; if my laptop sleeps mid-upload, I resume from the last confirmed chunk instead of restarting.
- **US-3** As an AN, I watch live progress (bytes received, rows appended, current phase) of my ingestion via the UI without refreshing.
- **US-4** As a DE, I define a query ingestion ("SELECT … FROM orders") against a JDBC connection so the result lands as a dataset.
- **US-5** As a DE, I schedule that query daily at 02:00 tenant-local time with an incremental watermark column (`updated_at`), so only new rows are appended per run.
- **US-6** As a TA, I rotate a connection's credentials without downtime; old credentials are never readable via any API.
- **US-7** As a DE, I register a webhook endpoint so an external system can push JSON events that accumulate into a dataset.
- **US-8** As an AG, I propose an ingestion config (connection + query + schedule) from a natural-language request; a human approves before it is created (write-proposal tier).
- **US-9** As an OP, I inspect failed ingestions, see the categorized error (source unreachable, schema mismatch, decode error), and requeue from the DLQ after remediation.
- **US-10** As a DE, I test an existing connection on demand and preview the first 100 rows of a source file/table before committing to ingest it.
- **US-11** As a TA, I delete a connection and am blocked if any running ingestion or enabled schedule still uses it.

## 3. Functional requirements

### Connections
- **ING-FR-001 (Must)** CRUD for connections: `{name, connector_type, config (non-secret fields), vault_ref, tags}`. Names unique per workspace (case-insensitive).
- **ING-FR-002 (Must)** Supported `connector_type` enum (V1 parity, mined from `datasources.json`): `postgres`, `mysql`, `mariadb`, `oracle`, `sqlserver`, `synapse`, `presto` (execution via Trino driver), `bigquery`, `snowflake`, `s3`, `azure_blob`, `gcs`, `sftp`, `ftp`, `http_api`. Each type declares a JSON Schema for its config (see §4 catalog); server-side validation rejects unknown fields (`VALIDATION_FAILED` with per-field details).
- **ING-FR-003 (Must)** Secret fields (`password`, `secret_access_key`, `account_key`, `credentials_json`, private keys, tokens, any header named `Authorization`) are written to Vault at `secret/data/tenants/<tenant_id>/connections/<connection_id>` and only `vault_ref` is stored in Postgres. Secrets are never returned by any read endpoint (write-only fields; reads return `"•••"` masked marker + `secret_set: true`).
- **ING-FR-004 (Must)** `POST /connections:test` and `POST /connections/{id}/test` run a live connectivity probe (driver connect + trivial round-trip: `SELECT 1` / bucket HEAD / SFTP LIST / HTTP HEAD-or-GET) with a 15s timeout, returning `{status: ok|failed, latency_ms, error_category?, error_detail?}`. Create/update performs this test automatically unless `skip_test=true` (persisted flag `last_test_status`).
- **ING-FR-005 (Must)** `POST /connections/{id}/preview` returns ≤100 rows + inferred column list from a named table/path/query, never persisting data. Timeout 30s.
- **ING-FR-006 (Must)** Deleting a connection is refused (`CONFLICT`) while any ingestion in a non-terminal state or any enabled schedule references it (V1 rule: `can_destroy?` blocks on processing ingestions). Delete is soft (`deleted_at`); Vault secret is destroyed after 7-day grace period.
- **ING-FR-007 (Should)** Traffic direction per connection: `incoming` (source), `outgoing` (export target), `both` (V1 `traffic_type` enum). Export flows are out of scope here but the field is owned by this service.
- **ING-FR-008 (Should)** SFTP supports password and private-key auth; FTP is plain/FTPS. V1 inferred SFTP from `port == 22` — the rebuild makes protocol explicit via `connector_type`.

### Ingestion jobs
- **ING-FR-020 (Must)** `POST /ingestions` creates a job with `ingestion_mode ∈ {file_upload, query, scheduled_run, webhook_batch}` and `target` = either `{dataset_urn}` (append to existing) or `{new_dataset: {name, description}}` (registers via dataset-service on completion).
- **ING-FR-021 (Must)** Supported file formats: `csv, tsv, json, jsonl, parquet, avro` (V1 enum + jsonl). Format is declared at creation; decode failures are per-row-tolerant up to `error_row_limit` (default 100, configurable 0–10 000), after which the job fails with samples of bad rows in `error_log`.
- **ING-FR-022 (Must)** Ingestion status state machine per §4.3; every transition emits an event and is recorded in `ingestion_transitions`.
- **ING-FR-023 (Must)** Query ingestions execute the saved statement against the source connection with a per-job timeout (default 1 600s — V1 `TIMEOUT_INTERVAL` — max 3 600s), stream the cursor in ≤10 000-row batches to Parquet part-files in object storage, then Iceberg-append. Never materialize the full result in memory.
- **ING-FR-024 (Must)** Webhook mode: `POST /ingestions/{id}/events` accepts JSON payloads (single or array, ≤1MB per call) authenticated by a per-ingestion HMAC signing secret (Vault-stored); events buffer to object storage and flush to Iceberg every `flush_interval` (default 60s) or 100MB, whichever first.
- **ING-FR-025 (Must)** `skip_profiling: bool` (V1 parity) — when false (default), completion triggers dataset-service profiling via the `ingestion.completed` event.
- **ING-FR-026 (Must)** Progress: `GET /ingestions/{id}` returns snapshot; live progress streams via realtime-hub SSE (`ingestion.progress` events, ≥1 per 5s while active, containing `{phase, bytes_received, bytes_total?, rows_appended, chunk_count}`).
- **ING-FR-027 (Should)** `POST /ingestions/{id}/cancel` transitions any non-terminal job to `cancelled`; partial Iceberg appends are rolled back by expiring the uncommitted snapshot (single atomic commit per job — see BR-9).
- **ING-FR-028 (Could)** Re-ingest: `POST /ingestions/{id}/reingest` clones config into a new job (V1 `reingest` route parity).

### Streaming multipart upload path
- **ING-FR-040 (Must)** Upload protocol: `POST /uploads` → `{upload_id, part_size (default 32MiB, min 8MiB, max 64MiB), expires_at (24h)}`. Client PUTs parts to `PUT /uploads/{upload_id}/parts/{n}` (or directly to presigned per-part object-storage URLs when `direct=true` — preferred), then `POST /uploads/{upload_id}/complete {parts: [{n, etag, size}], sha256?}`.
- **ING-FR-041 (Must)** The service never buffers a whole file: request bodies stream to the cloud multipart API with ≤2 parts in flight per worker. **Memory ceiling: RSS < 512MiB while ingesting a 10GiB file** (release-gate perf test).
- **ING-FR-042 (Must)** Resumability: `GET /uploads/{upload_id}` returns confirmed parts; the client re-sends only missing parts. Uploads survive service restarts (part state in Postgres, bytes in object storage).
- **ING-FR-043 (Must)** On `complete`, a Temporal workflow performs: (1) optional checksum verify, (2) format decode + schema sniff on a streamed sample, (3) columnar rewrite to Parquet (streaming, chunked), (4) single Iceberg append commit to the bronze table `bronze.<tenant_id>.ds_<dataset_id>` with snapshot metadata `{ingestion_id, source}`, (5) dataset registration/notify. Each step is a retryable activity.
- **ING-FR-044 (Must)** Abandoned uploads (no part activity for 24h) are garbage-collected: cloud multipart aborted, status → `expired`.

### Schedules
- **ING-FR-060 (Must)** `POST /schedules` attaches a Temporal Schedule to a query/file-poll ingestion config: `{cron | interval, timezone, watermark?: {column, operator (default >), initial_value}, overlap_policy: skip|buffer_one, enabled}`. Replaces V1 `batch_version/batch_date` + external pipeline-manager cron.
- **ING-FR-061 (Must)** Incremental pulls wrap the statement exactly as V1 did — `SELECT * FROM (<stmt>) src WHERE <watermark_col> <op> :watermark` — but with the watermark **bound as a driver-level parameter, never string-spliced**. The high-watermark observed in each successful run is persisted and used next run.
- **ING-FR-062 (Must)** Each scheduled fire creates a normal ingestion job (`trigger: schedule`, `scheduled_for`); skip/misfire decisions follow `overlap_policy` and emit `ingestion.schedule_skipped`.
- **ING-FR-063 (Should)** Pause/resume/`run_now` endpoints; disabling a connection pauses its schedules.
- **ING-FR-064 (Should)** File-poll schedules for `s3|gcs|azure_blob|sftp|ftp`: glob pattern + "new files since last run" via listing mtime/etag ledger; each new file becomes one job.

### Failure handling
- **ING-FR-080 (Must)** Errors are categorized: `SOURCE_UNREACHABLE, AUTH_FAILED, SCHEMA_MISMATCH, DECODE_ERROR, ROW_LIMIT_EXCEEDED, TIMEOUT, QUOTA_EXCEEDED, INTERNAL`. `error_log` (JSONB ≤64KB) stores category, message, up to 20 sample bad rows (values truncated to 256 chars), and remediation hint.
- **ING-FR-081 (Must)** Transient failures retry via Temporal (5 attempts, exponential backoff 10s→10m, jitter). Exhausted jobs → `failed` + `ingestion.failed` event; the event consumer's poison path uses the standard DLQ (MASTER-FR-033). `POST /ingestions/{id}/retry` requeues a failed job idempotently.
- **ING-FR-082 (Must)** Per-tenant concurrency cap: max 5 concurrently `running` ingestions and 20 active uploads (tier-configurable); excess queues FIFO in `queued` status.
- **ING-FR-083 (Should)** PII scan (Presidio) runs on the sampled rows during decode; detected PII column tags are forwarded in the completion event for dataset-service to persist.

## 4. Domain model & data

### 4.1 Tables (Postgres, RLS per MASTER-FR-001)

**connections** — `id uuidv7 PK`, `tenant_id`, `workspace_id uuid NOT NULL`, `name text NOT NULL`, `connector_type text NOT NULL CHECK (IN …)`, `config jsonb NOT NULL` (non-secret only, ≤16KB, schema-validated), `vault_ref text`, `traffic_direction text DEFAULT 'incoming'`, `last_test_status text`, `last_tested_at`, `created_by uuid`, std timestamps + `deleted_at`.
Indexes: `UNIQUE (tenant_id, workspace_id, lower(name)) WHERE deleted_at IS NULL`; `(tenant_id, connector_type)`.

**ingestions** — `id uuidv7 PK`, `tenant_id`, `workspace_id`, `connection_id uuid NULL FK`, `dataset_urn text`, `ingestion_mode text NOT NULL`, `file_format text`, `statement text` (query mode), `status text NOT NULL DEFAULT 'created'`, `trigger text DEFAULT 'manual'` (`manual|schedule|webhook|agent`), `schedule_id uuid NULL`, `scheduled_for timestamptz`, `skip_profiling bool DEFAULT false`, `bytes_total bigint`, `bytes_received bigint DEFAULT 0 CHECK (>=0)`, `rows_appended bigint DEFAULT 0`, `iceberg_snapshot_id bigint`, `error_log jsonb`, `error_row_limit int DEFAULT 100`, `started_at`, `finished_at`, `created_by`, timestamps.
Indexes: `(tenant_id, status, created_at DESC)`, `(tenant_id, dataset_urn, created_at DESC)`, `(connection_id) WHERE status NOT IN (terminal)`. **Partitioned by month on `created_at`; retention 13 months then archived to Iceberg.**

**uploads** — `id uuidv7 PK`, `tenant_id`, `ingestion_id FK`, `part_size int`, `parts_confirmed jsonb` (array of `{n, etag, size}`), `storage_key text`, `cloud_upload_id text`, `sha256 text`, `status text (open|completing|completed|expired|aborted)`, `expires_at`, timestamps. Index `(tenant_id, status, expires_at)`.

**schedules** — `id uuidv7 PK`, `tenant_id`, `workspace_id`, `ingestion_template jsonb NOT NULL` (≤16KB), `connection_id FK`, `cron text`, `interval_seconds int`, `timezone text NOT NULL`, `watermark_column text`, `watermark_operator text DEFAULT '>'`, `watermark_value text`, `overlap_policy text DEFAULT 'skip'`, `enabled bool DEFAULT true`, `temporal_schedule_id text NOT NULL`, `last_fired_at`, timestamps. Index `(tenant_id, enabled)`.

**ingestion_transitions** — `id`, `tenant_id`, `ingestion_id`, `from_status`, `to_status`, `actor jsonb`, `detail jsonb`, `created_at`. Monthly partitions, 6-month retention.

**webhook_endpoints** — `id`, `tenant_id`, `ingestion_id FK`, `path_token text UNIQUE`, `hmac_vault_ref text`, `flush_interval_s int DEFAULT 60`, `enabled bool`, timestamps.

Plus standard `outbox` and `idempotency_keys` tables (MASTER-FR-034/025).

### 4.2 Connector config catalog (JSON Schema summary; secret fields → Vault)

| connector_type | non-secret fields (defaults) | secret fields |
|---|---|---|
| postgres | host, port=5432, database, username, ssl_mode=require | password |
| mysql / mariadb | host, port=3306, database, username | password |
| oracle | host, port=1521, service_name, username | password |
| sqlserver | host, port=1433, database, username, azure_ad=false | password |
| synapse | host, port=1433, database, username | password |
| presto (Trino) | host, port=8080, catalog, schema?, username, tls=true | password |
| bigquery | project_id, dataset | credentials_json |
| snowflake | account, username, warehouse, database, schema=PUBLIC, role? | password / private_key |
| s3 | region=us-east-1, bucket, root_prefix=/ , endpoint? | access_key_id, secret_access_key (or role_arn, no secret) |
| azure_blob | account_name, container_name | account_key / sas_token |
| gcs | project_id, bucket, root_prefix=/ | credentials_json |
| sftp | host, port=22, username, root_directory=/ | password / private_key |
| ftp | host, port=21, username, root_directory=/, ftps=false | password |
| http_api | method=GET, url, headers (non-auth), body?, pagination? | auth_header_value, basic credentials |

V1's raw `curl_command` field is **retired**: http_api is a structured request spec (BR-6).

### 4.3 Ingestion status state machine

| From | To | Trigger | Guard |
|---|---|---|---|
| created | awaiting_upload | file_upload mode job created | upload session opened |
| created / awaiting_upload | queued | job submitted / upload `complete` accepted | payload validation passed |
| queued | running | worker picks up | tenant concurrency slot acquired (ING-FR-082) |
| running | committing | all part-files decoded & written | ≥1 decoded row or `allow_empty=true` (else → failed/DECODE_ERROR) |
| committing | completed | Iceberg snapshot committed | single atomic commit succeeded + dataset registration ack (new datasets) |
| running / committing | retrying | transient error | attempts < 5 |
| retrying | running | backoff elapsed | — |
| retrying | failed | attempts exhausted | error_log populated |
| created / awaiting_upload / queued / running | cancelled | user cancel | uncommitted only; partial storage GC'd |
| awaiting_upload | expired | 24h part inactivity | multipart aborted |

Terminal: `completed, failed, cancelled, expired`. Any illegal transition returns 409 `CONFLICT` with `{current_status, requested}`. Every transition is appended to `ingestion_transitions` and emitted as an event within the same outbox transaction.

### 4.4 Error code catalog (API-level `error.code` values)

`VALIDATION_FAILED` (422) · `NOT_FOUND` (404, incl. cross-tenant) · `CONFLICT` (409: name, in-use connection, illegal transition, part etag mismatch) · `CONNECTION_TEST_FAILED` (424, carries `error_category`) · `UPLOAD_EXPIRED` (410) · `CHECKSUM_MISMATCH` (422) · `PAYLOAD_TOO_LARGE` (413, webhook >1MB) · `SIGNATURE_INVALID` (401, webhook HMAC) · `RATE_LIMITED` (429, upload/job caps) · `PERMISSION_DENIED` (403, OPA).

## 5. API specification (base `/api/v1`, prefix omitted)

| Method & path | Purpose | Notable errors |
|---|---|---|
| `POST /connections` | create (+auto test) | 422 VALIDATION_FAILED, 409 name CONFLICT, 424 CONNECTION_TEST_FAILED |
| `GET /connections` · `GET /connections/{id}` | list (filter: connector_type, traffic_direction, q) / read (secrets masked) | 404 |
| `PATCH /connections/{id}` · `DELETE /connections/{id}` | update (re-test on config change) / soft delete | 409 CONFLICT (in-use) |
| `POST /connections/{id}/test` · `POST /connections:test` | test saved / test ad-hoc payload | 424 with error_category |
| `POST /connections/{id}/preview` | ≤100-row source preview | 408 TIMEOUT, 424 |
| `POST /ingestions` | create job (Idempotency-Key honored) | 422, 404 connection |
| `GET /ingestions` · `GET /ingestions/{id}` | list (filter: status, dataset_urn, mode, schedule_id) / read | |
| `POST /ingestions/{id}/cancel` · `/retry` · `/reingest` | lifecycle ops | 409 illegal transition |
| `POST /uploads` · `PUT /uploads/{id}/parts/{n}` · `GET /uploads/{id}` · `POST /uploads/{id}/complete` · `DELETE /uploads/{id}` | resumable upload | 409 part mismatch, 410 expired, 422 checksum |
| `POST /schedules` · `GET /schedules` · `PATCH /schedules/{id}` · `DELETE /schedules/{id}` | schedule CRUD | 422 bad cron/tz |
| `POST /schedules/{id}/run_now` · `/pause` · `/resume` | schedule ops | 409 |
| `POST /hooks/{path_token}/events` | webhook receive (HMAC auth, not JWT) | 401 bad signature, 413 payload |
| `GET /ingestions/{id}/progress` | SSE via realtime-hub redirect | |

Example — create connection (secrets split out explicitly):
```json
POST /api/v1/connections
{"name":"Prod Warehouse","connector_type":"postgres","traffic_direction":"incoming",
 "config":{"host":"db.acme.internal","port":5432,"database":"sales","username":"windrose_ro","ssl_mode":"require"},
 "secrets":{"password":"s3cr3t"}}
→ 201 {"data":{"id":"018f6b…","name":"Prod Warehouse","connector_type":"postgres",
       "config":{"host":"db.acme.internal","port":5432,"database":"sales","username":"windrose_ro","ssl_mode":"require"},
       "secret_set":true,"last_test_status":"ok","last_tested_at":"2026-07-09T10:12:03Z"}}
```

Example — create query ingestion:
```json
POST /api/v1/ingestions
{"ingestion_mode":"query","connection_id":"018f…","statement":"SELECT * FROM public.orders",
 "new_dataset":{"name":"Orders"},"file_format":"parquet","skip_profiling":false}
→ 202 {"data":{"id":"018f…","status":"queued","operation_id":"018f…"}}
```

Example — create schedule with watermark:
```json
POST /api/v1/schedules
{"connection_id":"018f…","cron":"0 2 * * *","timezone":"Europe/Berlin",
 "ingestion_template":{"ingestion_mode":"query","statement":"SELECT * FROM public.orders","dataset_urn":"wr:t-42:dataset:dataset/018f…","file_format":"parquet"},
 "watermark":{"column":"updated_at","operator":">","initial_value":"2026-07-01T00:00:00Z"},
 "overlap_policy":"skip","enabled":true}
→ 201 {"data":{"id":"018f…","temporal_schedule_id":"ing-sched-018f…","next_fire_at":"2026-07-10T00:00:00Z"}}
```

Upload completion: `POST /uploads/{id}/complete {"parts":[{"n":1,"etag":"a1…","size":33554432},…],"sha256":"9c…"} → 202`.

SSE progress event shape (via realtime-hub):
```json
event: ingestion.progress
data: {"ingestion_id":"018f…","phase":"decoding","bytes_received":7247757312,
       "bytes_total":10737418240,"rows_appended":48211004,"chunk_count":216,"ts":"2026-07-09T10:14:55Z"}
```

**MCP facade (read + write-proposal):** `list_connections`, `get_connection_schema(connector_type)`, `test_connection`, `list_ingestions`, `get_ingestion`, `propose_ingestion` (creates Proposal, never a live job).

## 6. Events

**Emitted → `ingestion.events.v1`** (envelope per MASTER-FR-031): `connection.created/updated/deleted/test_failed`; `ingestion.created`, `ingestion.started`, `ingestion.progress` (throttled ≥5s; payload `{phase,bytes_received,rows_appended}`), `ingestion.completed` (payload `{ingestion_id, dataset_urn, iceberg_snapshot_id, rows_appended, bytes, file_format, skip_profiling, pii_tags[], source:{connection_urn?|upload}}`), `ingestion.failed` (payload `{error_category, error_digest, attempts}`), `ingestion.cancelled`, `ingestion.schedule_fired/skipped`, `upload.expired`.

**Consumed:** `dataset.events.v1 :: dataset.deleted` → disable schedules targeting that URN, refuse new jobs (404 on create). `identity.events.v1 :: tenant.suspended` → pause all schedules, cancel `queued` jobs. `rbac.events.v1 :: workspace.deleted` → soft-delete workspace connections/schedules. All consumers idempotent + DLQ per master.

## 7. Business rules & edge cases

- **BR-1** Credentials never leave Vault: not in Postgres, not in events, not in logs, not in error messages (connection errors are scrubbed of DSN userinfo before persisting — V1 leaked `user:pass@host` via `to_url`).
- **BR-2** A file ingestion must declare `file_format`; query results are written as Parquet; webhook events as JSONL→Parquet on flush (V1: query→csv, curl→json).
- **BR-3** Empty source (0 rows / 0 columns / header-only CSV) fails with `DECODE_ERROR` and hint, unless `allow_empty=true` creates an empty-schema dataset version.
- **BR-4** CSV columns with blank headers are auto-named `col_<n>` and flagged in the completion event (V1 hard-failed on `Unnamed: 0`).
- **BR-5** Watermark values are typed (int, decimal, timestamp, date, string) and bound as parameters; a watermark column absent from the source schema fails the run with `SCHEMA_MISMATCH` before executing.
- **BR-6** http_api requests: response size cap 1GiB streamed, redirect depth 3, only https in prod tenants, no requests to link-local/RFC1918 addresses (SSRF guard), per-run timeout 300s.
- **BR-7** Concurrency: one `running` job per (dataset_urn) at a time — later jobs queue — so Iceberg commits never conflict; commits use optimistic retry ×3 on `CommitFailedException`.
- **BR-8** Chunk upload parts must be equal to `part_size` except the last; out-of-order parts allowed; duplicate part re-PUT with same etag is idempotent, different etag → 409.
- **BR-9** Exactly one Iceberg snapshot commit per job (all part-files in one append). Cancel/failure before commit leaves the table untouched; failure during commit verifies snapshot presence by `ingestion_id` in snapshot summary to avoid double-append on retry.
- **BR-10** Schedule `overlap_policy=skip`: if the previous run is non-terminal, the fire is skipped (event emitted); `buffer_one` queues at most one pending run.
- **BR-11** Webhook flush is at-least-once into the buffer but exactly-once into Iceberg per BR-9; duplicate webhook deliveries are deduped by optional client `event_id` within 24h.
- **BR-12** Deleting a schedule never deletes past ingestions or data; deleting a connection cascades soft-delete to its schedules (after ING-FR-006 guard passes).
- **BR-13** All target Iceberg tables live under the tenant's namespace `bronze.<tenant_id>`; cross-tenant URN in `dataset_urn` → 404 (MASTER-FR-003).
- **BR-14** `expired`, `failed`, `cancelled` jobs keep metadata but their orphaned part-files are GC'd within 48h.

## 8. Dependencies

- **Upstream:** identity-service (JWT/JWKS), rbac-service via OPA sidecar, Vault (per-tenant KV paths + External Secrets), Temporal (schedules + upload-finalize workflows), object storage (S3/GCS/Blob multipart), Iceberg REST catalog, Kafka + Schema Registry, Redis (dedup, concurrency slots).
- **Downstream contracts:** dataset-service consumes `ingestion.completed` to register versions and trigger profiling; realtime-hub relays `ingestion.progress`; usage-service meters `ingested_bytes`; audit-service consumes all events.
- **Drivers:** asyncpg/aiomysql/oracledb/pyodbc/trino/google-cloud-bigquery/snowflake-connector, boto3/azure-storage-blob/google-cloud-storage (async), asyncssh, aioftp, httpx, pyarrow, pyiceberg.

## 9. NFRs (deltas from master)

- Upload part PUT p95 ≤ 150ms service overhead (excluding storage transfer); sustained ≥ 100MB/s per upload with direct presigned parts.
- 10GiB file end-to-end (upload→completed) ≤ 30 min on reference hardware; worker RSS < 512MiB throughout (perf test in CI, release gate).
- Progress event lag ≤ 5s. Schedule fire accuracy ±60s. Connection test p95 ≤ 3s (reachable sources).
- Availability 99.9% acceptable for ingestion APIs (long-running domain); webhook receive endpoint 99.95%.

## 10. Acceptance criteria

- **AC-1** Given a valid postgres payload with password, when `POST /connections`, then 201, the password exists only in Vault, `GET` returns `secret_set: true` with no secret material, and a `connection.created` event is emitted.
- **AC-2** Given an unreachable host, when creating without `skip_test`, then 424 `CONNECTION_TEST_FAILED` with `error_category=SOURCE_UNREACHABLE` and nothing is persisted.
- **AC-3** Given tenant A's token, when reading tenant B's connection id, then 404 and a `security.cross_tenant_denied` audit event (per MASTER-FR-003).
- **AC-4** Given a 10GiB CSV uploaded in 32MiB parts, when the upload completes, then the job reaches `completed`, exactly one Iceberg snapshot is added, `rows_appended` matches source row count, and max worker RSS stayed < 512MiB.
- **AC-5** Given an interrupted upload with 200/320 parts confirmed, when the client calls `GET /uploads/{id}` and re-sends the missing 120 parts, then complete succeeds without re-sending confirmed parts.
- **AC-6** Given a running ingestion, when subscribed to SSE progress, then events arrive at least every 5s with monotonically non-decreasing `bytes_received` and `rows_appended`.
- **AC-7** Given a query ingestion whose source returns 0 rows and `allow_empty=false`, when it runs, then status `failed`, `error_category=DECODE_ERROR`, and no Iceberg snapshot is created.
- **AC-8** Given a daily schedule with watermark `updated_at > '2026-07-01T00:00:00Z'`, when it fires twice, then the second run's SQL binds the max watermark observed in run 1 as a parameter (assert via query log: no literal splicing) and appends only newer rows.
- **AC-9** Given `overlap_policy=skip` and a still-running previous job, when the schedule fires, then no new job is created and `ingestion.schedule_skipped` is emitted.
- **AC-10** Given a connection with one enabled schedule, when `DELETE /connections/{id}`, then 409 CONFLICT; after deleting the schedule, delete succeeds and Vault destroy is queued for +7d.
- **AC-11** Given a webhook POST with an invalid HMAC signature, then 401 and no data buffered; with valid signature and duplicate `event_id` within 24h, the duplicate is acknowledged but not double-counted in `rows_appended`.
- **AC-12** Given a transient source outage, when a job fails mid-run, then Temporal retries up to 5 times with backoff; on final failure status is `failed` with attempts=5 and `POST /retry` produces a new successful run without duplicate rows (BR-9 verified via snapshot summary).
- **AC-13** Given a CSV with 150 undecodable rows and `error_row_limit=100`, when ingesting, then the job fails with `ROW_LIMIT_EXCEEDED` and `error_log` contains ≤20 sample rows with values truncated to 256 chars.
- **AC-14** Given two concurrent `POST /ingestions` with the same Idempotency-Key, then one job exists and the second response carries `Idempotency-Replayed: true`.

## 11. Out of scope / future

CDC & streaming sources (Debezium/Kafka source connectors); outgoing exports (reverse ETL) beyond the `traffic_direction` field; cross-region transfer optimization; schema-evolution policies richer than additive-merge (dataset-service BRD 04 owns evolution rules); Excel/XLSX decoding; per-column ingest-time transformations (pipeline-orchestrator domain); virus/malware scanning of uploads.
