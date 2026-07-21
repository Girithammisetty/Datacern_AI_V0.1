# BRD 19 — notification-service (Go)

**Date:** 2026-07-09 · **Status:** Approved for build · **Phase:** 4
**Inherits:** `00_MASTER_BRD.md`. Architecture: `../../DATACERN_PLATFORM_ARCHITECTURE.md` §6 (notification-service row), §9.2 (topic catalog).

---

## 1. Overview

**Purpose.** notification-service is the single fan-out point from platform events to humans and external systems: in-app notifications, email (multi-cloud provider abstraction), and signed webhooks — governed by per-user/per-workspace subscription rules, digest batching, versioned templates with per-tenant overrides, and per-recipient rate limiting.

**Business value.** V1 had no notification service: each Rails service hand-rolled ad-hoc email (e.g., chart-service `email_report`) or nothing at all — analysts learned about case assignments by polling screens. Centralizing delivery gives consistent templates, auditability, tenant-controlled routing, and protects recipients (and provider reputation) via rate limiting and digests. Multi-cloud provider abstraction (SES on AWS cells, ACS on Azure cells, SendGrid as portable fallback) is required by the platform's cell-per-cloud model.

**In scope:** event consumption from all `*.events.v1` topics with a maintained event→notification mapping; subscription rules (event type + resource filters, user/workspace scope); channel delivery — in-app (persisted + realtime-hub push), email (provider abstraction), webhooks (HMAC, retries, circuit breaker); digest batching; template management (versioned, per-tenant overrides, preview/test-send); per-recipient rate limits; delivery status tracking + bounce/complaint handling; user notification preferences incl. mute/quiet hours.

**Out of scope:** SSE/WebSocket transport (realtime-hub delivers in-app pushes; this service persists and publishes them); SMS/push-mobile (future); Slack/Teams (future, via tool-plane third-party connectors); marketing email; the events themselves (producers own semantics); approval-inbox UX for proposals (ui-web; this service only notifies that a proposal awaits).

## 2. Actors & user stories

Personas: **Analyst/User** (recipient), **Workspace Admin** (routing/templates), **Tenant Admin** (tenant overrides, webhooks), **External system** (webhook consumer), **Platform operator**.

- **US-1** As an Analyst, when a case is assigned to me I get an in-app notification instantly and an email if I'm offline, so I never miss SLA-bound work.
- **US-2** As an Analyst, I configure my preferences: mute event types, choose channels per event type, set quiet hours, and switch noisy events to a daily digest.
- **US-3** As a Workspace Admin, I create a subscription rule "notify the fraud-team group by email on `case.sla.breached` where severity ∈ {high, critical}".
- **US-4** As a Tenant Admin, I register a webhook endpoint receiving `pipeline.run.failed` and `case.created` events, verify it via challenge, and rotate its HMAC secret without downtime.
- **US-5** As a Tenant Admin, I override the default "case assigned" email template with our branding and terminology, versioned so I can roll back.
- **US-6** As a recipient of 400 pipeline events in an hour, I receive one digest email summarizing them, not 400 emails.
- **US-7** As a Platform operator, I see delivery metrics per channel/provider, bounce rates, and webhook circuit-breaker states, and can drain a DLQ after an outage.
- **US-8** As an External system owner whose endpoint was down for 2 hours, I receive the missed webhooks afterwards in order, each verifiable by HMAC signature and idempotency key.
- **US-9** As a User, I open the in-app inbox, see unread count, mark items read/unread, and click through to the resource (deep link by URN).
- **US-10** As a Compliance officer, I confirm no notification payload contains raw PII — only resource references and template-rendered summaries.

## 3. Functional requirements

### Event intake & mapping
- **NOTIF-FR-001 (M)** Consume all platform topics (`identity|rbac|ingestion|dataset|query|semantic|experiment|pipeline|inference|chart|case|usage.events.v1` and `ai.events.v1`) in consumer group `notification-service`, dedup per master §2.4-032.
- **NOTIF-FR-002 (M)** Maintain a code-owned **event mapping registry** (see §6 table): for each notifiable `event_type` — default audience derivation (e.g., `case.assigned` → `payload.assignee`), default channels, default template key, severity class (`info|warning|critical`), digestible flag. Unmapped events are ignored (counter metric).
- **NOTIF-FR-003 (M)** Notification pipeline per event: mapping lookup → audience resolution (explicit principal ∪ matching subscription rules, deduped per user) → per-recipient preference filter (mutes, channel choices, quiet hours) → rate-limit/digest gate → render → deliver → record. Each stage idempotent; the whole pipeline retryable by `event_id`.

