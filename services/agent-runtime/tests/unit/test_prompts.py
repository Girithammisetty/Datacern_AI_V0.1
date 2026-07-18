"""Agent prompt registry: every prompt is externalized to a versioned .md file,
loaded + digested centrally, wired into the graphs and the catalog prompt_refs.

These tests are the regression guard for the prompt refactor: they fail if a
prompt file goes missing, a graph re-hardcodes a prompt instead of pulling it from
the registry, the VERSIONS map and the .md files drift apart, or the catalog goes
back to faking the digest.
"""

from __future__ import annotations

from importlib.resources import files

import pytest

from app import prompts
from app.agents.catalog import CATALOG, _prompt_refs

# (graph module, constant, prompt id) — the graphs must source their system
# prompt from the registry, not a local literal.
_GRAPH_BINDINGS = [
    ("app.graphs.triage", "_SYS", "triage.system"),
    ("app.graphs.analytics", "_SYS", "analytics.system"),
    ("app.graphs.governance", "_SYS", "governance.system"),
    ("app.graphs.persona_copilot", "_BASE_SYS", "persona_copilot.system"),
    ("app.graphs.dashboard_designer", "_SYS", "dashboard_designer.system"),
    ("app.graphs.inference_agent", "_SYS", "inference.system"),
    ("app.graphs.meta_router", "_SYS", "meta_router.system"),
    ("app.graphs.onboarding", "_SYS", "onboarding.system"),
    ("app.graphs.model_training", "_SYS", "model_training.system"),
    ("app.graphs.ml_engineer", "_SYS", "ml_engineer.system"),
]


def test_every_version_entry_has_a_file_and_loads():
    for pid in prompts.all_ids():
        p = prompts.get(pid)
        assert p.text.strip(), f"{pid} is empty"
        assert p.digest.startswith("sha256:")
        assert p.version >= 1
        assert p.ref == {"id": pid, "version": p.version, "digest": p.digest}


def test_no_orphan_md_files():
    """Every .md in the package is registered in VERSIONS (no dangling prompt)."""
    md = {r.name[:-3] for r in files(prompts.__name__).iterdir()
          if r.name.endswith(".md")}
    assert md == set(prompts.VERSIONS), (
        f"prompt files vs VERSIONS drift: only-file={md - set(prompts.VERSIONS)}, "
        f"only-version={set(prompts.VERSIONS) - md}")


def test_digest_is_stable_and_content_derived():
    a = prompts.get("triage.system")
    b = prompts.get("triage.system")
    assert a.digest == b.digest
    # digest is a function of the exact text
    import hashlib
    expect = "sha256:" + hashlib.sha256(a.text.encode()).hexdigest()[:32]
    assert a.digest == expect


def test_unknown_prompt_raises():
    with pytest.raises(KeyError):
        prompts.get("does.not.exist")


@pytest.mark.parametrize("mod,const,pid", _GRAPH_BINDINGS,
                         ids=[b[2] for b in _GRAPH_BINDINGS])
def test_graph_sources_prompt_from_registry(mod, const, pid):
    """The graph's system-prompt constant IS the registry text (not a re-hardcoded
    literal) — the whole point of the refactor."""
    import importlib
    m = importlib.import_module(mod)
    assert getattr(m, const) == prompts.system_prompt(pid)


def test_every_published_agent_maps_to_a_registered_prompt():
    published = {k for k, (_d, _s, _w, graph_ref, _sk) in CATALOG.items() if graph_ref}
    for key in published:
        pid = prompts.AGENT_SYSTEM_PROMPT.get(key)
        assert pid is not None, f"published agent {key} has no system-prompt mapping"
        assert pid in prompts.VERSIONS, f"{key} -> {pid} not a registered prompt"


def test_catalog_prompt_refs_use_real_digest_not_seed():
    for key in CATALOG:
        refs = _prompt_refs(key)
        assert refs and refs[0]["digest"].startswith("sha256:"), (
            f"{key} prompt_ref is not a real content digest: {refs}")
        assert refs[0]["digest"] != "seed"
