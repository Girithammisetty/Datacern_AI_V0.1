package domain

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// StepDeps carries every adapter the provisioning activities need
// (IDN-FR-006). All are interfaces; tests inject fakes.
type StepDeps struct {
	Store     Store
	Keycloak  KeycloakAdmin
	Terraform TerraformRunner
	DB        DatabaseProvisioner
	Prober    HealthProber
	Clock     func() time.Time
	// DemoBundles/DemoSeed back the SeedDemoContent step (BRD 70 §2.3). Both
	// nil is fine for any deployment that never provisions profile=demo
	// tenants (the step no-ops for every other profile); a profile=demo
	// tenant hitting a nil adapter fails loud rather than silently skipping
	// seeding -- see SeedDemoContent's Run below.
	DemoBundles DemoBundleLoader
	DemoSeed    DemoSeedRunner
}

func (d StepDeps) now() time.Time {
	if d.Clock != nil {
		return d.Clock().UTC()
	}
	return time.Now().UTC()
}

func (d StepDeps) tfInputs(t *Tenant) TerraformInputs {
	return TerraformInputs{
		Identifier:   t.Name,
		SchemaPrefix: t.SchemaPrefix,
		K8sNamespace: t.K8sNamespace,
		Subdomain:    t.Subdomain,
		Quotas:       t.Quotas,
		Cloud:        t.Cloud,
		Version:      t.PlatformVersion,
	}
}

// ProvisionSteps builds the 7-step workflow of IDN-FR-006.
func (d StepDeps) ProvisionSteps(t *Tenant) []Step {
	return []Step{
		{
			Name: "AssignCell", CompensationName: "ReleaseCellReservation",
			Run: func(ctx context.Context, t *Tenant) error {
				if t.CellID != nil {
					return nil // idempotent re-run: already assigned
				}
				cells, err := d.Store.ListCells(ctx)
				if err != nil {
					return err
				}
				for _, c := range cells {
					if c.Cloud != t.Cloud || c.TenantCount >= c.Capacity {
						continue
					}
					if err := d.Store.ReserveCell(ctx, c.ID); err != nil {
						continue
					}
					t.CellID = &c.ID
					return d.Store.UpdateTenant(ctx, t)
				}
				// BR-3: fail fast — no cell with capacity for this cloud.
				return &Error{Code: CodeCellCapacity, HTTP: 422, Message: "no cell with capacity for cloud " + t.Cloud}
			},
			Compensate: func(ctx context.Context, t *Tenant) error {
				if t.CellID == nil {
					return nil
				}
				if err := d.Store.ReleaseCell(ctx, *t.CellID); err != nil {
					return err
				}
				t.CellID = nil
				return d.Store.UpdateTenant(ctx, t)
			},
		},
		{
			Name: "CreateKeycloakRealm", CompensationName: "DeleteKeycloakRealm",
			Run: func(ctx context.Context, t *Tenant) error {
				return d.Keycloak.CreateRealm(ctx, t.Name)
			},
			Compensate: func(ctx context.Context, t *Tenant) error {
				return d.Keycloak.DeleteRealm(ctx, t.Name)
			},
		},
		{
			Name: "ProvisionInfra", CompensationName: "TerraformDestroy",
			Run: func(ctx context.Context, t *Tenant) error {
				return d.Terraform.Apply(ctx, d.tfInputs(t)) // awaits completion in-call
			},
			Compensate: func(ctx context.Context, t *Tenant) error {
				return d.Terraform.Destroy(ctx, d.tfInputs(t))
			},
		},
		{
			Name: "CreateDatabases", CompensationName: "DropSchemas",
			Run: func(ctx context.Context, t *Tenant) error {
				return d.DB.CreateSchemas(ctx, t.ID, t.SchemaPrefix)
			},
			Compensate: func(ctx context.Context, t *Tenant) error {
				return d.DB.DropSchemas(ctx, t.ID, t.SchemaPrefix)
			},
		},
		{
			Name: "RegisterServices", CompensationName: "DeregisterServices",
			Run: func(ctx context.Context, t *Tenant) error {
				return d.Store.SetTenantModules(ctx, t.ID, t.Modules, t.PlatformVersion)
			},
			Compensate: func(ctx context.Context, t *Tenant) error {
				return d.Store.DeleteTenantModules(ctx, t.ID)
			},
		},
		{
			// SeedDefaults: owner invite (BR-7) + default-workspace request
			// event to rbac-service. Idempotent re-run safe; no compensation.
			Name: "SeedDefaults",
			Run: func(ctx context.Context, t *Tenant) error {
				now := d.now()
				if _, err := d.Store.GetUserByEmail(ctx, t.ID, t.OwnerEmail); err == nil {
					return nil // already seeded
				}
				idp, err := d.Keycloak.CreateUser(ctx, t.Name, t.OwnerEmail, "Tenant Owner")
				if err != nil {
					return err
				}
				uid, _ := uuid.NewV7()
				owner := &User{
					ID: uid, TenantID: t.ID, Email: t.OwnerEmail, FullName: "Tenant Owner",
					Status: UserInvited, IdpSubject: &idp, CreatedAt: now, UpdatedAt: now,
				}
				tok, hash, err := NewInvitationToken()
				if err != nil {
					return err
				}
				actor := Actor{Type: "service", ID: "identity-service"}
				if err := d.Store.CreateUser(ctx, owner,
					// is_owner distinguishes this bootstrap invite from a regular
					// admin-driven POST /users invite (user_service.go), which emits
					// the SAME event type without this flag. rbac-service's consumer
					// keys the owner's automatic Admin group membership on it — a
					// regular invited user must NOT auto-become Admin.
					NewEvent(EvUserInvited, t.ID, actor, owner.URN(), now, map[string]any{
						"email": owner.Email, "activation_token": tok, "expires_at": now.Add(InvitationTTL),
						"is_owner": true, "user_id": owner.ID.String(),
					}),
					NewEvent("workspace.default_requested", t.ID, actor, t.URN(), now, map[string]any{
						"owner_user_id": owner.ID.String(),
					}),
				); err != nil {
					return err
				}
				invID, _ := uuid.NewV7()
				return d.Store.CreateInvitation(ctx, &Invitation{
					ID: invID, TenantID: t.ID, UserID: owner.ID, TokenHash: hash,
					ExpiresAt: now.Add(InvitationTTL), CreatedAt: now, UpdatedAt: now,
				})
			},
		},
		{
			// SeedDemoContent (BRD 70 §2.3, DSP-FR-010): applies the tenant's
			// deploy/demo/<pack>/ bundle through real APIs, generalizing
			// deploy/local/seed_claims_demo.py's pattern. A no-op success for
			// every profile except demo -- the same "idempotent re-run:
			// already done" shape AssignCell's Run above uses -- so this step
			// costs nothing for standard/poc tenants and never needs its own
			// gate at the call sites that build ProvisionSteps. No
			// compensation: partial seed content on abort is inert (no
			// downstream billing/security exposure) and the reset endpoint
			// (§2.4) already re-converges it on demand.
			Name: "SeedDemoContent",
			Run: func(ctx context.Context, t *Tenant) error {
				if t.Profile != ProfileDemo {
					return nil
				}
				if d.DemoBundles == nil || d.DemoSeed == nil {
					// Fail loud (CONVENTIONS.md "no stub reachable from
					// runtime"): a demo tenant with no seeding adapter
					// configured must not silently provision empty.
					return EInternal("demo seeding is not configured on this deployment (DemoBundles/DemoSeed adapters unset)")
				}
				bundle, err := d.DemoBundles.Load(t.DemoPack)
				if err != nil {
					return err
				}
				return d.DemoSeed.Seed(ctx, t, bundle)
			},
		},
		{
			Name: "Verify", // no compensation; failure fails the workflow
			Run: func(ctx context.Context, t *Tenant) error {
				return d.Prober.Probe(ctx, t)
			},
		},
	}
}