### Subscription rules & preferences
- **NOTIF-FR-010 (M)** Subscription rules: `{scope: user|workspace|tenant, subject: user_id|group_id, event_types[] (wildcards e.g. case.*), resource_filter: {resource_urn_prefix?, attrs?: {field: [values]} — whitelisted payload fields per event type}, channels[], digest: {enabled, window}, active}`. CRUD by scope owners (`notification.rule.manage` for workspace/tenant scopes).
- **NOTIF-FR-011 (M)** Rule evaluation: all active rules matching (tenant, event_type, resource filter) fire; a recipient receives at most one notification per (event_id, channel) regardless of how many rules matched.
- **NOTIF-FR-012 (M)** Per-user preferences: per event-type channel overrides, mutes (event type, or specific resource URN, e.g., "mute this dashboard"), quiet hours (local TZ window — email deferred to window end, in-app still stored silently), digest opt-in per event class. Preferences always win over rules except `critical`-class events, which cannot be muted on the in-app channel.
- **NOTIF-FR-013 (S)** Group audience expansion via rbac-service group membership projection (Redis); expansion capped at 500 recipients per event (excess → truncate + `notification.audience.truncated` audit event).

### Channels
- **NOTIF-FR-020 (M)** **In-app:** persist `notifications` rows; publish to realtime-hub topic `notifications:<user_id>` for live badge/toast. Inbox API: list (unread filter, cursor), mark read/unread (single + `POST /notifications/mark-all-read`), unread count. Retention 90 days.
- **NOTIF-FR-021 (M)** **Email:** provider abstraction interface `Send(msg) (provider_msg_id, err)` with drivers **SES, SendGrid, ACS** — selected per cell config, per-tenant override; failover to secondary on provider 5xx (circuit per provider). HTML + plaintext parts from templates; `List-Unsubscribe` header mapping to preference mute; provider webhooks (SES SNS, SendGrid events, ACS Event Grid) ingested to track `delivered|bounced|complained`. Hard bounce/complaint → suppression list (auto-mute email channel for that address, admin-visible, clearable).
- **NOTIF-FR-022 (M)** **Webhooks:** tenant-registered endpoints `{url (https only, no private-IP/link-local targets — SSRF guard resolved at send time), event_types[], secret_version, active}`. Registration handshake: `POST` challenge `{type:"endpoint.verify", challenge}` must echo challenge within 30s. Delivery: JSON body = master event envelope; headers `X-Datacern-Signature: v1=<hex hmac-sha256(secret, timestamp ‖ '.' ‖ body)>`, `X-Datacern-Timestamp`, `X-Datacern-Event-Id` (idempotency), `X-Datacern-Event-Type`. Secret rotation keeps two active secret versions for 24h (both signatures sent: `v1=…,v1=…`).
- **NOTIF-FR-023 (M)** Webhook retry/backoff: non-2xx or >10s timeout → retries at 1m, 5m, 30m, 2h, 6h, 24h (jittered); after final failure mark delivery `failed`. **Circuit breaker** per endpoint: open after 10 consecutive failures → suspend deliveries, retry probe every 15m, auto-close on success; endpoint auto-disabled + tenant-admin notified after 72h open. Missed events during open circuit are queued (7-day buffer) and delivered in order on close.
- **NOTIF-FR-024 (S)** Webhook delivery log queryable by tenant admin: per delivery `{event_id, endpoint, attempts, last_status, next_retry_at}` + manual `POST /webhooks/:id/deliveries/:did/redeliver`.

