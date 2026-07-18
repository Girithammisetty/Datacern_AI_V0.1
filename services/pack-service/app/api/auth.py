"""AuthN/AuthZ (vendored per the wave-1 rule, mirrors dataset-service).

External requests carry an RS256 JWT (MASTER-FR-010/011); authorization runs
through the shared OPA client over the rbac permissions projection in Redis
(MASTER-FR-012) — NOT JWT scopes. The verified Principal AND the raw bearer
token are stashed on the request: pack-service forwards that same user token to
Core services when it materializes a pack, so every downstream write is
authorized as the installing user.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import httpx
import jwt as pyjwt
from fastapi import Request

from app.config import Settings
from app.domain.errors import PermissionDenied, Unauthenticated


@dataclass(slots=True)
class Principal:
    sub: str
    tenant_id: str
    typ: str = "user"
    scopes: list[str] = field(default_factory=list)
    obo_sub: str | None = None
    workspace_id: str | None = None

    @property
    def effective_user(self) -> str:
        if self.typ == "agent_obo" and self.obo_sub:
            return self.obo_sub
        return self.sub


class TokenVerifier:
    """RS256 verification against a static PEM (dev/tests) or cached JWKS (prod)."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._jwks: dict[str, object] = {}
        self._jwks_fetched_at = 0.0

    async def _key_for(self, token: str):
        if self.settings.jwt_public_key_pem:
            return self.settings.jwt_public_key_pem
        if not self.settings.jwks_url:
            raise Unauthenticated("no JWT verification key configured")
        header = pyjwt.get_unverified_header(token)
        kid = header.get("kid")
        now = time.monotonic()
        if kid not in self._jwks or now - self._jwks_fetched_at > self.settings.jwks_ttl_seconds:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(self.settings.jwks_url)
                resp.raise_for_status()
            self._jwks = {
                k["kid"]: pyjwt.algorithms.RSAAlgorithm.from_jwk(k)
                for k in resp.json().get("keys", [])
                if k.get("kty") == "RSA"
            }
            self._jwks_fetched_at = now
        if kid not in self._jwks:
            raise Unauthenticated("unknown signing key")
        return self._jwks[kid]

    async def verify(self, token: str) -> Principal:
        try:
            key = await self._key_for(token)
            claims = pyjwt.decode(
                token,
                key,
                algorithms=["RS256"],
                audience=self.settings.jwt_audience,
                issuer=self.settings.jwt_issuer,
                options={"require": ["exp", "iss", "aud", "sub"]},
            )
        except Unauthenticated:
            raise
        except Exception as exc:  # noqa: BLE001 - any JWT failure is a 401
            raise Unauthenticated(f"invalid token: {exc}") from exc
        if not claims.get("tenant_id"):
            raise Unauthenticated("token missing tenant_id claim")
        scopes = claims.get("scopes") or []
        if isinstance(scopes, str):
            scopes = scopes.split()
        return Principal(
            sub=claims["sub"],
            tenant_id=claims["tenant_id"],
            typ=claims.get("typ", "user"),
            scopes=list(scopes),
            obo_sub=claims.get("obo_sub"),
            workspace_id=claims.get("workspace_id"),
        )


class LocalScopeAuthz:
    """Scope-based allow (unit/dev only)."""

    async def allow(self, principal: Principal, action: str, resource_urn: str | None) -> bool:
        return "*" in principal.scopes or action in principal.scopes


class OpaAuthzClient:
    """Real OPA authorization over the rbac permissions projection (MASTER-FR-012),
    identical to dataset-service's client."""

    def __init__(self, opa_url: str, *, redis_url: str = "redis://localhost:6379/0"):
        from windrose_common.opaclient import OpaClient
        from windrose_common.redisx import build_redis

        self._redis = build_redis(redis_url)
        self._client = OpaClient(opa_url)

    async def allow(self, principal: Principal, action: str, resource_urn: str | None) -> bool:
        from windrose_common.projection import load_projection

        subject = {
            "id": principal.effective_user,
            "typ": principal.typ,
            "scopes": principal.scopes,
            "obo_sub": principal.obo_sub or "",
        }
        proj = await load_projection(
            self._redis,
            tenant=principal.tenant_id,
            subject=subject,
            action=action,
            workspace_id=principal.workspace_id,
            resource_urn=resource_urn,
        )
        return await self._client.allow(
            subject=subject,
            action=action,
            tenant=principal.tenant_id,
            resource_urn=resource_urn,
            workspace_id=principal.workspace_id,
            projection=proj,
        )


def get_principal(request: Request) -> Principal:
    principal = getattr(request.state, "principal", None)
    if principal is None:
        raise Unauthenticated("missing bearer token")
    return principal


def get_bearer(request: Request) -> str:
    """The raw user JWT, forwarded to Core when materializing a pack."""
    token = getattr(request.state, "raw_token", None)
    if not token:
        raise Unauthenticated("missing bearer token")
    return token


def require(action: str):
    """Route dependency: authenticated principal + OPA authz for `action`."""

    async def dependency(request: Request) -> Principal:
        principal = get_principal(request)
        authz = request.app.state.authz
        if not await authz.allow(principal, action, None):
            raise PermissionDenied(f"missing permission {action}")
        return principal

    return dependency
