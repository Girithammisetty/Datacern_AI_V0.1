package domain

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Declared downstream authority (BRD 74 AC-10).
//
// Almost every tool's backend facade answers out of its OWN store, so the
// gateway federates to it with attribution only ({tool_id, args, tenant,
// obo_sub, agent_id} + SPIFFE) and the facade re-authorizes obo_sub against its
// own OPA sidecar. A cross-service READ fan-out has no own store: the only way
// it can answer is by calling other services, and the only credential those
// services accept is the caller's own token. Serving such a tool therefore
// requires the gateway to DELEGATE the caller's bearer to the facade.
//
// Delegation is the dangerous part, so it is constrained on both ends:
//
//  1. Registration: a version may only declare downstream actions if it is
//     read-tier, and every declared action must be a canonical
//     <service>.<resource>.<verb> name (MASTER-FR-016) whose verb is a READ verb.
//     A tool can therefore never declare itself the authority to write, and can
//     never declare a wildcard.
//  2. Call time: the caller's token must already be narrowed to that
//     declaration — its scopes must be exactly the tool id plus a subset of the
//     declared actions. A token carrying "*" (or any action the tool did not
//     declare) is REFUSED, not silently trimmed and not silently forwarded.
//
// The result is that a forwarded token can never exercise more than the union of
// what the tool declared and what the human already holds: the declaration caps
// the token, and each downstream service still evaluates the same OPA
// intersection (agent scopes ∧ the obo user's grants, MASTER-FR-015) it
// evaluates for any other agent_obo request.

// MaxDownstreamActions caps a declaration so one tool cannot enumerate the
// platform's whole action catalog.
const MaxDownstreamActions = 32

// actionNamePattern is the canonical action name (MASTER-FR-016):
// <service>.<resource>.<verb>.
var actionNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`)

// DelegableVerbs are the only verbs a tool may declare downstream. Keeping this
// to the read verbs is what makes delegation safe to reason about: a forwarded
// token can never carry authority to mutate anything, so the proposal/approval
// path (TPL-FR-035) remains the only route to a write.
var DelegableVerbs = map[string]bool{"read": true, "list": true, "export": true}

// ValidateDownstreamActions checks a version's declared downstream authority at
// registration time. tier is the version's permission tier.
func ValidateDownstreamActions(tier string, actions []string) []FieldError {
	if len(actions) == 0 {
		return nil
	}
	var errs []FieldError
	if tier != TierRead {
		errs = append(errs, FieldError{Field: "downstream_actions",
			Message: "only a read-tier tool may declare downstream_actions"})
		return errs
	}
	if len(actions) > MaxDownstreamActions {
		errs = append(errs, FieldError{Field: "downstream_actions",
			Message: fmt.Sprintf("at most %d downstream actions may be declared", MaxDownstreamActions)})
		return errs
	}
	seen := map[string]bool{}
	for _, a := range actions {
		switch {
		case !actionNamePattern.MatchString(a):
			errs = append(errs, FieldError{Field: "downstream_actions",
				Message: fmt.Sprintf("%q is not a canonical <service>.<resource>.<verb> action name", a)})
		case !DelegableVerbs[ActionVerb(a)]:
			errs = append(errs, FieldError{Field: "downstream_actions",
				Message: fmt.Sprintf("%q is not a read action; only %s verbs may be delegated",
					a, strings.Join(sortedVerbs(), "/"))})
		case seen[a]:
			errs = append(errs, FieldError{Field: "downstream_actions",
				Message: fmt.Sprintf("%q is declared more than once", a)})
		}
		seen[a] = true
	}
	return errs
}

// ActionVerb returns the trailing verb segment of an action name.
func ActionVerb(action string) string {
	i := strings.LastIndex(action, ".")
	if i < 0 {
		return action
	}
	return action[i+1:]
}

func sortedVerbs() []string {
	out := make([]string, 0, len(DelegableVerbs))
	for v := range DelegableVerbs {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

// DelegableScopes is the exact scope set a caller's token must be narrowed to in
// order for the gateway to forward it to this tool's facade: the tool id (so the
// pinned-toolset gate still binds the token to this one tool) plus the declared
// downstream actions.
func DelegableScopes(toolID string, declared []string) []string {
	out := make([]string, 0, len(declared)+1)
	out = append(out, toolID)
	out = append(out, declared...)
	return out
}

// TokenDelegable reports whether a verified caller token with these scopes may
// be forwarded to a tool declaring these downstream actions. It returns the
// reason when it may not, so the denial says WHY instead of degrading to a
// tokenless call the facade could only answer with an empty result.
//
// The rule is deliberately "narrowed already", not "narrow it for me": the
// gateway holds no signing key, so it cannot mint a reduced token, and silently
// forwarding a broader one would hand the facade — and everything the facade
// calls — authority the tool never declared.
func TokenDelegable(toolID string, declared, scopes []string) (bool, string) {
	if len(declared) == 0 {
		return false, "tool declares no downstream actions"
	}
	allowed := map[string]bool{toolID: true}
	for _, a := range declared {
		allowed[a] = true
	}
	hasTool := false
	for _, s := range scopes {
		if s == "*" {
			return false, "token carries the wildcard scope; a delegated token must be narrowed to " +
				strings.Join(DelegableScopes(toolID, declared), ",")
		}
		if !allowed[s] {
			return false, fmt.Sprintf("token scope %q is not declared by %s as a downstream action", s, toolID)
		}
		if s == toolID {
			hasTool = true
		}
	}
	if !hasTool {
		return false, "token is not scoped to " + toolID
	}
	return true, ""
}