### Digests & rate limiting
- **NOTIF-FR-030 (M)** Digest batching: digest-flagged (event class × recipient × channel) notifications accumulate in a digest buffer; flush on window (user-configurable 15m/1h/daily at chosen local time; default 1h) or 200 items, rendering a digest template with grouped counts + top items. Digest flush is a Temporal scheduled workflow per (recipient, window).
- **NOTIF-FR-031 (M)** Per-recipient rate limits (email): max 20 immediate emails/hour/user; on breach, subsequent notifications auto-convert to the digest path (never silently dropped) and an `notification.rate_limited` metric increments. In-app: max 500 stored/day/user (overflow collapses into a single "N more events" roll-up row). Webhooks: per-endpoint 50 req/s cap with token bucket.
- **NOTIF-FR-032 (S)** Per-tenant email budget (daily cap, default 10K) → on exhaustion only `critical` class sends; `usage.events.v1` metering emitted per send.

### Templates
- **NOTIF-FR-040 (M)** Templates: `{key, channel, locale, subject_tpl, body_html_tpl, body_text_tpl, version, status: draft|published|archived}`. Engine: Go `html/template` with a **whitelisted variable schema per event type** (no arbitrary payload access); missing variable → render error → fallback to previous published version (never send `{{...}}` literals).
- **NOTIF-FR-041 (M)** Per-tenant overrides: tenant-scoped template rows shadow platform defaults by `(key, channel, locale)`; resolution order tenant → platform. Versioned: publishing creates a new immutable version; rollback = republish prior version. `POST /templates/:key/preview {sample_event}` renders without sending; `POST /templates/:key/test-send` to the caller only.
- **NOTIF-FR-042 (C)** Locale selection by user profile locale, fallback chain `user → tenant default → en`.

### Delivery tracking
- **NOTIF-FR-050 (M)** Every attempted delivery recorded in `deliveries`: `{notification_id, channel, provider, status: queued|sent|delivered|bounced|complained|failed|suppressed|rate_limited_digested, provider_msg_id, attempts, last_error}`. Status transitions emit `notification.delivery.updated` (sampled for audit).
- **NOTIF-FR-051 (M)** Ops API: per-tenant delivery stats (`GET /admin/stats?window=`), suppression list CRUD, DLQ drain runbook hooks.

## 4. Domain model & data

```
subscription_rules  id uuidv7 PK · tenant_id · scope text · subject_type text · subject_id uuid · event_types text[]
                    · resource_filter jsonb (≤4KB) · channels text[] · digest_enabled bool · digest_window text
                    · active bool · created_by · created_at · updated_at · deleted_at
  IX (tenant_id, active) · GIN (event_types)

user_preferences    id PK · tenant_id · user_id UX(tenant,user) · channel_overrides jsonb (≤8KB) · mutes jsonb (≤8KB)
                    · quiet_hours jsonb ({tz, start, end}) · digest_config jsonb · updated_at

notifications       id uuidv7 PK · tenant_id · user_id · event_id · event_type · severity_class text
                    · title text · body text · resource_urn text · deep_link text · read_at timestamptz NULL · created_at
  IX (tenant_id, user_id, read_at, created_at DESC) · partitioned monthly · retention 90d

webhook_endpoints   id PK · tenant_id · url text · event_types text[] · secrets jsonb (versions, vault refs) · active bool
                    · verified_at · circuit_state text · circuit_opened_at · consecutive_failures int · created_by

deliveries          id uuidv7 PK · tenant_id · notification_id NULL · webhook_endpoint_id NULL · event_id · channel
                    · provider text · status text · provider_msg_id · attempts int · last_error text · next_retry_at · created_at
  IX (tenant_id, status, next_retry_at) · IX (webhook_endpoint_id, created_at DESC) · partitioned monthly · retention 180d

templates           id PK · tenant_id NULL (platform default when NULL) · key · channel · locale · version int
                    · subject_tpl · body_html_tpl · body_text_tpl · status · published_at · created_by
  UX (coalesce(tenant_id,zero_uuid), key, channel, locale, version)

suppressions        id PK · tenant_id · email_hash · reason text (bounce|complaint|manual) · created_at · cleared_at
digest_buffers      id PK · tenant_id · user_id · channel · event_class · items jsonb (≤64KB, roll-up refs) · window_end timestamptz
outbox              (master standard)
```

**State machines.** Delivery: `queued → sent → delivered | bounced | complained`; `queued/sent → failed` (after retry schedule); `queued → suppressed | rate_limited_digested`. Webhook circuit: `closed → open` (10 consecutive failures) `→ half_open` (15m probe) `→ closed` (probe 2xx) or `→ open`; `open >72h → disabled` (manual re-enable + re-verify).

