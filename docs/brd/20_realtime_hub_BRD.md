# BRD 20 — realtime-hub (Go)

**Date:** 2026-07-09 · **Status:** Approved for build · **Phase:** 1
**Inherits:** `00_MASTER_BRD.md`. Architecture: `../../DATACERN_PLATFORM_ARCHITECTURE.md` §6 (realtime-hub row), §9.2 (topics), §8.3 (chat streams).

---

## 1. Overview

**Purpose.** realtime-hub is the platform's single push channel to browsers: it fans in from Kafka (and direct publishes from streaming services) and fans out to client connections over **SSE (primary)** and **WebSocket (secondary)**. It carries pipeline/ingestion/operation run status, agent chat token streams, in-app notification pushes, and proposal decision updates.

**Business value.** V1 had no push path: the UI polled pipeline-manager for Argo status, polled case/chart endpoints for freshness, and could not stream agent output. Master §2.3-027 bans client polling loops — realtime-hub is the mechanism that makes that ban viable. One hardened service owns connection auth, per-topic authorization, backpressure, and scale-out, so no other service ever terminates long-lived client connections.

**In scope:** SSE and WebSocket endpoints; topic model + subscription protocol; JWT auth at connect + per-topic OPA authorization; Kafka fan-in with topic routing; per-connection backpressure and slow-client policy; resume via `Last-Event-ID` with a bounded replay buffer; heartbeats and a documented client reconnect contract; connection limits per tenant/user; sticky-less horizontal scaling; internal publish API for low-latency streams (chat tokens); observability of connection/broadcast health.

**Out of scope:** business event semantics (producers own payloads); notification persistence/inbox (notification-service); client UI behavior beyond the reconnect contract; server-to-server messaging (Kafka); binary media streaming; presence/typing indicators (future); GraphQL subscriptions (BFF may proxy to hub later — Phase 6).

## 2. Actors & user stories

Personas: **UI client** (browser per user session), **Producer service** (pipeline-orchestrator, agent-runtime, notification-service, case/chart ops), **Platform operator**, **Tenant admin**.

