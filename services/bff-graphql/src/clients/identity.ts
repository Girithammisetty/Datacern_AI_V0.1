/** identity-service REST client (BRD 01). Backs: Viewer, User, Tenant,
 * ServiceAccount + the admin user directory. Pure passthrough — the caller's JWT
 * is forwarded verbatim by ServiceClient and identity-service enforces every
 * `identity.*` action guard. The BFF makes no authz/business decision here. */
import { ServiceClient } from "./base.js";
import type { Page } from "./types.js";

export interface UserDTO {
  id: string;
  tenant_id: string;
  email: string;
  full_name?: string;
  status?: string;
  idp_subject?: string | null;
  last_login_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** POST /users/invite body (identity domain.InviteRequest). */
export interface InviteUserBody {
  email: string;
  full_name?: string;
  groups?: string[];
}

/** identity domain.ServiceAccount (secret hashes are json:"-", never serialized). */
export interface ServiceAccountDTO {
  id: string;
  tenant_id: string;
  name: string;
  scopes?: string[];
  expires_at?: string | null;
  last_used_at?: string | null;
  revoked_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

// Tier 4b: identity/rbac admin — user lifecycle + service-account lifecycle.
/** POST /service-accounts body (identity domain.CreateServiceAccountRequest). */
export interface CreateServiceAccountBody {
  name: string;
  scopes?: string[];
  expires_at?: string;
}

/** identity domain.CreatedServiceAccount — the ONLY shape that ever carries the
 * api_key (format wr_sa_<id>.<secret>). Returned exactly once on create and
 * rotate; never retrievable again (BR-11). */
export interface CreatedServiceAccountDTO {
  service_account: ServiceAccountDTO;
  api_key: string;
}

/** identity domain.Quotas. */
export interface QuotasDTO {
  cpu?: number;
  memory?: string;
  processing_cpu?: number;
  processing_memory?: string;
}

/** identity domain.Tenant (settings live on the tenant object itself). */
export interface TenantDTO {
  id: string;
  name: string;
  display_name?: string;
  owner_email?: string;
  tier?: string;
  cloud?: string;
  status?: string;
  quotas?: QuotasDTO;
  platform_version?: string;
  subdomain?: string;
  auto_upgrade?: boolean;
  modules?: string[];
  created_at?: string | null;
  updated_at?: string | null;
}

/** One POC success criterion (identity domain.SuccessCriterion). */
export interface PocCriterionDTO {
  key: string;
  description?: string;
  metric_ref?: string;
  target?: number;
  direction?: string; // gte|lte
  manual_value?: number | null;
}

/** GET /tenants/{id}/poc/progress (identity domain.PocProgress). */
export interface PocProgressDTO {
  tenant_id: string;
  window_start?: string;
  window_end?: string;
  as_of?: string;
  criteria: (PocCriterionDTO & {
    actual_value?: number | null;
    outcome?: string; // met|missed|inconclusive
    data_source?: string;
  })[];
}

/** One provisioning-saga step (identity domain.ProvisioningStep). */
export interface ProvisioningStepDTO {
  id: string;
  tenant_id?: string;
  workflow_id?: string;
  step_index: number;
  step_name: string;
  status: string;
  attempt?: number;
  error?: string;
  compensation?: string;
  started_at?: string | null;
  completed_at?: string | null;
}

/** GET /api/v1/tenants/self — the member-safe subset of the caller's tenant. */
export interface TenantSelfDTO {
  id?: string;
  name?: string;
  display_name?: string;
  status?: string;
}

/** GET /api/v1/tenants/{id}/embed-config — never carries the secret itself
 * (only its hash is stored server-side); "configured" distinguishes "never
 * set up" from "configured with zero origins". */
export interface EmbedConfigDTO {
  configured: boolean;
  allowed_origins: string[];
  updated_at?: string | null;
}

/** PUT /api/v1/tenants/{id}/embed-config response — the plaintext secret is
 * returned exactly once, at generation time; it is never retrievable again. */
export interface SetEmbedConfigDTO {
  embed_secret: string;
  allowed_origins: string[];
}

/** GET/PUT /api/v1/tenants/self/idp — the caller tenant's OIDC IdP (BYO-P4). */
export interface IdpConfigDTO {
  issuer: string;
  client_id: string;
  discovery_url: string;
  enabled: boolean;
  updated_at?: string | null;
}

/** GET/PUT /api/v1/tenants/self/branding — the caller tenant's white-label
 * identity (BRD 59 WS3). primary_color/accent_color are bare HSL triplets
 * ("221 83% 53%"); the logo bytes themselves are fetched via the same-origin
 * /api/tenant-branding/logo proxy, not through this DTO. */
export interface TenantBrandingDTO {
  configured: boolean;
  has_logo: boolean;
  primary_color: string;
  accent_color: string;
  updated_at?: string | null;
}

/** One row of GET /api/v1/tenants/{id}/entitlements' effective set
 * (identity domain.EffectiveEntitlement, CPL-FR-011). */
export interface TenantEntitlementDTO {
  kind: string;
  key: string;
  value?: Record<string, unknown>;
  provenance: string; // plan_default | override
}

/** GET /api/v1/tenants/{id}/entitlements response (BRD 66, CPL-FR-011) —
 * identity-service gates this endpoint on identity.user.admin (tenant
 * admin) or platform super-admin; a lower-privilege caller's JWT gets a
 * downstream 403, which tenantCommercial (resolvers/index.ts) catches and
 * degrades to the minimal shape rather than erroring the whole query. */
export interface TenantEntitlementsDTO {
  data: TenantEntitlementDTO[];
  plan?: { key: string; version: number } | null;
  commercial_state: string;
  trial_ends_at?: string | null;
}

/** identity domain.ExternalAgentKey (BRD 60 WS2) — a tenant-minted credential
 * for a customer's OWN agent. Metadata only: the secret hash is json:"-" and
 * the plaintext key is unrecoverable after creation. */
export interface ExternalAgentKeyDTO {
  id: string;
  tenant_id: string;
  agent_id: string;
  agent_version?: number;
  scopes?: string[];
  label?: string;
  active: boolean;
  created_by?: string;
  created_at?: string | null;
  last_used_at?: string | null;
}

/** POST /tenants/self/external-agents body (identity handleCreateExternalAgentKey). */
export interface CreateExternalAgentKeyBody {
  agent_id: string;
  agent_version?: number;
  scopes?: string[];
  label?: string;
}

/** POST /tenants/self/external-agents response — the ONLY shape that ever
 * carries the plaintext key (format wr_xa_<id>.<secret>). Returned exactly
 * once at creation (shown_once) and never retrievable again. */
export interface CreatedExternalAgentKeyDTO {
  key: ExternalAgentKeyDTO;
  plaintext: string;
  shown_once: boolean;
}

export class IdentityClient {
  constructor(private readonly http: ServiceClient) {}