## 5. API specification

Base `/api/v1`. Actions `notification.rule.*`, `notification.webhook.*`, `notification.template.*`, `notification.inbox.read`.

| Method & path | Purpose | Errors |
|---|---|---|
| `GET /notifications?filter[unread]=true` | inbox list (cursor) | — |
| `GET /notifications/unread-count` | badge count (cached 5s) | — |
| `POST /notifications/:id/read` · `/unread` · `POST /notifications/mark-all-read` | read state | 404 |
| `GET/PUT /preferences` | own preferences | 422 |
| `GET/POST/PATCH/DELETE /rules` | subscription rules | 403 scope, 422 filter-field not whitelisted |
| `GET/POST/PATCH/DELETE /webhooks` | endpoint CRUD (create triggers verify handshake) | 422 VERIFY_FAILED / URL_FORBIDDEN |
| `POST /webhooks/:id/rotate-secret` | dual-secret rotation | 404 |
| `GET /webhooks/:id/deliveries` · `POST …/:did/redeliver` | delivery log / manual retry | 429 |
| `GET/POST /templates` · `POST /templates/:key/publish` · `/preview` · `/test-send` | template mgmt | 422 RENDER_FAILED (per-variable details) |
| `GET /admin/stats` · `GET/DELETE /admin/suppressions` | ops | 403 |

Subscription rule example:
```json
POST /api/v1/rules
{"scope":"workspace","subject_type":"group","subject_id":"g-fraud-team",
 "event_types":["case.sla.breached","case.escalated"],
 "resource_filter":{"resource_urn_prefix":"wr:t-42:case:",
                    "attrs":{"severity":["high","critical"]}},
 "channels":["in_app","email"],
 "digest_enabled":false,"active":true}
```

Webhook delivery example (body = master event envelope verbatim):
```
POST https://consumer.example.com/hooks/datacern
X-Datacern-Event-Id: 01978a3c-7f2e-7c11-b3a4-0242ac120002
X-Datacern-Event-Type: case.created
X-Datacern-Timestamp: 1783075200
X-Datacern-Signature: v1=6c1f2a…,v1=9ab0e3…        (two entries during secret rotation overlap)

{"event_id":"01978a3c-…","event_type":"case.created","tenant_id":"t-42",
 "actor":{"type":"user","id":"u-77"},"via_agent":null,
 "resource_urn":"wr:t-42:case:case/01978…","occurred_at":"2026-07-09T10:00:00Z",
 "trace_id":"7f2c…","payload":{"case_number":1042,"severity":"high","query_urn":"wr:…"}}
```
Consumer verifies `hmac_sha256(secret, timestamp + "." + raw_body)` and rejects `|now − timestamp| > 300s` (replay guard).

Provider driver interface (normative, one implementation per provider):
```go
type EmailProvider interface {
    Name() string                                   // "ses" | "sendgrid" | "acs"
    Send(ctx, Message) (providerMsgID string, err error)   // err classifies: Permanent | Transient | Ambiguous
    ParseStatusCallback(req) ([]StatusUpdate, error)       // delivered/bounce/complaint ingestion, signature-verified
}
```
Failover matrix: `Transient` → circuit-count + retry same provider → failover after 3; `Permanent` → fail delivery (no failover); `Ambiguous` (timeout post-submit) → no failover, retry same provider (BR-9).

Digest email structure (rendered by `digest.<class>` template): header (window, total count) → groups by event_type (count + top 5 items with deep links) → footer (manage-preferences link).

Template example (`case.assigned` / email / en, showing the whitelisted variable schema):
```
subject_tpl: "[Datacern] Case #{{.CaseNumber}} assigned to you — due {{.DueDate | date}}"
body_text_tpl: |
  {{.AssignerName}} assigned case #{{.CaseNumber}} ({{.Severity}}) to you.
  Due: {{.DueDate | datetime}}
  Open: {{.DeepLink}}
variables (whitelist for event_type=case.assigned):
  CaseNumber int · Severity string · DueDate time · AssignerName string · DeepLink url · WorkspaceName string
```
Any reference outside the whitelist fails `POST /templates/:key/publish` with `422 RENDER_FAILED`.

