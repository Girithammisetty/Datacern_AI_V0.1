package api

import (
	"io"
	"net/http"
	"strings"

	"github.com/datacern-ai/identity-service/internal/domain"
)

// BRD 59 WS3: per-tenant white-label branding, self-service for tenant admins
// (mirrors labels/idp's /tenants/self/... shape). GETs are member-safe (every
// tenant member's app shell + embed surfaces need to read the brand); the
// PUT/upload/DELETE mutators need identity.user.admin.

// maxLogoBytes caps a logo upload (2 MiB): a brand mark, not a document —
// small enough to read fully into memory for the MinIO put.
const maxLogoBytes = 2 << 20

var allowedLogoContentTypes = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/svg+xml": true, "image/webp": true,
}

func logoObjectKey(tenantID string) string { return tenantID + "/logo" }

// isNotFound reports whether err is a domain NOT_FOUND error.
func isNotFound(err error) bool {
	de, ok := domain.AsError(err)
	return ok && de.Code == domain.CodeNotFound
}

// handleGetTenantBranding returns the caller tenant's brand for the app shell
// to apply (CSS custom properties) and the embed surfaces to theme with. A
// tenant that has never configured branding gets the all-empty "unconfigured"
// shape rather than a 404, so the app shell always has something to render.
func (s *Server) handleGetTenantBranding(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	b, err := s.Store.GetTenantBranding(r.Context(), claims.TenantID)
	if err != nil {
		if isNotFound(err) {
			writeJSON(w, http.StatusOK, map[string]any{
				"configured": false, "has_logo": false, "primary_color": "", "accent_color": "", "updated_at": nil,
			})
			return
		}
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"configured":    b.PrimaryColor != "" || b.AccentColor != "" || b.LogoObjectKey != "",
		"has_logo":      b.LogoObjectKey != "",
		"primary_color": b.PrimaryColor,
		"accent_color":  b.AccentColor,
		"updated_at":    b.UpdatedAt,
	})
}

// getOrZeroBranding reads the caller tenant's current branding row, or a
// zero-value one if none exists yet — the read-merge base for the two
// independent editable groups (colors vs logo) so setting one never clobbers
// the other.
func (s *Server) getOrZeroBranding(r *http.Request) (*domain.TenantBranding, error) {
	claims := ClaimsFrom(r.Context())
	b, err := s.Store.GetTenantBranding(r.Context(), claims.TenantID)
	if err != nil {
		if isNotFound(err) {
			return &domain.TenantBranding{TenantID: claims.TenantID}, nil
		}
		return nil, err
	}
	return b, nil
}

type setBrandingReq struct {
	PrimaryColor string `json:"primary_color"`
	AccentColor  string `json:"accent_color"`
}

// handleSetTenantBranding upserts the color tokens only, leaving any
// previously uploaded logo untouched. Needs identity.user.admin.
func (s *Server) handleSetTenantBranding(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	var body setBrandingReq
	if err := decodeBody(r, &body); err != nil {
		writeErr(w, r, err)
		return
	}
	body.PrimaryColor = strings.TrimSpace(body.PrimaryColor)
	body.AccentColor = strings.TrimSpace(body.AccentColor)
	if err := domain.ValidateBrandColor("primary_color", body.PrimaryColor); err != nil {
		writeErr(w, r, err)
		return
	}
	if err := domain.ValidateBrandColor("accent_color", body.AccentColor); err != nil {
		writeErr(w, r, err)
		return
	}
	b, err := s.getOrZeroBranding(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	b.PrimaryColor, b.AccentColor, b.UpdatedBy = body.PrimaryColor, body.AccentColor, claims.Subject
	if err := s.Store.UpsertTenantBranding(r.Context(), b); err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"configured": true, "has_logo": b.LogoObjectKey != "",
		"primary_color": b.PrimaryColor, "accent_color": b.AccentColor,
	})
}

// handleUploadTenantLogo replaces the caller tenant's logo (multipart "file"),
// leaving the color tokens untouched. Needs identity.user.admin. Requires the
// Logo object store to be configured (503 otherwise, honest about the gap
// rather than silently no-op'ing).
func (s *Server) handleUploadTenantLogo(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	if s.Logo == nil {
		writeErr(w, r, domain.ENotImplemented("logo storage is not configured"))
		return
	}
	if err := r.ParseMultipartForm(maxLogoBytes + 1024); err != nil {
		writeErr(w, r, domain.EValidation("invalid multipart form"))
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, r, domain.EValidation("a 'file' part is required"))
		return
	}
	defer func() { _ = file.Close() }()

	data, err := io.ReadAll(io.LimitReader(file, maxLogoBytes+1))
	if err != nil {
		writeErr(w, r, domain.EValidation("could not read upload"))
		return
	}
	if len(data) == 0 {
		writeErr(w, r, domain.EValidation("uploaded file is empty"))
		return
	}
	if len(data) > maxLogoBytes {
		writeErr(w, r, domain.EValidation("logo exceeds the 2 MiB limit"))
		return
	}
	contentType := hdr.Header.Get("Content-Type")
	if !allowedLogoContentTypes[contentType] {
		writeErr(w, r, domain.EValidation("logo must be PNG, JPEG, SVG, or WebP",
			domain.FieldError{Field: "file", Message: "unsupported content type " + contentType}))
		return
	}

	key := logoObjectKey(claims.TenantID.String())
	if err := s.Logo.Put(r.Context(), key, data, contentType); err != nil {
		writeErr(w, r, domain.EInternal("logo store write failed"))
		return
	}
	b, err := s.getOrZeroBranding(r)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	b.LogoObjectKey, b.LogoContentType, b.UpdatedBy = key, contentType, claims.Subject
	if err := s.Store.UpsertTenantBranding(r.Context(), b); err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"configured": true, "has_logo": true,
		"primary_color": b.PrimaryColor, "accent_color": b.AccentColor,
	})
}

// handleGetTenantLogo streams the caller tenant's logo bytes. Member-safe
// (like handleGetTenantBranding): the app shell renders it for every member.
// Cacheable for a short window — logos change rarely but should still refresh
// within a session of an admin swapping the brand.
func (s *Server) handleGetTenantLogo(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	b, err := s.Store.GetTenantBranding(r.Context(), claims.TenantID)
	if err != nil || b.LogoObjectKey == "" {
		writeErr(w, r, domain.ENotFound("logo"))
		return
	}
	if s.Logo == nil {
		writeErr(w, r, domain.ENotImplemented("logo storage is not configured"))
		return
	}
	data, err := s.Logo.Get(r.Context(), b.LogoObjectKey)
	if err != nil {
		writeErr(w, r, domain.ENotFound("logo"))
		return
	}
	w.Header().Set("Content-Type", b.LogoContentType)
	w.Header().Set("Cache-Control", "private, max-age=300")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// handleDeleteTenantBranding reverts the caller tenant to the platform
// default brand (clears colors + logo in one action). Needs identity.user.admin.
func (s *Server) handleDeleteTenantBranding(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	if b, err := s.Store.GetTenantBranding(r.Context(), claims.TenantID); err == nil && b.LogoObjectKey != "" && s.Logo != nil {
		_ = s.Logo.Delete(r.Context(), b.LogoObjectKey) // best-effort: the pointer row is the source of truth
	}
	if err := s.Store.DeleteTenantBranding(r.Context(), claims.TenantID); err != nil {
		writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