  /** GET /api/v1/tenants/self — name/display name of the CALLER's own tenant
   * (member-visible; no admin scope needed, unlike GET /tenants/{id}). */
  tenantSelf(): Promise<TenantSelfDTO> {
    return this.http.get<TenantSelfDTO>("/api/v1/tenants/self");
  }

  /** GET /api/v1/tenants/self/labels — the caller's tenant's UI label overrides
   * as a flat {key: value} map (BRD 23 inc3). Member-visible: every tenant
   * member loads these to overlay the app's base i18n catalog, so a capability
   * pack's "Cases -> AP Exceptions" rename renders for the whole tenant. */
  tenantLabels(): Promise<{ labels: Record<string, string> }> {
    return this.http.get<{ labels: Record<string, string> }>("/api/v1/tenants/self/labels");
  }

  /** PUT /api/v1/tenants/self/labels — upsert (merge) one or more UI label
   * overrides; returns the full merged {key: value} map (inc18 editor). Needs
   * the identity.user.admin capability (tenant administration). */
  setTenantLabels(labels: Record<string, string>): Promise<{ labels: Record<string, string> }> {
    return this.http.put<{ labels: Record<string, string> }>("/api/v1/tenants/self/labels", {
      body: { labels },
    });
  }

  /** DELETE /api/v1/tenants/self/labels/{key} (204) — revert one override to the
   * base i18n string. Needs identity.user.admin. */
  async deleteTenantLabel(key: string): Promise<boolean> {
    await this.http.delete<void>(`/api/v1/tenants/self/labels/${encodeURIComponent(key)}`);
    return true;
  }