**Notification pipeline (normative sequence per consumed event):**
```
Kafka event → dedup (SETNX event_id)
  → mapping registry lookup (miss → skip+count)
  → audience: explicit principal ∪ rule matches → expand groups (≤500) → dedup recipients
  → per recipient: preferences (mute? channel override? quiet hours?) 
  → per (recipient, channel): rate-limit gate → immediate | digest-buffer | suppress
  → render (template resolution: tenant → platform; fallback chain on error)
  → deliver (channel driver) → deliveries row (unique on event_id+recipient+channel)
  → provider callback later updates status (delivered/bounced/complained)
```
Every stage is resumable: a crash between stages re-processes from Kafka; the unique delivery key makes re-delivery a no-op.

## 6. Events

**Consumed — event→notification mapping registry (initial set; registry is code-owned, PR-reviewed):**

| event_type | Audience (default) | Channels (default) | Class | Digestible |
|---|---|---|---|---|
| `case.assigned` | assignee | in-app + email | warning | no |
| `case.unassigned{reason:sla_breach}`, `case.sla.breached` | prior assignee + workspace managers | in-app + email | critical | no |
| `case.sla.warning` | assignee | in-app | warning | no |
| `case.escalated` | escalation target | in-app + email | critical | no |
| `case.comment.added` | assignee (not author) | in-app | info | yes |
| `case.bulk.completed`, `chart.export.completed|failed` | initiator | in-app | info | no |
| `pipeline.run.failed`, `inference.failed` | run owner | in-app + email | critical | no |
| `pipeline.run.completed`, `inference.completed`, `ingestion.completed|failed`, `dataset.version.created` | owner / subscribers | in-app | info | yes |
| `experiment.model.promoted` | workspace subscribers | in-app | info | yes |
| `proposal.created` (ai.events) | approvers | in-app + email | warning | no |
| `proposal.approved|rejected` | proposer (OBO user) | in-app | info | yes |
| `usage.budget.threshold|exhausted` | tenant admins | in-app + email | critical | no |
| `identity.user.created` | new user | email (invite) | info | no |
| `rbac.grant.created` (shared-with-you) | grantee | in-app | info | yes |
| `security.cross_tenant_denied` (audit) | tenant admins | in-app | critical | no |

Webhook channel: any mapped event type a tenant endpoint subscribes to. Adding a mapping = registry PR + template + contract test (release-gated).

**Emitted** on `notification.events.v1`: `notification.created`, `notification.delivery.updated`, `notification.webhook.circuit_opened|closed`, `notification.endpoint.disabled`, `notification.audience.truncated`. (Architecture table lists "—" for emissions; this BRD adds an ops-grade topic — consumed by audit-service and dashboards only, no service depends on it functionally.)

## 7. Business rules & edge cases

- **BR-1** Exactly-once per (event_id, recipient, channel): dedup key persisted with the delivery row (unique index); Kafka redelivery cannot double-send.
- **BR-2** Rate-limit overflow converts to digest, never drops — except in-app roll-up (BR in NOTIF-FR-031) which preserves count fidelity.
- **BR-3** `critical` class bypasses quiet hours and digests on in-app; email respects quiet hours except `usage.budget.exhausted` and `case.sla.breached`.
- **BR-4** Template render failure: fall back to previous published version; if none, send a generic minimal template and raise an ops alert — never block delivery on a bad template, never leak template syntax to recipients.
- **BR-5** Webhook payloads are the untransformed event envelope; per master §2.5-042 they contain URNs and no PII field values. Templates render only whitelisted variables; the whitelist per event type is part of the mapping registry.
- **BR-6** SSRF guard: endpoint URL re-resolved at every send; RFC1918/link-local/metadata IPs refused (`URL_FORBIDDEN`), redirects not followed.
- **BR-7** Ordering: per-endpoint webhook deliveries for the same resource_urn are serialized (in-order); across resources parallel. In-app/email make no ordering guarantee.
- **BR-8** User deleted/deactivated (identity event): preferences retained 30 days (rehire), pending deliveries cancelled, suppression by principal.
- **BR-9** Provider failover must not double-send: failover only on errors received **before** provider accept (connect/5xx without message id); ambiguous timeouts → no failover, retry same provider with same idempotency token where supported.
- **BR-10** Digest window boundary: items arriving during flush go to the next window (buffer swap is atomic); an empty buffer sends nothing.
- **BR-11** A recipient matching 5 rules for one event gets one notification; the delivery row records all matched rule ids for explainability (`GET /notifications/:id` includes `matched_rules`).
- **BR-12** Rules referencing non-whitelisted payload attrs are rejected at write time with the whitelist in `details`.
- **BR-13** Clock-skewed webhook consumers: signature timestamp tolerance is ±300s; documented in the webhook consumer guide; the service never accepts inbound webhooks except provider status callbacks (allowlisted signatures per provider).

