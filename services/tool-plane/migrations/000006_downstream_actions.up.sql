-- Declared downstream authority for a tool version (BRD 74 AC-10).
--
-- A tool whose backend facade cannot answer from its own store — a cross-service
-- read fan-out — needs the CALLER's token forwarded to it so the services it
-- calls can authorize the effective human themselves. Forwarding a bearer is
-- delegation, so the set of downstream actions a tool may exercise must be
-- DECLARED on the registered version and checked at call time, never inferred
-- from whatever the caller's token happened to carry.
--
-- Empty (the default, and every pre-existing row) means: this tool delegates
-- nothing and the gateway forwards NO Authorization header to its facade —
-- exactly the behaviour that shipped before this column existed.
ALTER TABLE tool_versions
    ADD COLUMN downstream_actions TEXT[] NOT NULL DEFAULT '{}';