  /** GET /api/v1/users/profiles?filter[id]=a,b,c — batch hydration for the
   * userById loader (Case.assignee, CaseComment.author, CaseActivity.actor).
   * Deliberately NOT GET /api/v1/users (identity.user.admin, the tenant
   * directory listing): these are display-only lookups of ids the caller
   * already has from an authorized resource, so they go through identity's
   * member-visible /users/profiles endpoint instead — no admin scope
   * required, and it returns only {id, email, full_name} (no
   * status/idp_subject/last_login_at/timestamps). */
  async usersByIds(ids: string[]): Promise<UserDTO[]> {
    if (ids.length === 0) return [];
    const res = await this.http.get<Page<UserDTO>>("/api/v1/users/profiles", {
      query: { "filter[id]": ids.join(","), limit: ids.length },
    });
    return res.data ?? [];
  }

  /** GET /api/v1/users/{id}. */
  user(id: string): Promise<UserDTO> {
    return this.http.get<UserDTO>(`/api/v1/users/${encodeURIComponent(id)}`);
  }

  /** GET /api/v1/users (tenant admin list; cursor-paginated). Admin only —
   * requires identity.user.admin, returns the full admin DTO. */
  users(limit: number, cursor?: string): Promise<Page<UserDTO>> {
    return this.http.get<Page<UserDTO>>("/api/v1/users", { query: { limit, cursor } });
  }

  /** GET /api/v1/users/assignable — member-safe directory of ACTIVE tenant
   * users (id/email/full_name only) for the case assignment + mention pickers.
   * Deliberately NOT GET /api/v1/users: no admin scope required (mirrors
   * /users/profiles), so a case worker with case.case.assign can list assignees
   * without identity.user.admin. status/last_login_at/etc. are never returned. */
  assignableUsers(limit: number, cursor?: string): Promise<Page<UserDTO>> {
    return this.http.get<Page<UserDTO>>("/api/v1/users/assignable", { query: { limit, cursor } });
  }

  /** POST /api/v1/users/invite — create a user in the "invited" state (201).
   * Depends on Keycloak; a downstream 5xx on the KC path surfaces honestly. */
  inviteUser(body: InviteUserBody, idempotencyKey?: string): Promise<UserDTO> {
    return this.http.post<UserDTO>("/api/v1/users/invite", { body, idempotencyKey });
  }

  /** GET /api/v1/service-accounts (cursor-paginated; no filters). */
  serviceAccounts(limit: number, cursor?: string): Promise<Page<ServiceAccountDTO>> {
    return this.http.get<Page<ServiceAccountDTO>>("/api/v1/service-accounts", {
      query: { limit, cursor },
    });
  }

  /** GET /api/v1/tenants — cross-tenant list (identity requireSuperAdmin gates
   * it; the BFF forwards the JWT). Used by the platform-admin all-tenants view. */
  tenants(limit: number, cursor?: string): Promise<Page<TenantDTO>> {
    return this.http.get<Page<TenantDTO>>("/api/v1/tenants", { query: { limit, cursor } });
  }

  /** GET /api/v1/tenants/{id} — the tenant object + its settings. */
  tenant(id: string): Promise<TenantDTO> {
    return this.http.get<TenantDTO>(`/api/v1/tenants/${encodeURIComponent(id)}`);
  }

