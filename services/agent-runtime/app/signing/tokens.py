"""Agent / OBO token minting for downstream calls (ART-FR-012, BR-6).

Tool calls to tool-plane carry either the run's OBO token (user-initiated) or the
agent-principal token (autonomous). case-service applies a proposal only under an
``agent_obo`` token whose {obo_sub, agent_id, agent_version} produce the
MASTER-FR-041 dual-attribution actor.

In prod these are minted/exchanged via identity-service. In dev/tests agent-runtime
self-signs them with its RS256 signing key (the same key it publishes at its JWKS
endpoint), so tool-plane / case-service — configured to trust that JWKS/issuer —
verify them for real. This is a real RS256 token, not a stub; only the *issuer of
record* differs between dev (self) and prod (identity-service).
"""

from __future__ import annotations

import re
import time

import jwt as pyjwt

from app.signing.keys import SigningKey

# Canonical action name (MASTER-FR-016): <service>.<resource>.<verb>.
_ACTION_RE = re.compile(r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$")

# The only verbs a tool may delegate downstream (BRD 74 AC-10). Mirrors
# tool-plane's DelegableVerbs (internal/domain/delegation.go) — the gateway
# refuses a token carrying anything else, and refusing it HERE means an invalid
# delegation fails at the mint instead of at the call.
DELEGABLE_VERBS = frozenset({"read", "list", "export"})


class TokenMinter:
    def __init__(
        self,
        key: SigningKey,
        *,
        issuer: str,
        audience: str,
        ttl_seconds: int = 900,
    ) -> None:
        self._key = key
        self.issuer = issuer
        self.audience = audience
        self.ttl_seconds = ttl_seconds

    def _base(self, sub: str, tenant_id: str) -> dict:
        iat = int(time.time())
        return {
            "iss": self.issuer,
            "aud": self.audience,
            "sub": sub,
            "iat": iat,
            "exp": iat + self.ttl_seconds,
            "tenant_id": tenant_id,
        }

    def mint_agent_obo(
        self,
        *,
        tenant_id: str,
        obo_sub: str,
        agent_key: str,
        agent_version: int,
        workspace_id: str | None,
        scopes: list[str],
    ) -> str:
        """agent_obo token: acts for the user (obo_sub) via the agent."""
        claims = self._base(f"agent:{agent_key}@v{agent_version}", tenant_id)
        claims.update(
            typ="agent_obo",
            obo_sub=obo_sub,
            agent_id=agent_key,
            agent_version=str(agent_version),
            scopes=scopes,
        )
        if workspace_id:
            claims["workspace_id"] = workspace_id
        return pyjwt.encode(claims, self._key.private_pem, algorithm="RS256",
                            headers={"kid": self._key.kid})

    def mint_tool_obo(
        self,
        *,
        tenant_id: str,
        obo_sub: str,
        agent_key: str,
        agent_version: int,
        tool_id: str,
        downstream_actions: list[str] | None = None,
        workspace_id: str | None = None,
    ) -> str:
        """The sanctioned OBO token for ONE tool call (BRD 74 AC-10).

        Scopes are ``[tool_id] + downstream_actions``. The tool id pins
        tool-plane's toolset gate to this one tool; the downstream actions are
        what the tool's REGISTERED version declares its facade will exercise on
        other services with this token — the caller passes the declaration
        (tool-plane publishes it on ``tools/list`` as ``_meta.required_scopes``),
        it is never invented here.

        Two rules make the wider scope safe, and both are enforced:

        * Only READ actions may be delegated, so a delegated token can never
          carry authority to mutate anything. A write still needs the signed,
          human-approved proposal grant.
        * No wildcard. ``scopes=["*"]`` (what a RUN token carries) is exactly
          the token tool-plane refuses to delegate, because it would hand a
          facade the human's entire authority rather than the tool's declared
          slice.

        The token never widens the human: rbac evaluates ``agent_obo`` as
        intersection(agent scopes, the obo user's grants) — MASTER-FR-015 /
        RBC BR-6 — so an action in ``scopes`` that the human does not hold is
        still denied.
        """
        scopes = [tool_id]
        for action in downstream_actions or []:
            if action == "*" or not _ACTION_RE.match(action):
                raise ValueError(
                    f"downstream action {action!r} is not a canonical "
                    "<service>.<resource>.<verb> action name")
            if action.rsplit(".", 1)[-1] not in DELEGABLE_VERBS:
                raise ValueError(
                    f"downstream action {action!r} is not a read action; only "
                    f"{'/'.join(sorted(DELEGABLE_VERBS))} verbs may be delegated")
            if action in scopes:
                raise ValueError(f"downstream action {action!r} is declared more than once")
            scopes.append(action)
        return self.mint_agent_obo(
            tenant_id=tenant_id, obo_sub=obo_sub, agent_key=agent_key,
            agent_version=agent_version, workspace_id=workspace_id, scopes=scopes)

    def mint_agent_autonomous(
        self,
        *,
        tenant_id: str,
        agent_key: str,
        agent_version: int,
        scopes: list[str],
    ) -> str:
        """agent_autonomous token: the agent's own principal (governance runs)."""
        claims = self._base(f"agent:{agent_key}@v{agent_version}", tenant_id)
        claims.update(
            typ="agent_autonomous",
            agent_id=agent_key,
            agent_version=str(agent_version),
            scopes=scopes,
        )
        return pyjwt.encode(claims, self._key.private_pem, algorithm="RS256",
                            headers={"kid": self._key.kid})

    def mint_service(self, *, tenant_id: str, scopes: list[str]) -> str:
        """service token: agent-runtime acting as itself (e.g. realtime-hub
        internal publish, which requires typ=service|agent* + a scope such as
        ``realtime.publish`` — see realtime-hub authenticatePublisher)."""
        claims = self._base("svc:agent-runtime", tenant_id)
        claims.update(typ="service", scopes=scopes)
        return pyjwt.encode(claims, self._key.private_pem, algorithm="RS256",
                            headers={"kid": self._key.kid})
