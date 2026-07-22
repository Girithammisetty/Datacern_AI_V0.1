-- Per-tenant white-label branding (BRD 59 WS3): an optional logo asset
-- (object-storage key/content-type; bytes live in MinIO, not here) and
-- primary/accent color tokens as bare HSL triplets ("221 83% 53%"), matching
-- services/ui-web/src/app/globals.css's CSS custom-property format so they
-- drop directly into `--primary`/`--accent` with zero client-side conversion.
-- Platform-scoped like tenant_embed_configs / tenant_display_labels (one row
-- per tenant, no RLS): written by tenant admins (identity.user.admin), read on
-- the member-safe /tenants/self/branding path so every tenant member's UI
-- (and the embed surfaces) render the same brand.
CREATE TABLE tenant_branding (
    tenant_id          uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    logo_object_key    text NOT NULL DEFAULT '',
    logo_content_type  text NOT NULL DEFAULT '',
    primary_color      text NOT NULL DEFAULT '',
    accent_color       text NOT NULL DEFAULT '',
    updated_at         timestamptz NOT NULL DEFAULT now(),
    updated_by         text NOT NULL DEFAULT ''
);