  // ---- tenant lifecycle (IDN-FR-005..008; identity requireSuperAdmin) ------

  /** POST /api/v1/tenants — provision a tenant (201; 202 + operation_id when
   * publish=true starts the saga immediately). */
  async createTenant(
    body: { name: string; display_name?: string; owner_email?: string; tier?: string; cloud?: string; publish?: boolean },
    idempotencyKey?: string,
  ): Promise<{ tenant: TenantDTO; operation_id?: string }> {
    const r = await this.http.post<TenantDTO | { operation_id: string; tenant: TenantDTO }>(
      "/api/v1/tenants",
      { body, idempotencyKey },
    );
    return "operation_id" in (r as Record<string, unknown>)
      ? (r as { operation_id: string; tenant: TenantDTO })
      : { tenant: r as TenantDTO };
  }

  /** PATCH /api/v1/tenants/{id} — edit tenant attributes. */
  patchTenant(id: string, body: Record<string, unknown>): Promise<TenantDTO> {
    return this.http.patch<TenantDTO>(`/api/v1/tenants/${encodeURIComponent(id)}`, { body });
  }

  /** DELETE /api/v1/tenants/{id}?mode=archive|destroy&force= (IDN-FR-008). */
  deleteTenant(id: string, mode: "archive" | "destroy", force = false): Promise<TenantDTO> {
    return this.http.delete<TenantDTO>(`/api/v1/tenants/${encodeURIComponent(id)}`, {
      query: { mode, force },
    });
  }

  /** POST /api/v1/tenants/{id}/publish (202) — start the provisioning saga. */
  async publishTenant(id: string): Promise<string> {
    const r = await this.http.post<{ operation_id: string }>(
      `/api/v1/tenants/${encodeURIComponent(id)}/publish`, {},
    );
    return r.operation_id;
  }

  /** POST /api/v1/tenants/{id}/suspend — data intact, access off. */
  suspendTenant(id: string): Promise<TenantDTO> {
    return this.http.post<TenantDTO>(`/api/v1/tenants/${encodeURIComponent(id)}/suspend`, {});
  }

  /** POST /api/v1/tenants/{id}/reactivate — returns the tenant + any config
   * drift detected while suspended. */
  reactivateTenant(id: string): Promise<{ tenant: TenantDTO; drift?: unknown }> {
    return this.http.post<{ tenant: TenantDTO; drift?: unknown }>(
      `/api/v1/tenants/${encodeURIComponent(id)}/reactivate`, {},
    );
  }

  /** GET /api/v1/tenants/{id}/provisioning — the saga's step-by-step state. */
  async provisioningStatus(id: string): Promise<ProvisioningStepDTO[]> {
    const r = await this.http.get<{ steps: ProvisioningStepDTO[] }>(
      `/api/v1/tenants/${encodeURIComponent(id)}/provisioning`,
    );
    return r.steps ?? [];
  }

  /** POST /api/v1/tenants/{id}/provisioning/retry (202) — retry a failed saga. */
  async retryProvisioning(id: string): Promise<string> {
    const r = await this.http.post<{ operation_id: string }>(
      `/api/v1/tenants/${encodeURIComponent(id)}/provisioning/retry`, {},
    );
    return r.operation_id;
  }

  // ---- BRD 70 demo/POC + BRD 66 trials (identity requireSuperAdmin unless
  // noted; POC reads are tenant-admin with cross-tenant guard) --------------

  /** POST /api/v1/demo-tenants (202) — provision + seed a demo sandbox from a
   * deploy/demo/<pack>/ bundle (DSP-FR-010). Always publishes. */
  createDemoTenant(
    body: { name: string; display_name?: string; owner_email?: string; pack: string; tier?: string },
    idempotencyKey?: string,
  ): Promise<{ operation_id: string; tenant: TenantDTO }> {
    return this.http.post<{ operation_id: string; tenant: TenantDTO }>("/api/v1/demo-tenants", { body, idempotencyKey });
  }

