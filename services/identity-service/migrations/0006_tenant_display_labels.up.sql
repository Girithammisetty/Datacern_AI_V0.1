-- Per-tenant display-label overlays (BRD 23 inc3 / PKG display_labels). A tenant
-- — or a capability pack installing on its behalf — can rename the UI's nouns
-- and status/operator labels, e.g. "Cases" -> "AP Exceptions", so a single Core
-- white-labels across verticals. Keyed by (tenant_id, label_key): label_key is a
-- ui-web i18n key (e.g. "cases.title", "nav.cases"); label_value is the override
-- string the app overlays onto its base catalog. Platform-scoped like tenants +
-- tenant_idp_configs (no RLS): written by tenant admins (identity.user.admin),
-- read on the member-safe /tenants/self/labels path so EVERY tenant member's UI
-- renders the same labels.
CREATE TABLE tenant_display_labels (
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    label_key   text NOT NULL,
    label_value text NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  text NOT NULL DEFAULT '',
    PRIMARY KEY (tenant_id, label_key)
);
