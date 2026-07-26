package store

import (
	"context"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// audienceCap bounds the rows returned to a single notification-service
// audience.resolve call, mirroring NOTIF-FR-013's own MaxAudience truncation
// so a huge role/group never returns an unbounded result set.
const audienceCap = 500

// RoleAudience returns distinct, non-expired user ids holding the named
// system role via permission-group membership — the real source of truth
// notification-service's role-addressed audiences (tenant admins, workspace
// managers) resolve against (NOTIF-FR-013). When wsID is not uuid.Nil the
// result is further restricted to users assigned to that workspace (public
// workspace OR member of a linked content group) — the same assignment rule
// LoadSnapshot uses to grant per-workspace actions (RBC-FR-003).
func (s *Store) RoleAudience(ctx context.Context, tenant uuid.UUID, roleName string, wsID uuid.UUID) ([]string, error) {
	ids := []string{}
	err := s.WithTenant(ctx, tenant, func(tx pgx.Tx) error {
		query := `
			SELECT DISTINCT m.user_id FROM members m
			JOIN groups g ON g.id = m.group_id
			JOIN group_roles gr ON gr.group_id = g.id
			JOIN roles r ON r.id = gr.role_id
			WHERE g.group_type = 'permission' AND r.system AND r.name = $1
			  AND (m.expires_at IS NULL OR m.expires_at > now())`
		args := []any{roleName}
		if wsID != uuid.Nil {
			query += `
			  AND EXISTS (
			    SELECT 1 FROM workspaces w
			    WHERE w.id = $2 AND (
			      w.public
			      OR EXISTS (
			        SELECT 1 FROM members cm
			        JOIN workspace_groups wg ON wg.group_id = cm.group_id
			        WHERE wg.workspace_id = w.id AND cm.user_id = m.user_id
			          AND (cm.expires_at IS NULL OR cm.expires_at > now())
			      )
			    )
			  )`
			args = append(args, wsID)
		}
		args = append(args, audienceCap)
		query += ` ORDER BY m.user_id LIMIT $` + strconv.Itoa(len(args))
		rows, err := tx.Query(ctx, query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			ids = append(ids, id)
		}
		return rows.Err()
	})
	return ids, err
}

// WorkspaceSubscribers returns users explicitly assigned to a workspace via a
// linked content group (RBC-FR-003). Public workspaces are deliberately
// excluded here: rbac-service tracks group membership, not the roster of
// every tenant user (that lives in identity-service), so there is no real
// list to expand a public workspace's implicit access into — returning one
// would mean guessing, not resolving. This is a documented scope limit, not
// a silent gap: an explicitly content-group-assigned audience is always real
// data.
func (s *Store) WorkspaceSubscribers(ctx context.Context, tenant, wsID uuid.UUID) ([]string, error) {
	ids := []string{}
	err := s.WithTenant(ctx, tenant, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT DISTINCT m.user_id FROM members m
			JOIN workspace_groups wg ON wg.group_id = m.group_id
			WHERE wg.workspace_id = $1 AND (m.expires_at IS NULL OR m.expires_at > now())
			ORDER BY m.user_id LIMIT $2`, wsID, audienceCap)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			ids = append(ids, id)
		}
		return rows.Err()
	})
	return ids, err
}