  /** POST /api/v1/demo-tenants/{id}/reset — idempotent re-seed (DSP-FR-012). */
  resetDemoTenant(id: string): Promise<TenantDTO> {
    return this.http.post<TenantDTO>(`/api/v1/demo-tenants/${encodeURIComponent(id)}/reset`, {});
  }

  /** POST /api/v1/demo-tenants/{id}/clone — fresh sibling sandbox. */
  cloneDemoTenant(id: string): Promise<{ operation_id?: string; tenant: TenantDTO } | TenantDTO> {
    return this.http.post<{ operation_id?: string; tenant: TenantDTO } | TenantDTO>(
      `/api/v1/demo-tenants/${encodeURIComponent(id)}/clone`, {},
    );
  }

  /** POST /api/v1/poc-tenants — provision a POC tenant (pack optional). */
  createPocTenant(
    body: { name: string; display_name?: string; owner_email?: string; pack?: string },
    idempotencyKey?: string,
  ): Promise<{ operation_id?: string; tenant: TenantDTO } | TenantDTO> {
    return this.http.post<{ operation_id?: string; tenant: TenantDTO } | TenantDTO>(
      "/api/v1/poc-tenants", { body, idempotencyKey },
    );
  }

  /** GET /tenants/{id}/poc/criteria — the agreed success criteria. */
  pocCriteria(id: string): Promise<{ criteria?: PocCriterionDTO[] } | PocCriterionDTO[]> {
    return this.http.get(`/api/v1/tenants/${encodeURIComponent(id)}/poc/criteria`);
  }

  /** PUT /api/v1/poc-tenants/{id}/criteria — set the agreed criteria. */
  setPocCriteria(id: string, criteria: PocCriterionDTO[]): Promise<unknown> {
    return this.http.put(`/api/v1/poc-tenants/${encodeURIComponent(id)}/criteria`, { body: { criteria } });
  }

  /** GET /tenants/{id}/poc/progress — actual-vs-target per criterion from real
   * BRD 69 value data; inconclusive when the data is genuinely absent. */
  pocProgress(id: string): Promise<PocProgressDTO> {
    return this.http.get<PocProgressDTO>(`/api/v1/tenants/${encodeURIComponent(id)}/poc/progress`);
  }

  /** PATCH /tenants/{id}/poc/criteria/{key}/manual-value — sponsor-updated
   * manual metric (audited, DSP-FR-021). */
  setPocManualValue(id: string, key: string, value: number): Promise<unknown> {
    return this.http.patch(
      `/api/v1/tenants/${encodeURIComponent(id)}/poc/criteria/${encodeURIComponent(key)}/manual-value`,
      { body: { value } },
    );
  }

  /** POST /tenants/{id}/trial (CPL-FR-021) — start a trial; 409 on an illegal
   * commercial transition (demo/poc tenants have no edge into trial). */
  startTrial(id: string, trialDays?: number): Promise<unknown> {
    return this.http.post(`/api/v1/tenants/${encodeURIComponent(id)}/trial`, {
      body: trialDays ? { trial_days: trialDays } : {},
    });
  }

  /** POST /tenants/{id}/trial/extend — extend a running trial. */
  extendTrial(id: string, trialDays?: number): Promise<unknown> {
    return this.http.post(`/api/v1/tenants/${encodeURIComponent(id)}/trial/extend`, {
      body: trialDays ? { trial_days: trialDays } : {},
    });
  }

  /** POST /tenants/{id}/convert — trial → paid. */
  convertTrial(id: string): Promise<unknown> {
    return this.http.post(`/api/v1/tenants/${encodeURIComponent(id)}/convert`, {});
  }

  /** POST /api/v1/users/{id}/activate — re-activate a deactivated user. */
  activateUser(id: string): Promise<UserDTO> {
    return this.http.post<UserDTO>(`/api/v1/users/${encodeURIComponent(id)}/activate`, {});
  }

