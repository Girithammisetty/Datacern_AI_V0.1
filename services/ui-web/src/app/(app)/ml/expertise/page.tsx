"use client";
import { BookMarked, Cpu, Download, Scale, ScrollText } from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/primitives";
import { useExpertiseLedger } from "@/lib/graphql/hooks";
import type { ExpertiseLedgerResult } from "@/lib/graphql/operations";
import { formatLocal } from "@/lib/utils";
import { t } from "@/lib/i18n/messages";

/**
 * Expertise Ledger (governed-decision flywheel, made visible): how much expert
 * judgment has been captured as governed decisions, how well the owned model
 * agrees with the experts, the size/provenance of the training corpus those
 * decisions produced, and the state of the model the tenant owns.
 *
 * The whole POINT of this surface is that it never lies:
 *  - agreementRate / effectivenessRate are Float-OR-null; null renders as an
 *    explicit "Not enough data yet" state, NEVER as 0% or 0.
 *  - corpus.latest / ownedModel.promoted / ownedModel.latestTraining are
 *    nullable; when no model is owned we say so, and a failed training run's
 *    error reason (e.g. {reason:"gpu_trainer_not_configured"}) is surfaced
 *    VERBATIM rather than softened into a fake "ready".
 *  - counts are exact and rendered as-is.
 */

type Ledger = ExpertiseLedgerResult["expertiseLedger"];

const WINDOW_DAYS = 90;

/** A rate is Float-or-null. null is the honest "not enough comparable outcomes
 * yet" — callers render it as an explicit state, never 0%. */
function formatRate(rate: number | null): string | null {
  if (rate == null || Number.isNaN(rate)) return null;
  return `${Math.round(rate * 100)}%`;
}

