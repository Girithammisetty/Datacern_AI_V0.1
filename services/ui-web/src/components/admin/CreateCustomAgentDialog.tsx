"use client";
import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Input, Label, Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { useCreateCustomAgent, useTools, useWorkspaces, useRoles } from "@/lib/graphql/hooks";
import { GraphQLRequestError } from "@/lib/graphql/client";

/**
 * BRD 53 inc2b — author a tenant custom agent as governed configuration + its
 * guardrail envelope (inc2). The agent runs on the shared, platform-owned safe
 * graph; the tenant supplies intent (persona, prompt, one propose tool) and
 * constraints (allow-listed tools, data scope, budget, PII posture). The server
 * validates + clamps everything; this form just makes the envelope easy to author.
 */
export function CreateCustomAgentDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (agentKey: string) => void;
}) {
  const create = useCreateCustomAgent();
  const toolsQ = useTools();
  const workspacesQ = useWorkspaces();
  const rolesQ = useRoles();

  const tools = useMemo(() => toolsQ.data?.pages.flatMap((p) => p.nodes) ?? [], [toolsQ.data]);
  const workspaces = useMemo(
    () => (workspacesQ.data?.pages.flatMap((p) => p.nodes) ?? []).filter((w) => !w.archived),
    [workspacesQ.data],
  );
  const roles = useMemo(() => rolesQ.data?.pages.flatMap((p) => p.nodes) ?? [], [rolesQ.data]);

  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [allowed, setAllowed] = useState<Set<string>>(new Set());
  const [proposeTool, setProposeTool] = useState("");
  const [scopeWs, setScopeWs] = useState<Set<string>>(new Set());
  const [budget, setBudget] = useState("");
  const [blockPii, setBlockPii] = useState(false);
  const [redactPii, setRedactPii] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(""); setPersona(""); setSystemPrompt(""); setAllowed(new Set());
      setProposeTool(""); setScopeWs(new Set()); setBudget("");
      setBlockPii(false); setRedactPii(false); setBanner(null);
    }
  }, [open]);

  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>) => (id: string) =>
    set((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // A propose tool must be one the agent is allowed to call.
  const allowedList = useMemo(() => [...allowed], [allowed]);
  const proposeChoices = allowedList;

  const submit = () => {
    setBanner(null);
    if (!name.trim()) return setBanner("A name is required.");
    if (!persona) return setBanner("Pick the role (persona) this agent serves.");
    if (allowed.size === 0) return setBanner("Allow at least one tool the agent may use.");
    const budgetNum = budget.trim() ? Number(budget) : undefined;
    if (budgetNum !== undefined && (!Number.isInteger(budgetNum) || budgetNum < 128)) {
      return setBanner("Token budget must be a whole number of at least 128.");
    }
    create.mutate(
      {
        displayName: name.trim(),
        persona,
        systemPrompt: systemPrompt.trim() || undefined,
        allowedTools: allowedList,
        proposeTool: proposeTool || undefined,
        dataScopeWorkspaces: scopeWs.size > 0 ? [...scopeWs] : undefined,
        budgetMaxTokensPerSession: budgetNum,
        blockPiiEgress: blockPii || undefined,
        redactPii: redactPii || undefined,
      },
      { onSuccess: (r) => onCreated(r.agentKey) },
    );
  };

  const error = create.error instanceof GraphQLRequestError ? create.error : null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border bg-card p-5 shadow-lg focus:outline-none"
          aria-describedby={undefined}
        >
          <Dialog.Title className="text-lg font-semibold">New custom agent</Dialog.Title>
          <p className="mt-1 text-xs text-muted-foreground">
            Runs on the platform&apos;s safe, governed graph. It can only ever propose changes for a
            human to approve — never act on its own.
          </p>
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="ca-name">Name</Label>
              <Input id="ca-name" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Reg E Disposition Copilot" autoFocus />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ca-persona">Serves the role</Label>
              <select id="ca-persona" aria-label="persona"
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={persona} onChange={(e) => setPersona(e.target.value)}>
                <option value="">Select a role…</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.name}>{r.name}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ca-prompt">Instructions (optional)</Label>
              <Textarea id="ca-prompt" value={systemPrompt} rows={3}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="How should this copilot reason? e.g. Prioritise Reg E deadlines; be conservative." />
            </div>

            <fieldset className="space-y-2 rounded-md border p-3">
              <legend className="px-1 text-xs font-medium text-muted-foreground">Tools it may use</legend>
              <div className="max-h-32 space-y-1 overflow-y-auto">
                {tools.length === 0 && <p className="text-xs text-muted-foreground">No tools available.</p>}
                {tools.map((tool) => (
                  <label key={tool.toolId} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="size-4"
                      aria-label={tool.toolId}
                      checked={allowed.has(tool.toolId)}
                      onChange={() => toggle(setAllowed)(tool.toolId)} />
                    <span>{tool.displayName || tool.toolId}</span>
                  </label>
                ))}
              </div>
              <div className="space-y-1.5 pt-1">
                <Label htmlFor="ca-propose">Tool it may propose (optional)</Label>
                <select id="ca-propose" aria-label="propose tool"
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={proposeTool} onChange={(e) => setProposeTool(e.target.value)}>
                  <option value="">Advisory only (no proposals)</option>
                  {proposeChoices.map((tid) => (
                    <option key={tid} value={tid}>{tid}</option>
                  ))}
                </select>
              </div>
            </fieldset>

            <fieldset className="space-y-3 rounded-md border p-3">
              <legend className="px-1 text-xs font-medium text-muted-foreground">Guardrails</legend>

              <div className="space-y-1.5">
                <Label>Data it may read</Label>
                <p className="text-xs text-muted-foreground">
                  Leave all unchecked to allow every use case the role can see; check specific ones to
                  restrict this agent further.
                </p>
                <div className="max-h-28 space-y-1 overflow-y-auto">
                  {workspaces.map((w) => (
                    <label key={w.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" className="size-4"
                        aria-label={w.name}
                        checked={scopeWs.has(w.id)}
                        onChange={() => toggle(setScopeWs)(w.id)} />
                      <span>{w.name}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ca-budget">Token budget per session (optional)</Label>
                <Input id="ca-budget" type="number" min={128} value={budget}
                  onChange={(e) => setBudget(e.target.value)} placeholder="e.g. 20000" className="w-40" />
              </div>

              <div className="space-y-1.5">
                <Label>Sensitive data (PII)</Label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4" checked={blockPii}
                    onChange={(e) => setBlockPii(e.target.checked)} />
                  <span>Remove personal identifiers from what this agent writes</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4" checked={redactPii}
                    onChange={(e) => setRedactPii(e.target.checked)} />
                  <span>Also redact them from its answers</span>
                </label>
              </div>
            </fieldset>

            {banner && <p className="text-xs text-muted-foreground">{banner}</p>}
            {error && (
              <p role="alert" className="text-xs text-destructive" data-testid="mutation-error">
                {error.message}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? "Creating…" : "Create agent"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