  /** GET /api/v1/tenants/{id}/entitlements (BRD 66 slice 3, CPL-FR-011/033):
   * the tenant's effective commercial entitlement set + plan/trial/commercial
   * -state context. identity.user.admin (or platform super-admin) only —
   * the tenantCommercial resolver forwards the caller's JWT and degrades to
   * the minimal shape on a downstream permission denial instead of erroring. */
  tenantCommercial(id: string): Promise<TenantEntitlementsDTO> {
    return this.http.get<TenantEntitlementsDTO>(
      `/api/v1/tenants/${encodeURIComponent(id)}/entitlements`,
    );
  }

  /** GET /api/v1/tenants/{id}/embed-config — 404s (via nullOn404 at the
   * resolver) when the tenant has never configured embedding. */
  embedConfig(id: string): Promise<EmbedConfigDTO> {
    return this.http.get<EmbedConfigDTO>(`/api/v1/tenants/${encodeURIComponent(id)}/embed-config`);
  }

  /** PUT /api/v1/tenants/{id}/embed-config — (re)generates the embed secret
   * and sets allowed origins; the plaintext secret is returned exactly once. */
  setEmbedConfig(id: string, allowedOrigins: string[], idempotencyKey?: string): Promise<SetEmbedConfigDTO> {
    return this.http.put<SetEmbedConfigDTO>(`/api/v1/tenants/${encodeURIComponent(id)}/embed-config`, {
      body: { allowed_origins: allowedOrigins },
      idempotencyKey,
    });
  }

  // ---- BYO-P4: per-tenant OIDC IdP config (self-scoped, tenant admin) -------
  /** GET /api/v1/tenants/self/idp — the caller tenant's OIDC IdP, or 404. */
  tenantIdp(): Promise<IdpConfigDTO> {
    return this.http.get<IdpConfigDTO>("/api/v1/tenants/self/idp");
  }
  /** PUT /api/v1/tenants/self/idp — register/update the caller tenant's IdP. */
  setTenantIdp(body: { issuer: string; client_id?: string; discovery_url?: string; enabled?: boolean }, idempotencyKey?: string): Promise<IdpConfigDTO> {
    return this.http.put<IdpConfigDTO>("/api/v1/tenants/self/idp", { body, idempotencyKey });
  }
  /** DELETE /api/v1/tenants/self/idp — turn off SSO for the caller's tenant. */
  deleteTenantIdp(): Promise<void> {
    return this.http.delete<void>("/api/v1/tenants/self/idp");
  }

  // ---- BRD 59 WS3: white-label branding (self-scoped, tenant admin) --------
  /** GET /api/v1/tenants/self/branding — member-safe: every tenant member's
   * app shell + embed surfaces need to read the brand to apply it. */
  tenantBranding(): Promise<TenantBrandingDTO> {
    return this.http.get<TenantBrandingDTO>("/api/v1/tenants/self/branding");
  }
  /** PUT /api/v1/tenants/self/branding — sets the color tokens only; a
   * previously uploaded logo (set via the separate multipart proxy route,
   * bypassing this JSON client) is left untouched. Needs identity.user.admin. */
  setTenantBranding(body: { primary_color: string; accent_color: string }): Promise<TenantBrandingDTO> {
    return this.http.put<TenantBrandingDTO>("/api/v1/tenants/self/branding", { body });
  }
  /** DELETE /api/v1/tenants/self/branding — reverts to the platform default
   * (clears colors + logo in one action). Needs identity.user.admin. */
  deleteTenantBranding(): Promise<void> {
    return this.http.delete<void>("/api/v1/tenants/self/branding");
  }

  // ---- Tier 4b: identity/rbac admin — user + service-account lifecycle -----
  /** PATCH /api/v1/users/{id} — rename (identity.user.admin). Bare User back. */
  patchUser(id: string, fullName: string, idempotencyKey?: string): Promise<UserDTO> {
    return this.http.patch<UserDTO>(`/api/v1/users/${encodeURIComponent(id)}`, {
      body: { full_name: fullName }, idempotencyKey,
    });
  }

