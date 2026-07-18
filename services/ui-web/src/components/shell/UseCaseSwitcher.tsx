"use client";
import { useMemo, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { Building2, Check, ChevronsUpDown, Plus, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/primitives";
import { Can } from "@/components/authz/Can";
import { FEATURE_GATES } from "@/lib/authz/registry";
import { useWorkspaces, useCreateWorkspace } from "@/lib/graphql/hooks";
import { useSession } from "@/lib/session/SessionContext";
import { useMe } from "@/lib/graphql/hooks";
import { GraphQLRequestError } from "@/lib/graphql/client";
import type { Workspace } from "@/lib/graphql/types";

/**
 * Use-case switcher (top bar). A "use case" IS an rbac workspace — the neutral,
 * end-user label for the content boundary a team decides within. Making it a
 * switcher here (rather than a static breadcrumb + a buried Admin > Workspaces
 * page) is what lets a member actually SEE, SWITCH BETWEEN, and CREATE use cases
 * — the gap end users hit ("how do I create/see multiple use cases?").
 *
 * Switching re-mints the session with a new workspace_id (same identity/tenant/
 * scopes); rbac still enforces per-use-case access, so it is fail-safe.
 */
export function UseCaseSwitcher() {
  const session = useSession();
  const { data: me } = useMe();
  const tenantLabel = me?.me.tenantName || session.tenantId;
  const currentLabel = me?.me.workspaceName || session.workspaceId;

  const query = useWorkspaces();
  const workspaces = useMemo(
    () => (query.data?.pages.flatMap((p) => p.nodes) ?? []).filter((w) => !w.archived),
    [query.data],
  );
  const [creating, setCreating] = useState(false);
  const [switching, setSwitching] = useState(false);

  async function switchTo(workspaceId: string) {
    if (workspaceId === session.workspaceId || switching) return;
    setSwitching(true);
    try {
      const res = await fetch("/api/auth/switch-workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      if (!res.ok) {
        setSwitching(false);
        return;
      }
      // The session cookie changed; a full reload rescopes every cached query.
      window.location.href = "/";
    } catch {
      setSwitching(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Building2 className="size-4" aria-hidden />
        <span className="font-medium text-foreground" title={session.tenantId}>{tenantLabel}</span>
        <span aria-hidden>/</span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-foreground hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title="Switch use case"
              aria-label="Switch use case"
              data-testid="usecase-switcher"
            >
              {switching ? "Switching…" : currentLabel}
              <ChevronsUpDown className="size-3.5 opacity-60" aria-hidden />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              sideOffset={6}
              className="z-50 min-w-56 max-w-72 overflow-hidden rounded-md border bg-popover p-1 text-sm shadow-md"
            >
              <div className="px-2 py-1.5 text-xs font-medium uppercase text-muted-foreground">
                Use cases
              </div>
              <div className="max-h-72 overflow-y-auto">
                {workspaces.length === 0 && (
                  <div className="px-2 py-2 text-xs text-muted-foreground">
                    {query.isLoading ? "Loading…" : "No other use cases."}
                  </div>
                )}
                {workspaces.map((w) => {
                  const active = w.id === session.workspaceId;
                  return (
                    <DropdownMenu.Item
                      key={w.id}
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 outline-none data-[highlighted]:bg-accent"
                      onSelect={() => switchTo(w.id)}
                    >
                      <Layers className="size-3.5 opacity-60" aria-hidden />
                      <span className="flex-1 truncate">{w.name}</span>
                      {active && <Check className="size-3.5 text-primary" aria-hidden />}
                    </DropdownMenu.Item>
                  );
                })}
              </div>
              <Can gate={FEATURE_GATES.createWorkspace}>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Item
                  className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-primary outline-none data-[highlighted]:bg-accent"
                  onSelect={(e) => { e.preventDefault(); setCreating(true); }}
                >
                  <Plus className="size-3.5" aria-hidden /> New use case
                </DropdownMenu.Item>
              </Can>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      <NewUseCaseDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(w) => switchTo(w.id)}
      />
    </>
  );
}

function NewUseCaseDialog({
  open, onOpenChange, onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (w: Workspace) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = useCreateWorkspace();
  const error = create.error instanceof GraphQLRequestError ? create.error : null;

  const reset = () => { setName(""); setDescription(""); create.reset(); };
  const submit = () => {
    if (!name.trim()) return;
    create.mutate(
      { name: name.trim(), description: description.trim() || undefined, public: false },
      { onSuccess: (r) => { onOpenChange(false); reset(); onCreated(r.createWorkspace); } },
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-card p-5 shadow-lg focus:outline-none"
          aria-describedby={undefined}
        >
          <Dialog.Title className="text-lg font-semibold">New use case</Dialog.Title>
          <p className="mt-1 text-xs text-muted-foreground">
            A use case is a private space for one team&apos;s data, decisions, and dashboards.
            You&apos;ll switch into it once it&apos;s created.
          </p>
          <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <div className="space-y-1.5">
              <Label htmlFor="uc-name">Name</Label>
              <Input id="uc-name" value={name} autoFocus onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Card disputes Q3" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="uc-desc">Description (optional)</Label>
              <Input id="uc-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            {error && (
              <p role="alert" className="text-xs text-destructive" data-testid="mutation-error">
                {error.message}{error.traceId ? ` (trace: ${error.traceId})` : ""}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                {create.isPending ? "Creating…" : "Create & switch"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