// DestroySteps is the deletion workflow (IDN-FR-008 destroy): Terraform
// destroy must succeed BEFORE the record flips to deleted (BR-6, AC-9).
func (d StepDeps) DestroySteps(t *Tenant) []Step {
	return []Step{
		{
			Name: "TerraformDestroy",
			Run: func(ctx context.Context, t *Tenant) error {
				return d.Terraform.Destroy(ctx, d.tfInputs(t))
			},
		},
		{
			Name: "DeleteKeycloakRealm",
			Run: func(ctx context.Context, t *Tenant) error {
				return d.Keycloak.DeleteRealm(ctx, t.Name)
			},
		},
		{
			Name: "RevokeCredentials", // cascades SAs + agent principals (IDN-FR-008c)
			Run: func(ctx context.Context, t *Tenant) error {
				now := d.now()
				sas, _, err := d.Store.ListServiceAccounts(ctx, t.ID, PageRequest{Limit: MaxPageLimit})
				if err != nil {
					return err
				}
				for _, sa := range sas {
					if sa.RevokedAt == nil {
						sa.RevokedAt = &now
						sa.UpdatedAt = now
						if err := d.Store.UpdateServiceAccount(ctx, sa,
							NewEvent(EvSvcAccountRevoked, t.ID, Actor{Type: "service", ID: "identity-service"}, sa.URN(), now, nil)); err != nil {
							return err
						}
					}
				}
				return nil
			},
		},
		{
			Name: "ReleaseCell",
			Run: func(ctx context.Context, t *Tenant) error {
				if t.CellID == nil {
					return nil
				}
				return d.Store.ReleaseCell(ctx, *t.CellID)
			},
		},
	}
}