## 8. Dependencies

**Upstream:** Kafka (all `*.events.v1`, `ai.events.v1`); rbac-service projections (group expansion, workspace managers); identity-service (user email/locale/TZ via cached read API); Vault (webhook secrets, provider creds); Temporal (digest flush, retry schedules); realtime-hub (in-app push publish). **Providers:** SES + SNS, SendGrid + event webhook, ACS + Event Grid. **Downstream:** ui-web inbox (via BFF), external webhook consumers, audit-service, usage-service (send metering).

## 9. NFRs (deltas from master)

- Event→in-app visible p95 ≤ 5s; →email provider-accepted p95 ≤ 30s.
- Webhook first-attempt p95 ≤ 10s from event; sustained 1K deliveries/s per cell.
- Inbox list p95 ≤ 150ms; unread-count ≤ 50ms (cached).
- Zero notification loss on service crash (outbox + Kafka offsets; chaos test required).

## 10. Acceptance criteria

- **AC-1** Given `case.assigned` for user U, when consumed, then within 5s U has an unread in-app notification with a deep link to the case URN and realtime-hub received a publish on `notifications:<U>`.
- **AC-2** Given U's preference "case.comment.added → digest hourly", when 12 comment events arrive in one hour, then U receives 0 immediate emails and exactly one digest email listing 12 grouped items at window end.
- **AC-3** Given Kafka redelivers the same `event_id`, when processed twice, then exactly one delivery row and one email exist (unique-key proof).
- **AC-4** Given a registered webhook, when an event is delivered, then the consumer can verify `X-Datacern-Signature` with HMAC-SHA256 over `timestamp.body`, and a request older than 300s fails verification.
- **AC-5** Given a webhook endpoint returning 500, when 10 consecutive deliveries fail, then the circuit opens, deliveries queue, a probe fires within 15m of recovery, and queued events then deliver in order with original `event_id`s.
- **AC-6** Given secret rotation, when deliveries occur during the 24h overlap, then both old and new secrets validate the signature header.
- **AC-7** Given a tenant template override for `case.assigned` email, when published and a new assignment occurs, then the tenant's version renders; when rolled back, the prior version renders — with no service restart.
- **AC-8** Given a template referencing an undefined variable, when publish is attempted, then `422 RENDER_FAILED` naming the variable; if a published template starts failing at send time, the previous version is used and an ops alert fires.
- **AC-9** Given a user receiving 25 qualifying immediate emails in an hour, when the 21st is processed, then emails 21–25 are converted to the digest path and the `notification.rate_limited` metric increments 5 times.
- **AC-10** Given an SES hard bounce callback for U's address, when the next email-eligible event for U arrives, then delivery status is `suppressed`, in-app still delivers, and the suppression appears in the admin API.
- **AC-11** Given a rule with filter `attrs.severity=[high,critical]` on `case.sla.breached`, when a `medium` breach occurs, then no notification; when `high`, then the rule's group members (expanded ≤500) each get exactly one notification even if they also match personal rules.
- **AC-12** Given a webhook registration pointing at `http://169.254.169.254/`, when created, then `422 URL_FORBIDDEN`; likewise an endpoint whose DNS later resolves to a private IP is refused at send time.
- **AC-13** Given quiet hours 22:00–07:00 (user TZ), when an `info` email-eligible event arrives at 23:00, then the email sends at 07:00; when `case.sla.breached` arrives, then it sends immediately.
- **AC-14** Given tenant A's admin, when reading tenant B's webhook delivery log, then `404` + cross-tenant audit event.

## 11. Out of scope / future

Slack/Teams/mobile-push channels (tool-plane connectors); SMS; user-defined notification templates; per-notification threading/replies; ML-based notification importance ranking; inbound email processing.
