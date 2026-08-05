"use client";
import { X } from "lucide-react";
import { useMemo } from "react";
import { useCanvasStore, resolveInputDatasetId } from "@/lib/pipelines/canvas";
import { collect } from "@/lib/pipelines/form";
import { propagateSchema } from "@/lib/pipelines/schema-propagation";
import { SchemaField } from "@/components/forms/SchemaField";
import { ResourceFields } from "@/components/pipelines/ResourceFields";
import { Button } from "@/components/ui/button";
import { useDatasetSchema, usePipelineResourcePolicy } from "@/lib/graphql/hooks";
import { t } from "@/lib/i18n/messages";

/**
 * Right-hand config drawer for the selected node: renders the step's parameter
 * schema with the shared SchemaField renderer and live-validates on change
 * (errors come from the same collect() used at save/serialize time).
 */
export function NodeConfigPanel() {
  const selectedId = useCanvasStore((s) => s.selectedId);
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === s.selectedId));
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const issues = useCanvasStore((s) => (s.selectedId ? s.issues[s.selectedId] : undefined));
  const effectiveResources = useCanvasStore((s) => s.effectiveResources);
  const aliasOf = useCanvasStore((s) => s.aliasOf);
  const setValue = useCanvasStore((s) => s.setValue);
  const setResource = useCanvasStore((s) => s.setResource);
  const selectNode = useCanvasStore((s) => s.selectNode);

  // Data-binding: the columns of the dataset feeding the pipeline (its read
  // node's chosen dataset). Degrades to [] when no dataset is chosen yet (the
  // widgets fall back then).
  const datasetId = resolveInputDatasetId(nodes);
  const { data: schema } = useDatasetSchema(datasetId, undefined, { enabled: !!datasetId });
  const sourceColumns = useMemo(() => (schema ?? []).map((c) => c.name), [schema]);

  // BRD 71 (U2): bind to the columns THIS node will see, not the source dataset's.
  // After a select-columns / rename-columns / join-data the two differ, and offering
  // the source list produces choices that fail later at validate or run time.
  const propagated = useMemo(
    () => propagateSchema(nodes, edges, sourceColumns),
    [nodes, edges, sourceColumns],
  );
  const availableColumns = (selectedId ? propagated.seen.get(selectedId) : undefined) ?? [];
  const propagationError = selectedId ? propagated.errors.get(selectedId) : undefined;

  const { data: policy } = usePipelineResourcePolicy();

  if (!selectedId || !node) return null;

  const { errors } = collect(node.params, node.values);

  return (
    <aside
      data-testid="node-config-panel"
      aria-label={t("pipelines.configureStep", { name: node.displayName })}
      className="flex h-full w-80 shrink-0 flex-col border-l bg-card"
    >
      <div className="flex items-center justify-between gap-2 border-b p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{node.displayName}</p>
          <p className="truncate text-xs text-muted-foreground">{node.component}</p>
        </div>
        <Button variant="ghost" size="icon" aria-label={t("action.cancel")} onClick={() => selectNode(null)}>
          <X />
        </Button>
      </div>

      <div className="flex-1 space-y-4 overflow-auto p-3">
        {propagationError ? (
          <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs text-destructive">
            {t("pipelines.propagationFailed")}
          </p>
        ) : null}
        {issues?.length ? (
          <ul className="space-y-1 rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs text-destructive">
            {issues.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        ) : null}

        {node.params.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("pipelines.noParams")}</p>
        ) : (
          node.params.map((p) => (
            <SchemaField
              key={p.name}
              param={p}
              value={node.values[p.name]}
              error={errors[p.name]}
              availableColumns={availableColumns}
              onChange={(v) => setValue(node.id, p.name, v)}
            />
          ))
        )}

        <ResourceFields
          node={node}
          policy={policy}
          effective={effectiveResources?.[aliasOf(node.id)]}
          onChange={(key, value) => setResource(node.id, key, value)}
        />
      </div>

      <div className="border-t p-3 text-xs text-muted-foreground">
        {t("pipelines.portsSummary", { inputs: node.inputs.length, outputs: node.outputs.length })}
      </div>
    </aside>
  );
}
