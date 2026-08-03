"use client";
import { Plus, Trash2 } from "lucide-react";
import { Input, Label } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { useDatasets, flatten, useOntologyEntities } from "@/lib/graphql/hooks";
import { newEntity } from "@/lib/semantic/definition";
import type { SemanticDefinitionDoc } from "@/lib/graphql/types";
import type { OntologyEntity } from "@/lib/graphql/operations";
import { t } from "@/lib/i18n/messages";

const SELECT_CLS = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

/** wr:<tenant>:dataset:dataset/<id> -> the dataset id, for binding an entity's
 * dataset_urn from a picked dataset row. */
function urnFor(datasetId: string, sampleUrn: string | undefined): string {
  if (!sampleUrn) return "";
  const prefix = sampleUrn.slice(0, sampleUrn.lastIndexOf("/") + 1);
  return `${prefix}${datasetId}`;
}

export function EntitiesSection({
  doc,
  onChange,
  columnsByEntity,
  errors,
  readOnly,
}: {
  doc: SemanticDefinitionDoc;
  onChange: (doc: SemanticDefinitionDoc) => void;
  /** Real dataset columns keyed by entity name (from DefinitionEditor) — the
   * ontology attribute-map picker binds to these, never free text. */
  columnsByEntity?: Record<string, { name: string }[]>;
  errors: Map<string, string[]>;
  readOnly: boolean;
}) {
  const datasetsQuery = useDatasets();
  const datasets = flatten(datasetsQuery.data?.pages ?? []);
  // WS2: the workspace's governed domain types, so an entity can declare which
  // ontology type it instantiates (existence-validated again at submit).
  const ontologyQuery = useOntologyEntities();
  const ontologyTypes = ontologyQuery.data ?? [];

  const update = (i: number, patch: Partial<SemanticDefinitionDoc["entities"][number]>) => {
    const entities = doc.entities.map((e, idx) => (idx === i ? { ...e, ...patch } : e));
    onChange({ ...doc, entities });
  };
  const remove = (i: number) => onChange({ ...doc, entities: doc.entities.filter((_, idx) => idx !== i) });
  const add = () => onChange({ ...doc, entities: [...doc.entities, newEntity()] });

  return (
    <fieldset className="space-y-3" disabled={readOnly}>
      <div className="flex items-center justify-between">
        <legend className="text-sm font-semibold">{t("semantic.entities")}</legend>
        {!readOnly && (
          <Button type="button" variant="outline" size="sm" onClick={add}>
            <Plus /> {t("semantic.entity.add")}
          </Button>
        )}
      </div>

      {doc.entities.length === 0 && <p className="text-xs text-muted-foreground">{t("semantic.entity.none")}</p>}

      <div className="space-y-3">
        {doc.entities.map((entity, i) => {
          const rowErrors = errors.get(`entity/${entity.name}`) ?? [];
          const datasetId = entity.dataset_urn ? entity.dataset_urn.slice(entity.dataset_urn.lastIndexOf("/") + 1) : "";
          return (
            <div key={i} className="space-y-2 rounded-md border p-3" data-testid={`entity-row-${i}`}>
              <div className="grid gap-2 md:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={`entity-name-${i}`}>{t("semantic.entity.name")}</Label>
                  <Input
                    id={`entity-name-${i}`}
                    value={entity.name}
                    onChange={(e) => update(i, { name: e.target.value })}
                    placeholder="claims"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`entity-dataset-${i}`}>{t("semantic.entity.dataset")}</Label>
                  <select
                    id={`entity-dataset-${i}`}
                    className={SELECT_CLS}
                    value={datasetId}
                    onChange={(e) => {
                      const ds = datasets.find((d) => d.id === e.target.value);
                      if (!ds) return;
                      update(i, {
                        dataset_urn: urnFor(ds.id, ds.urn),
                        table: entity.table || `main.${ds.name.toLowerCase().replace(/[^a-z0-9_]+/g, "_")}`,
                      });
                    }}
                  >
                    <option value="">{t("semantic.entity.pickDataset")}</option>
                    {datasets.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`entity-table-${i}`}>{t("semantic.entity.table")}</Label>
                  <Input
                    id={`entity-table-${i}`}
                    value={entity.table}
                    onChange={(e) => update(i, { table: e.target.value })}
                    placeholder="main.claims"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`entity-pk-${i}`}>{t("semantic.entity.primaryKey")}</Label>
                  <Input
                    id={`entity-pk-${i}`}
                    value={entity.primary_key.join(",")}
                    onChange={(e) =>
                      update(i, { primary_key: e.target.value.split(",").map((c) => c.trim()).filter(Boolean) })
                    }
                    placeholder="claim_id"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`entity-ontology-${i}`}>{t("semantic.entity.ontologyType")}</Label>
                  <select
                    id={`entity-ontology-${i}`}
                    className={SELECT_CLS}
                    value={entity.ontology_entity_key ?? ""}
                    onChange={(e) =>
                      // Clearing drops the key AND the map entirely
                      // (JSON.stringify strips undefined), so an unlinked
                      // entity stays exactly as before.
                      update(i, {
                        ontology_entity_key: e.target.value || undefined,
                        ontology_attribute_map: undefined,
                      })
                    }
                  >
                    <option value="">{t("semantic.entity.noOntologyType")}</option>
                    {ontologyTypes.map((o) => (
                      <option key={o.entityKey} value={o.entityKey}>
                        {o.name} ({o.entityKey})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <AttributeMapEditor
                entity={entity}
                ontologyType={ontologyTypes.find((o) => o.entityKey === entity.ontology_entity_key)}
                columns={columnsByEntity?.[entity.name] ?? []}
                onMapChange={(map) => update(i, { ontology_attribute_map: map })}
              />
              {rowErrors.length > 0 && (
                <ul className="space-y-0.5 text-xs text-destructive" role="alert">
                  {rowErrors.map((e, ei) => (
                    <li key={ei}>{e}</li>
                  ))}
                </ul>
              )}
              {!readOnly && (
                <div className="flex justify-end">
                  <Button type="button" variant="ghost" size="sm" onClick={() => remove(i)}>
                    <Trash2 /> {t("semantic.entity.remove")}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

/** WS2 remainder: the explicit ontology-attribute -> dataset-column map for one
 * entity. Rendered only when the entity declares an ontology type that carries
 * attributes; each attribute gets a picker over the entity's REAL dataset
 * columns. "Not mapped" removes the attribute from the map, and an empty map is
 * dropped entirely so an unmapped entity stays byte-identical. Both sides are
 * re-validated at submit (attributes vs registry, columns vs schema). */
function AttributeMapEditor({
  entity,
  ontologyType,
  columns,
  onMapChange,
}: {
  entity: SemanticDefinitionDoc["entities"][number];
  ontologyType: OntologyEntity | undefined;
  columns: { name: string }[];
  onMapChange: (map: Record<string, string> | undefined) => void;
}) {
  const attributes = ontologyType?.attributes ?? [];
  if (!entity.ontology_entity_key || attributes.length === 0) return null;

  const map = entity.ontology_attribute_map ?? {};
  const setAttr = (attr: string, col: string) => {
    const next = { ...map };
    if (col) next[attr] = col;
    else delete next[attr];
    onMapChange(Object.keys(next).length > 0 ? next : undefined);
  };

  return (
    <div className="space-y-1.5 rounded-md border border-border/50 p-2">
      <p className="text-xs font-medium">{t("semantic.entity.attributeMap")}</p>
      <p className="text-xs text-muted-foreground">{t("semantic.entity.attributeMapHint")}</p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {attributes.map((a) => (
          <div key={a.name} className="flex items-center gap-2">
            <code
              className="w-28 shrink-0 truncate text-xs"
              // WS4: a required attribute MUST be mapped — submit enforces it.
              title={a.required ? `${a.name} (required — must be mapped)` : a.name}
            >
              {a.name}
              {a.required && <span className="text-destructive" aria-label="required">*</span>}
            </code>
            <select
              aria-label={`Map attribute ${a.name}`}
              className={SELECT_CLS}
              value={map[a.name] ?? ""}
              onChange={(e) => setAttr(a.name, e.target.value)}
            >
              <option value="">{t("semantic.entity.unmapped")}</option>
              {columns.map((c) => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}