  /** POST /api/v1/users/{id}/deactivate (identity.user.admin). The last-admin
   * guard (BR-9) 409s unless overrideLastAdmin (super-admin only) is passed as
   * ?override_last_admin=true. */
  deactivateUser(id: string, overrideLastAdmin?: boolean, idempotencyKey?: string): Promise<UserDTO> {
    return this.http.post<UserDTO>(`/api/v1/users/${encodeURIComponent(id)}/deactivate`, {
      query: { override_last_admin: overrideLastAdmin ? "true" : undefined },
      idempotencyKey,
    });
  }

  /** POST /api/v1/users/{id}/invite/resend (identity.user.admin) — re-issue the
   * activation link for an invited user. 200 User. */
  resendInvite(id: string, idempotencyKey?: string): Promise<UserDTO> {
    return this.http.post<UserDTO>(`/api/v1/users/${encodeURIComponent(id)}/invite/resend`, {
      idempotencyKey,
    });
  }

  /** DELETE /api/v1/users/{id} — soft delete (identity.user.admin). 204. */
  async deleteUser(id: string): Promise<void> {
    await this.http.delete<void>(`/api/v1/users/${encodeURIComponent(id)}`);
  }

  /** POST /api/v1/service-accounts (identity.service_account.admin, 201). The
   * response carries the api_key EXACTLY ONCE — pass it through verbatim. */
  createServiceAccount(body: CreateServiceAccountBody, idempotencyKey?: string): Promise<CreatedServiceAccountDTO> {
    return this.http.post<CreatedServiceAccountDTO>("/api/v1/service-accounts", { body, idempotencyKey });
  }

  /** POST /api/v1/service-accounts/{id}/rotate (identity.service_account.admin).
   * Issues a NEW api_key (shown once) and invalidates the old secret. */
  rotateServiceAccount(id: string, idempotencyKey?: string): Promise<CreatedServiceAccountDTO> {
    return this.http.post<CreatedServiceAccountDTO>(
      `/api/v1/service-accounts/${encodeURIComponent(id)}/rotate`,
      { idempotencyKey },
    );
  }

  /** DELETE /api/v1/service-accounts/{id} — revoke (identity.service_account.admin). 204. */
  async revokeServiceAccount(id: string): Promise<void> {
    await this.http.delete<void>(`/api/v1/service-accounts/${encodeURIComponent(id)}`);
  }

  // ---- BRD 60 WS2: external-agent credentials (self-scoped, tenant admin) ---
  /** GET /api/v1/tenants/self/external-agents — the caller tenant's registered
   * external-agent credentials, metadata only. Needs identity.user.admin. */
  async externalAgents(): Promise<ExternalAgentKeyDTO[]> {
    const res = await this.http.get<{ keys: ExternalAgentKeyDTO[] }>(
      "/api/v1/tenants/self/external-agents",
    );
    return res.keys ?? [];
  }

  /** POST /api/v1/tenants/self/external-agents (identity.user.admin, 201) —
   * mint a credential for a named external agent. The response carries the
   * plaintext key EXACTLY ONCE — pass it through verbatim. */
  registerExternalAgent(
    body: CreateExternalAgentKeyBody,
    idempotencyKey?: string,
  ): Promise<CreatedExternalAgentKeyDTO> {
    return this.http.post<CreatedExternalAgentKeyDTO>("/api/v1/tenants/self/external-agents", {
      body,
      idempotencyKey,
    });
  }

  /** DELETE /api/v1/tenants/self/external-agents/{id} — revoke (deactivate) a
   * credential (identity.user.admin). 204. */
  async revokeExternalAgent(id: string): Promise<void> {
    await this.http.delete<void>(`/api/v1/tenants/self/external-agents/${encodeURIComponent(id)}`);
  }
}