/** The verbatim downstream failure reason (never softened / hidden). */
function errorText(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function StatTile({
  value,
  label,
  hint,
}: {
  value: React.ReactNode;
  label: string;
  hint?: string;
}) {
  return (
    <div>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Hero row: the four numbers that make the flywheel legible at a glance. */
function HeroStats({ data }: { data: Ledger }) {
  const { decisions, agreement, corpus } = data;
  const rate = formatRate(agreement.agreementRate);
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatTile
        value={decisions.capturedAllTime.toLocaleString()}
        label={t("expertise.tile.decisions")}
        hint={t("expertise.tile.decisionsWindow", {
          n: decisions.capturedInWindow.toLocaleString(),
          days: decisions.windowDays,
        })}
      />
      <StatTile
        value={decisions.correctionsInWindow.toLocaleString()}
        label={t("expertise.tile.corrections")}
        hint={t("expertise.tile.correctionsHint")}
      />
      <StatTile
        value={
          rate ?? (
            <span className="text-base font-semibold text-muted-foreground">
              {t("expertise.notEnoughData")}
            </span>
          )
        }
        label={t("expertise.tile.agreement")}
        hint={t("expertise.tile.agreementHint", { n: agreement.scored.toLocaleString() })}
      />
      <StatTile
        value={corpus.exampleRows.toLocaleString()}
        label={t("expertise.tile.corpus")}
        hint={t("expertise.tile.corpusHint", { n: corpus.datasetVersions.toLocaleString() })}
      />
    </div>
  );
}

/** The model the tenant OWNS — an honest ownership state, never a fabricated
 * "ready". Export training data is the ownership gesture; wired disabled with a
 * reason because no SFT-export operation exists in the BFF yet. */
function OwnedModelCard({ data }: { data: Ledger }) {
  const { ownedModel } = data;
  const promoted = ownedModel.promoted;
  const training = ownedModel.latestTraining;
  const trainingFailed = training?.status === "failed";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Cpu className="size-4 text-muted-foreground" aria-hidden />
          {t("expertise.model.title")}
          {ownedModel.hasOwnedModel && (
            <Badge variant="success" className="ml-1">{t("expertise.model.owned")}</Badge>
          )}
        </CardTitle>
        <CardDescription>{t("expertise.model.noneHint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {ownedModel.hasOwnedModel && promoted ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">{t("expertise.model.archetype")}</dt>
              <dd className="font-mono text-xs">{promoted.archetype ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("expertise.model.baseModel")}</dt>
              <dd className="font-mono text-xs">{promoted.baseModel ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("expertise.model.alias")}</dt>
              <dd className="font-mono text-xs">{promoted.modelAlias ?? "—"}</dd>
            </div>
            <div className="col-span-2 sm:col-span-3">
              <dt className="text-xs text-muted-foreground">{t("expertise.model.checksum")}</dt>
              <dd className="break-all font-mono text-xs">{promoted.checksum ?? "—"}</dd>
            </div>
          </dl>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t("expertise.model.none")}</p>
            {trainingFailed && (
              <div
                role="alert"
                className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3"
              >
                <p className="text-xs font-semibold text-destructive">
                  {t("expertise.model.trainingFailed")}
                </p>
                <p className="break-all font-mono text-xs text-destructive">{errorText(training?.error)}</p>
              </div>
            )}
          </div>
        )}

        {/* Ownership gesture. No SFT-export operation exists in the BFF, so this
            is disabled-with-reason rather than faked. */}
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled
            title={t("expertise.model.exportUnavailable")}
          >
            <Download className="size-4" /> {t("expertise.model.exportData")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** The provenance of the training corpus those decisions produced. */
function CorpusCard({ data }: { data: Ledger }) {
  const latest = data.corpus.latest;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ScrollText className="size-4 text-muted-foreground" aria-hidden />
          {t("expertise.corpus.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {latest ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">{t("expertise.corpus.archetype")}</dt>
              <dd className="font-mono text-xs">{latest.agentKey ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("expertise.corpus.version")}</dt>
              <dd>v{latest.version ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("expertise.corpus.rows")}</dt>
              <dd className="tabular-nums">{latest.rowCount?.toLocaleString() ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("expertise.corpus.consent")}</dt>
              <dd>
                {data.corpus.consentVerifiedVersions} / {data.corpus.datasetVersions}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("expertise.corpus.built")}</dt>
              <dd>{formatLocal(latest.createdAt)}</dd>
            </div>
            <div className="col-span-2 sm:col-span-3">
              <dt className="text-xs text-muted-foreground">{t("expertise.model.checksum")}</dt>
              <dd className="break-all font-mono text-xs">{latest.checksum ?? "—"}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{t("expertise.model.noneHint")}</p>
        )}
      </CardContent>
    </Card>
  );
}

/** Real per-status counts of the governed decisions. */
function DecisionBreakdownCard({ data }: { data: Ledger }) {
  const s = data.decisions.byStatus;
  const rows: { label: string; value: number }[] = [
    { label: t("expertise.breakdown.approved"), value: s.approved },
    { label: t("expertise.breakdown.edited"), value: s.editedApproved },
    { label: t("expertise.breakdown.rejected"), value: s.rejected },
    { label: t("expertise.breakdown.pending"), value: s.pending },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("expertise.breakdown.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          {rows.map((r) => (
            <div key={r.label}>
              <dt className="text-xs text-muted-foreground">{r.label}</dt>
              <dd className="text-xl font-bold tabular-nums">{r.value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

/** Model-vs-expert agreement, per decision type. effectivenessRate is
 * Float-or-null: null renders "—" (not enough comparable outcomes), never 0%. */
function AgreementByTypeCard({ data }: { data: Ledger }) {
  const rows = data.agreement.byDecisionType;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Scale className="size-4 text-muted-foreground" aria-hidden />
          {t("expertise.agreement.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("expertise.agreement.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{t("expertise.agreement.type")}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t("expertise.agreement.total")}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t("expertise.agreement.correct")}</th>
                  <th className="py-2 text-right font-medium">{t("expertise.agreement.rate")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const rate = formatRate(r.effectivenessRate);
                  return (
                    <tr key={r.key} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-mono text-xs">{r.key}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{r.total.toLocaleString()}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{r.correct.toLocaleString()}</td>
                      <td className="py-2 text-right tabular-nums">
                        {rate ?? <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LedgerBody({ data }: { data: Ledger }) {
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6">
          <HeroStats data={data} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <OwnedModelCard data={data} />
        <CorpusCard data={data} />
      </div>

      <DecisionBreakdownCard data={data} />
      <AgreementByTypeCard data={data} />
    </div>
  );
}

export default function ExpertiseLedgerPage() {
  const q = useExpertiseLedger(WINDOW_DAYS);
  const data = q.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("expertise.title")}
        description={t("expertise.subtitle")}
        actions={<BookMarked className="size-5 text-muted-foreground" aria-hidden />}
      />
      <AsyncBoundary
        isLoading={q.isLoading}
        isError={q.isError}
        error={q.error}
        isEmpty={!!data && data.decisions.capturedAllTime === 0}
        emptyTitle={t("expertise.empty")}
        onRetry={() => q.refetch()}
      >
        {data && <LedgerBody data={data} />}
      </AsyncBoundary>
    </div>
  );
}
