"use client";
import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Label, Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { useImportDashboard } from "@/lib/graphql/hooks";
import { GraphQLRequestError } from "@/lib/graphql/client";

/**
 * Import-dashboard flow (chart-service POST /dashboards/import, CHART-FR-005):
 * paste a bundle produced by "Export bundle" plus an optional URN mapping that
 * rewrites the bundle's source URNs onto this tenant's resources. An unmapped
 * URN fails atomically downstream (422 UNMAPPED_URN with the offending URNs in
 * details) — surfaced verbatim, nothing is created. The target workspace comes
 * from the caller's JWT claim server-side.
 */
export function ImportDashboardDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onImported: (dashboardId: string) => void;
}) {
  const [bundleText, setBundleText] = useState("");
  const [mappingText, setMappingText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const importMutation = useImportDashboard();

  useEffect(() => {
    if (open) {
      setBundleText("");
      setMappingText("");
      setParseError(null);
      importMutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = () => {
    setParseError(null);
    let bundle: unknown;
    let urnMapping: unknown;
    try {
      bundle = JSON.parse(bundleText);
    } catch {
      setParseError("Bundle is not valid JSON.");
      return;
    }
    if (mappingText.trim()) {
      try {
        urnMapping = JSON.parse(mappingText);
      } catch {
        setParseError("URN mapping is not valid JSON.");
        return;
      }
    }
    importMutation.mutate(
      { bundle: bundle as never, urnMapping: urnMapping as never },
      { onSuccess: (r) => onImported(r.dashboardId) },
    );
  };

  const error = importMutation.error instanceof GraphQLRequestError ? importMutation.error : null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-card p-5 shadow-lg focus:outline-none"
          aria-describedby={undefined}
        >
          <Dialog.Title className="text-lg font-semibold">Import dashboard</Dialog.Title>
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="import-bundle">Bundle JSON</Label>
              <Textarea
                id="import-bundle"
                rows={8}
                className="font-mono text-xs"
                value={bundleText}
                onChange={(e) => setBundleText(e.target.value)}
                placeholder='{"dashboard": {…}, "charts": […]}'
                spellCheck={false}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="import-mapping">URN mapping (optional)</Label>
              <Textarea
                id="import-mapping"
                rows={3}
                className="font-mono text-xs"
                value={mappingText}
                onChange={(e) => setMappingText(e.target.value)}
                placeholder='{"wr:…:query:query/old-id": "wr:…:query:query/new-id"}'
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                Maps the bundle&apos;s source URNs to this tenant&apos;s. Unmapped URNs fail the
                import atomically — nothing is created.
              </p>
            </div>
            {parseError && <p className="text-xs text-destructive">{parseError}</p>}
            {error && (
              <p role="alert" className="text-xs text-destructive" data-testid="mutation-error">
                {error.message}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!bundleText.trim() || importMutation.isPending}>
                {importMutation.isPending ? "Importing…" : "Import"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