- **US-1** As a UI client, I open one SSE connection and subscribe to the topics for my current screen (a run's status, my notifications) so the page updates without polling.
- **US-2** As a UI client watching a pipeline run, I receive `run-status:<urn>` events within 2s of the Argo state change.
- **US-3** As a UI client in an agent chat, I receive streamed tokens on `chat:<session>` with ≤150ms added latency over the model stream.
- **US-4** As a UI client that lost connectivity for 20s, I reconnect with `Last-Event-ID` and receive the missed events in order, with a clear signal if the gap is unrecoverable.
- **US-5** As a Producer service, I publish chat tokens to the hub's internal gRPC API and trust it to deliver to exactly the authorized subscribers.
- **US-6** As a security engineer, I know a user can never subscribe to another tenant's or another user's topics — every subscribe is OPA-checked.
- **US-7** As a Platform operator, I can see connections per tenant/user/pod, drop a connection, and drain a pod gracefully during deploys without event loss for clients.
- **US-8** As a Tenant admin, my tenant's misbehaving script cannot exhaust cell capacity: per-tenant and per-user connection caps apply with clear errors.
- **US-9** As a UI client on a corporate proxy that kills idle connections, heartbeats keep my SSE stream alive and detect death within 30s.
- **US-10** As a UI client whose permission to a resource was revoked mid-stream, my subscription to that topic is terminated within 60s.

## 3. Functional requirements

### Endpoints & protocol
- **RTH-FR-001 (M)** **SSE (primary):** `GET /api/v1/stream?topics=<t1>,<t2>` (`Accept: text/event-stream`). Auth: `Authorization: Bearer <JWT>` header, or one-time **stream ticket** (RTH-FR-011) for `EventSource` clients that cannot set headers. Response events: `id: <event_id>`, `event: <topic>`, `data: <json>`. Max 20 topics per connection; additional subscriptions require `POST /api/v1/stream/:conn_id/topics` (add/remove without reconnect, each OPA-checked).
- **RTH-FR-002 (M)** **WebSocket (secondary):** `GET /api/v1/ws` upgrade; JSON frames `{type: subscribe|unsubscribe|ping, topics?}` up, `{type: event|error|pong|subscribed|revoked, topic?, id?, data?}` down. Same auth, limits, and semantics as SSE. WS exists for chat UIs needing client→server signals (e.g., agent interrupt); all UI features MUST work over SSE alone.
- **RTH-FR-003 (M)** **Topic grammar** (validated, unknown scheme → `error INVALID_TOPIC`):
  - `run-status:<urn>` — pipeline runs, ingestion jobs, inference jobs, async operations (chart exports, case bulk ops). Authz action `realtime.run_status.read` on the URN.
  - `chat:<session_id>` — agent chat token/step stream. Authz: subject is the session owner (agent-runtime session registry projection).
  - `notifications:<user_id>` — in-app pushes. Authz: `<user_id> == sub` (or service principal); never grantable.
  - `proposal:<proposal_id>` — proposal status/decision updates. Authz `realtime.proposal.read` on the proposal URN.
  Topic names are always tenant-scoped internally as `<tenant_id>/<topic>`; the tenant prefix comes from the verified JWT, never the client.
- **RTH-FR-004 (M)** Event ids are the producer's `event_id` (uuidv7) so ordering/resume is stable end-to-end; hub-internal messages (heartbeat, control) carry no `id` and do not advance the resume cursor.

### AuthN/Z
- **RTH-FR-010 (M)** Connect: verify RS256 JWT per master §2.2 (JWKS cached ≤5m). Since streams outlive the 5-min token TTL: connections are **not** killed at token expiry, but a `token_refresh` control event is sent 60s before `exp`; client sends the refreshed token (WS frame `{type: refresh_token}` / SSE side-channel `POST /stream/:conn_id/token`); if not refreshed within 120s after `exp`, the connection closes `4401 TOKEN_EXPIRED`.
- **RTH-FR-011 (M)** Stream tickets: `POST /api/v1/stream-tickets {topics[]}` (normal JWT auth) → single-use opaque ticket, 30s TTL, bound to (subject, tenant, topics, IP hash); consumed at connect. This keeps tokens out of URLs and access logs.
- **RTH-FR-012 (M)** Every subscribe (initial and incremental) is authorized via the local OPA sidecar per topic (master §2.2-012); denial → per-topic error `TOPIC_FORBIDDEN` (connection stays up for the allowed topics); denials emit `security.topic_denied` audit events. Cross-tenant URN in a topic → treated as not-found (`TOPIC_FORBIDDEN`, no existence leak).
- **RTH-FR-013 (M)** Revocation: consume `rbac.events.v1` grant/role changes → re-evaluate affected active subscriptions (index: resource_urn → subscriptions) and terminate revoked ones with a `revoked` control event within 60s.

### Fan-in
- **RTH-FR-020 (M)** Kafka fan-in: consume `pipeline.events.v1`, `ingestion.events.v1`, `inference.events.v1`, `chart.events.v1` (export ops), `case.events.v1` (bulk ops), `notification.events.v1` (in-app pushes carry a `push` block), `ai.events.v1` (proposal + run lifecycle). A routing table maps `event_type` → topic template (e.g., `pipeline.run.status_changed` → `run-status:<resource_urn>`). Unroutable events are skipped (metric only) — the hub is transport, not consumer-of-record: **no DLQ semantics apply to fan-out; the hub never blocks a Kafka partition on slow clients** (master §2.4-033 DLQ requirement is satisfied trivially by skip-and-count, documented deviation).
- **RTH-FR-021 (M)** Internal publish API (gRPC, SPIFFE mTLS): `Publish(topic, event_id, payload, ttl)` for latency-critical streams — agent-runtime chat tokens bypass Kafka. p99 publish→client-write ≤ 50ms intra-cell.
- **RTH-FR-022 (M)** Payload cap 64KB per event; oversize → producer error (gRPC) or skip+alert (Kafka). Chat token events are batched by the producer at ≤50ms/≤1KB granularity.

### Delivery, backpressure, resume
- **RTH-FR-030 (M)** Per-connection send buffer 256 events / 1MB. **Slow-client policy: drop-oldest per topic** (never block the fan-out loop); when any events are dropped, insert control event `{type: gap, topic, from_id, to_id}` so the client knows to state-sync via REST. QoS exception: `chat:*` topics close the connection (`4409 TOO_SLOW`) instead of gapping — a token stream with holes is worse than a reconnect.
- **RTH-FR-031 (M)** **Resume:** hub keeps a per-(tenant, topic) replay ring buffer in Redis Streams — last 1,000 events or 10 minutes, whichever smaller. Reconnect with `Last-Event-ID` (SSE header / WS subscribe field `last_event_id`) → replay everything after that id in order, then live-tail. If the id has aged out → control event `{type: reset, topic}` and live-tail only (client must REST-refresh).
- **RTH-FR-032 (M)** Per-topic ordering preserved producer→client (single writer per topic partition; replay before live with dedup on overlap). No cross-topic ordering guarantee.
- **RTH-FR-033 (M)** **Heartbeat/reconnect contract (the UI contract):** hub sends `: hb` comment (SSE) / `pong` (WS) every 15s; client treats 45s silence as dead → reconnect with jittered exponential backoff 1s→2s→4s→…→30s cap (+ full jitter), resubscribing with `Last-Event-ID` per topic. Server graceful drain: control event `{type: reconnect, after_ms}` then close 1012 — clients reconnect immediately (new pod), honoring `after_ms` stagger.

- **RTH-FR-034 (M)** Per-topic-class QoS (normative table):

  | Topic class | Overflow policy | Replay window | Typical rate | Latency budget (fan-in→write) |
  |---|---|---|---|---|
  | `run-status:*` | drop-oldest + `gap` | 1,000 events / 10 min | ≤ 1 event/s per run | p95 500ms |
  | `notifications:*` | drop-oldest + `gap` | 1,000 / 10 min | bursty, low | p95 500ms |
  | `proposal:*` | drop-oldest + `gap` | 1,000 / 10 min | rare | p95 500ms |
  | `chat:*` | disconnect `4409` | 10 min (token batches) | ≤ 20 batches/s | p99 50ms (gRPC path) |

- **RTH-FR-035 (S)** UI SDK: the platform ships a TypeScript client (`@datacern/realtime`) implementing the reconnect contract (RTH-FR-033), per-topic `Last-Event-ID` tracking, gap→state-sync callbacks, and ticket minting — every UI feature consumes the hub only through this SDK so the contract lives in one place.

### Limits & scaling
- **RTH-FR-040 (M)** Connection limits (config per cell): **10 concurrent connections per user**, **2,000 per tenant**, 50K per pod. Over-limit connect → `429 CONNECTION_LIMIT` with `Retry-After`; per-user limit evicts the oldest connection of that user instead when header `X-Replace-Oldest: true`. Subscribe rate ≤ 10 topic-ops/s/connection.
- **RTH-FR-041 (M)** **Sticky-less horizontal scaling:** any client may land on any pod (no session affinity requirement at the LB). Every pod consumes the full relevant Kafka set in **broadcast mode** (unique consumer group per pod, `hub-<pod_id>`, offsets not committed durably — resume state lives in the Redis replay buffer, not Kafka offsets) and subscribes to Redis pub/sub channel `rt:<tenant>/<topic>` for gRPC-published events; a pod forwards gRPC publishes to Redis so all pods see them. Pod-local subscription registry only; no cross-pod connection state.
- **RTH-FR-042 (M)** Redis replay writes are performed by a single elected writer per Kafka source (leader lease in Redis) to avoid duplicate ring-buffer entries; gRPC publishes write-through with `XADD` dedup by event_id.
- **RTH-FR-043 (S)** Cell capacity target (master §3): 2K concurrent LLM streams + 50K idle-ish connections per cell; HPA on connection count + fan-out lag.
- **RTH-FR-044 (S)** Admin API: `GET /admin/connections?tenant=`, `DELETE /admin/connections/:id`, per-pod drain trigger.

### Observability
- **RTH-FR-050 (M)** Metrics: active connections {tenant, transport}, subscribe denials, fan-in→write latency histogram, dropped-event/gap counters {topic_class}, replay hits/resets, heartbeat timeouts, buffer occupancy. Connect/disconnect logs include conn_id, sub, tenant, topics, duration, close code.

## 4. Domain model & data

realtime-hub is intentionally near-stateless; Postgres is minimal (master table conventions apply).

```
stream_tickets   id PK · tenant_id · subject · topics text[] · ip_hash · expires_at · consumed_at    -- 30s TTL; row purged hourly
                 (hot path in Redis: SETEX ticket:<id>; Postgres row is the audit copy)
routing_rules    id PK · event_type UX · topic_template · enabled bool · updated_at                  -- code-seeded, ops-toggleable
```

Redis (cell-local): replay `XADD rt:{tenant}/{topic}` MAXLEN≈1000 + 10m TTL; pub/sub `rt:*` fan-out; ticket cache; leader leases; per-tenant/user connection counters (`INCR` with pod heartbeat reconciliation). In-memory per pod: connection table `{conn_id, subject, tenant, transport, topics[], buffer, last_event_ids}` and reverse index `topic → conns`, `resource_urn → conns` (for revocation).

**Connection state machine:** `connecting → authenticated → active ⇄ draining → closed`; `active → closed` on: client close, heartbeat timeout (45s), token expiry grace exceeded (4401), slow-client on chat (4409), admin kill, revocation of last topic (optional-keep if other topics remain).

## 5. API specification

Base `/api/v1`. Actions `realtime.stream.connect`, `realtime.run_status.read`, `realtime.proposal.read`, `realtime.admin.*`.

| Method & path | Purpose | Errors |
|---|---|---|
| `POST /stream-tickets` | mint single-use connect ticket | 422 INVALID_TOPIC |
| `GET /stream?topics=&ticket=` | SSE connect (or Bearer header) | 401, 429 CONNECTION_LIMIT, per-topic TOPIC_FORBIDDEN control events |
| `POST /stream/:conn_id/topics` | add/remove topics on live SSE conn | 404, 403, 429 topic-op rate |
| `POST /stream/:conn_id/token` | refresh JWT for live SSE conn | 401 |
| `GET /ws` | WebSocket upgrade | 401, 429 |
| `GET /admin/connections` · `DELETE /admin/connections/:id` | ops | 403 |
| gRPC `Publish(topic, event_id, payload, ttl)` | internal producer API (mTLS) | RESOURCE_EXHAUSTED (payload/QPS), INVALID_ARGUMENT |

SSE wire example:
```
id: 01978a3c-7f2e-7c11-b3a4-0242ac120002
event: run-status:wr:t-42:pipeline:run/pr-881
data: {"event_type":"pipeline.run.status_changed","payload":{"status":"Running","step":"train","progress":0.4},"occurred_at":"2026-07-09T10:15:00Z"}

: hb

event: control
data: {"type":"gap","topic":"run-status:wr:t-42:pipeline:run/pr-881","from_id":"0197…","to_id":"0197…"}
```
Close codes (WS): `4401` token expired, `4403` all topics forbidden, `4409` too slow (chat), `1012` server drain.

WebSocket frame examples:
```json
→ {"type":"subscribe","topics":["run-status:wr:t-42:pipeline:run/pr-881"],"last_event_id":"01978a3c-…"}
← {"type":"subscribed","topic":"run-status:wr:t-42:pipeline:run/pr-881","replayed":17}
← {"type":"event","topic":"run-status:…","id":"01978a3d-…","data":{"event_type":"pipeline.run.status_changed","payload":{…}}}
← {"type":"error","topic":"chat:sess-999","code":"TOPIC_FORBIDDEN"}
→ {"type":"refresh_token","token":"eyJ…"}
← {"type":"revoked","topic":"proposal:pp-3"}
```

Internal publish API (gRPC, normative sketch):
```protobuf
service RealtimeHub {
  rpc Publish(PublishRequest) returns (PublishAck);           // unary, idempotent by event_id
  rpc PublishStream(stream PublishRequest) returns (stream PublishAck);  // chat token batches
}
message PublishRequest { string tenant_id=1; string topic=2; string event_id=3; bytes payload_json=4; uint32 ttl_seconds=5; }
message PublishAck    { string event_id=1; bool accepted=2; string reason=3; }
```

**Client reconnect contract (normative pseudocode, shipped in the UI SDK):**
```
connect(topics, lastIds):
  backoff = 1s
  loop:
    es = EventSource(/stream?ticket=mint(topics), headers: Last-Event-ID per topic)
    on event   → deliver; lastIds[topic] = id; backoff = 1s
    on control gap/reset → trigger REST state-sync for topic
    on control reconnect → close; wait after_ms; continue (no backoff growth)
    on 45s silence or error → close; sleep jitter(backoff); backoff = min(backoff*2, 30s)
```

## 6. Events

**Emitted (Kafka):** none — the hub is a transport. Audit-relevant occurrences (`security.topic_denied`, admin kills) are emitted as audit events via the standard audit path.

**Consumed:**
| Topic | Handling |
|---|---|
| `pipeline.events.v1`, `ingestion.events.v1`, `inference.events.v1` | route status/progress event types → `run-status:<resource_urn>` |
| `chart.events.v1` (`chart.export.*`), `case.events.v1` (`case.bulk.completed`) | → `run-status:<operation_urn>` |
| `notification.events.v1` (`notification.created` with push block) | → `notifications:<user_id>` |
| `ai.events.v1` (`proposal.created|approved|rejected|expired`, `agent.run.status_changed`) | → `proposal:<id>` / `run-status:<agent run urn>` |
| `rbac.events.v1` (grant/role/membership changes) | subscription re-evaluation (RTH-FR-013), not fan-out |

Consumption is broadcast-mode per pod (RTH-FR-041); skip-and-count for unroutable/oversize events; no DLQ (documented deviation from master §2.4-033, rationale in RTH-FR-020).

Routing table (initial, code-seeded into `routing_rules`):

| event_type (pattern) | Topic template |
|---|---|
| `pipeline.run.*`, `pipeline.step.*` | `run-status:{resource_urn}` |
| `ingestion.started\|progress\|completed\|failed` | `run-status:{resource_urn}` |
| `inference.started\|completed\|failed` | `run-status:{resource_urn}` |
| `chart.export.completed\|failed` | `run-status:{payload.operation_urn}` |
| `case.bulk.completed` | `run-status:{payload.operation_urn}` |
| `notification.created` (with push block) | `notifications:{payload.user_id}` |
| `proposal.created\|approved\|rejected\|expired` | `proposal:{resource_id}` |
| `agent.run.status_changed` | `run-status:{resource_urn}` |

## 7. Business rules & edge cases

- **BR-1** The hub never blocks on a client: fan-out writes are non-blocking; buffer overflow follows the per-QoS policy (gap for state topics, disconnect for chat). A single slow client cannot add >0ms latency to other connections (per-connection goroutine + bounded channel).
- **BR-2** Delivery guarantee is **at-least-once within the replay window**; clients dedup by event id (uuidv7 monotonicity per topic). Beyond the window the contract is `reset` + REST state sync — producers MUST design UI state so a REST GET fully recovers (this is a platform-wide contract, referenced by every producer BRD).
- **BR-3** Tenant scoping is structural: subscription keys are always `<tenant-from-JWT>/<topic>`; there is no code path where a client-supplied tenant reaches the key. Isolation tests cover topic-key construction directly.
- **BR-4** `notifications:<user_id>` accepts only `<user_id> == sub`; even tenant admins cannot subscribe to another user's stream (privacy) — admin visibility goes through notification-service, not the hub.
- **BR-5** Duplicate subscribe to an already-subscribed topic is a no-op (idempotent, returns `subscribed`); unsubscribe of an unknown topic likewise.
- **BR-6** Replay + live overlap: after replaying through id X, live events ≤ X are dropped (dedup set per topic per connection, bounded 1,000 ids).
- **BR-7** Kafka consumer lag spike (>5s): hub sets `degraded=true` in heartbeat control data so UIs can show a staleness hint; it never buffers unboundedly — ring buffers cap memory.
- **BR-8** Pod crash: clients detect via heartbeat (≤45s), reconnect elsewhere, resume from Redis replay — zero event loss within the window. Deploys use drain (`reconnect` control + 30s grace) targeting zero perceived gaps.
- **BR-9** Redis outage: existing connections continue live-tail from each pod's Kafka feed (no replay, no gRPC-published chat fan-out across pods); new connects that need tickets fall back to Bearer-header auth; chat streams degrade to single-pod delivery only if the publishing pod holds the connection — agent-runtime retries `Publish` on NACK. Full behavior documented in RUNBOOK.
- **BR-10** Token refresh must present the **same** `sub` and `tenant_id`; a different subject closes the connection (`4401`).
- **BR-11** Per-user eviction (`X-Replace-Oldest`) closes the oldest connection with control `{type: replaced}` — prevents tab-leak lockout.
- **BR-12** Browser SSE connection-per-domain limits (6 on HTTP/1.1) are mitigated by requiring HTTP/2 at the edge; the UI multiplexes all topics over one connection per tab as the norm.
- **BR-13** Events published with `ttl` (gRPC) skip the replay buffer when `ttl=0` (ephemeral, e.g., typing-style signals later) — chat tokens use `ttl=10m` default.

**Failure-mode matrix (RUNBOOK source of truth):**

| Failure | Client-visible effect | Hub behavior | Recovery contract |
|---|---|---|---|
| Pod crash | ≤45s silence → reconnect | none (dead) | resume via Redis replay; zero loss in window |
| Redis down | replay/reset unavailable; chat may degrade | live-tail continues from Kafka; `/readyz` degraded | auto-heal on Redis return; no pod restart |
| Kafka lag >5s | stale events; `degraded:true` in heartbeat | continues; alerts | catch-up automatic; no client action |
| OPA sidecar down | new subscribes fail-closed (`TOPIC_FORBIDDEN`+alert) | existing subs unaffected | sidecar restart; LB retry |
| JWKS unreachable | new connects 401 after cache expiry | cached keys serve ≤5m | identity-service SLO covers |
| Slow client | gap events (state) / 4409 (chat) | drop-oldest per topic | REST state-sync on gap |
| Deploy/drain | `reconnect` control, staggered | 30s grace, then 1012 | immediate reconnect, no backoff |

**Capacity math (per pod, informative):** 50K conns × (1 goroutine ≈ 8KB stack + 256-event buffer ≈ 24KB avg) ≈ 1.6GB; fan-out CPU dominated by JSON writes — budget 2 vCPU at 20K events/s aggregate write rate; chat streams budgeted separately (2K/cell × ~20 msg/s).

## 8. Dependencies

**Upstream:** Kafka (topics per §6); Redis (replay Streams, pub/sub, tickets, counters, leases); OPA sidecar + rbac `permissions_flat`; identity-service JWKS; agent-runtime session-ownership projection (Redis, maintained by agent-runtime); SPIFFE mTLS mesh for gRPC producers. **Producers (gRPC):** agent-runtime (chat), any service needing sub-second ops streaming. **Downstream:** ui-web (only client at GA, via edge LB with HTTP/2 + no idle-timeout <60s), bff-graphql (may mint tickets server-side). **Infra note:** LB/ingress must disable response buffering for `text/event-stream`.

## 9. NFRs (deltas from master)

- Fan-in (Kafka receive) → client socket write p95 ≤ 500ms; gRPC publish → write p99 ≤ 50ms intra-cell.
- 50K concurrent connections per pod at ≤ 2 vCPU / 4GB; 2K concurrent chat streams per cell (master capacity table).
- Availability 99.95%; client-observed event loss within replay window: 0 (chaos-tested: pod kill, Redis failover, Kafka rebalance).
- Reconnect storm: 10K simultaneous reconnects absorbed ≤ 10s (ticket minting + OPA warm cache), no >1% error rate.

## 10. Acceptance criteria

- **AC-1** Given a valid JWT and topics `run-status:<urn>,notifications:<me>`, when connecting via SSE, then both topics stream and each carried event's `id` equals the producer `event_id`.
- **AC-2** Given a pipeline status change published to Kafka, when routed, then a subscribed client receives it within 2s end-to-end (p95, load test at 10K connections).
- **AC-3** Given a client that disconnects after event N and reconnects within 10 minutes with `Last-Event-ID: N`, then it receives N+1…latest in order with no duplicates, then live events.
- **AC-4** Given a client reconnecting with an id older than the replay window, then it receives control `{type:"reset"}` for that topic and only live events after.
- **AC-5** Given a subscription request for another tenant's run URN (valid-looking), then a `TOPIC_FORBIDDEN` control error, no data, and a `security.topic_denied` audit event; the error is identical for nonexistent URNs.
- **AC-6** Given a user whose grant on a dashboard-run resource is revoked while subscribed, then within 60s the hub sends `{type:"revoked", topic}` and stops delivery on that topic while other topics continue.
- **AC-7** Given a slow reader on `run-status:*` whose buffer overflows, then oldest events are dropped, a `gap` control event with the dropped id range is delivered, and other connections are unaffected (latency assertion); given the same on `chat:*`, then the connection closes `4409`.
- **AC-8** Given agent-runtime publishing 100 token batches via gRPC, then the subscriber connected to a **different pod** receives all 100 in order (Redis pub/sub path proven) with p99 ≤ 50ms.
- **AC-9** Given a connected client and no traffic, then `: hb` arrives every 15s; when the server is SIGTERMed, then clients receive `{type:"reconnect"}` before close 1012 and successfully resume on another pod with zero events lost within the window.
- **AC-10** Given a user opening an 11th connection, then `429 CONNECTION_LIMIT`; with `X-Replace-Oldest: true`, then the oldest closes with `{type:"replaced"}` and the new connect succeeds; given a tenant at 2,000 connections, then the 2,001st is refused regardless of user.
- **AC-11** Given a JWT expiring in 60s, then a `token_refresh` control event arrives; when the client posts a refreshed token with the same sub, the connection persists past `exp`; when it doesn't, the connection closes `4401` within 120s after `exp`.
- **AC-12** Given a minted stream ticket, then it authenticates exactly one connect within 30s and is rejected on reuse (`401`), and the raw JWT never appears in the URL or access logs (log scrub test).
- **AC-13** Given a Redis full outage, then existing connections keep receiving Kafka-routed events, the service's `/readyz` reports degraded-replay, and recovery restores replay without restarting pods.
- **AC-14** Given 10K clients reconnecting simultaneously after an LB blip, then ≥99% are streaming again within 10s and OPA p99 stays ≤ 10ms (cache-warm assertion).

- **AC-15** Given a `chart.export.completed` Kafka event with `payload.operation_urn`, when routed, then subscribers of `run-status:<operation_urn>` receive it and no other topic receives it (routing-table contract test covers every row of the RTH-FR-020 table).
- **AC-16** Given the same event_id arriving via both Kafka replay and gRPC publish (producer retry), then a subscribed client receives it exactly once (replay-buffer XADD dedup + per-connection dedup set).

## 11. Out of scope / future

GraphQL subscriptions via BFF; presence/typing indicators; client→client channels; mobile push transport; message priorities/QoS classes beyond the chat exception; cross-cell subscription bridging (tenants are cell-pinned); compression negotiation (permessage-deflate evaluated Phase 6).

---

**Implementation checklist deltas (beyond master §2.8):** load-test harness simulating 50K connections + reconnect storms is part of CI (nightly); soak test 24h with pod kills and Redis failover proving zero in-window loss; the UI SDK contract tests run against every hub release.
