"use client";
import { use } from "react";
import Link from "next/link";
import { ArrowLeft, ScrollText } from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { Card, CardHeader, CardTitle, CardDescription, Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { useAuditEvent } from "@/lib/graphql/hooks";
import { formatLocal } from "@/lib/utils";

/**
 * Deep link to ONE audit event (audit-service GET /audit/events/{event_id})
 * with its immutable hash-chain position. `sealed` means the event's chain-day
 * has been sealed by the daily WORM export, so the record is verifiable
 * against its Object-Lock manifest. A cross-tenant or unknown id renders the
 * same not-found state — the downstream 404s both identically.
 */
export default function AuditEventPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = use(params);
  const query = useAuditEvent(eventId);
  const detail = query.data ?? null;
  const e = detail?.event;

  return (
    <div>
      <PageHeader
        title="Audit event"
        description="One WORM trail record with its tamper-evident chain position."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/audit"><ArrowLeft className="mr-1 size-3.5" aria-hidden /> Audit search</Link>
          </Button>
        }
      />

      <AsyncBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        isEmpty={!query.isLoading && !detail}
        emptyTitle="Event not found (or it belongs to another tenant)."
        onRetry={() => query.refetch()}
      >
        {e && detail && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span className="flex items-center gap-2"><ScrollText className="size-4" aria-hidden />{e.eventType}</span>
                  <Badge variant={detail.sealed ? "success" : "warning"}>
                    {detail.sealed ? "sealed" : "not sealed yet"}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  {detail.sealed
                    ? "This record's chain-day is sealed — it is verifiable against its WORM (Object-Lock) manifest."
                    : "This record's chain-day has not been sealed by the daily WORM export yet."}
                </CardDescription>
              </CardHeader>
              <div className="space-y-2 px-4 pb-4 text-sm">
                <DetailRow label="Event id" value={e.eventId} mono />
                <DetailRow label="Occurred" value={formatLocal(e.occurredAt)} />
                {e.ingestedAt && <DetailRow label="Ingested" value={formatLocal(e.ingestedAt)} />}
                <DetailRow label="Actor" value={`${e.actorType ?? "—"} / ${e.actorId ?? "—"}`} mono />
                {e.viaAgentId && (
                  <DetailRow
                    label="Via agent"
                    value={`${e.viaAgentId}${e.viaAgentVersion ? `@${e.viaAgentVersion}` : ""}`}
                    mono
                  />
                )}
                <DetailRow label="Action" value={e.action ?? "—"} />
                <DetailRow label="Resource" value={e.resourceUrn ?? "—"} mono />
                {e.traceId && <DetailRow label="Trace id" value={e.traceId} mono />}
              </div>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Chain position</CardTitle>
                <CardDescription>Immutable hash-chain coordinates for this record.</CardDescription>
              </CardHeader>
              <div className="space-y-2 px-4 pb-4 text-sm">
                <DetailRow label="Chain day" value={detail.chainDate} mono />
                <DetailRow label="Sequence" value={`#${detail.chainSeq}`} mono />
                {e.chainHash && <DetailRow label="Chain hash" value={e.chainHash} mono />}
                {e.payloadDigest && <DetailRow label="Payload digest" value={e.payloadDigest} mono />}
              </div>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Payload</CardTitle>
                <CardDescription>
                  {e.bodyWithheld
                    ? "The payload body was withheld at ingest (PII policy) — only its digest is retained."
                    : "The event payload as recorded in the trail."}
                </CardDescription>
              </CardHeader>
              <div className="px-4 pb-4">
                {e.bodyWithheld || e.payload == null ? (
                  <p className="text-sm text-muted-foreground">Body withheld.</p>
                ) : (
                  <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                    {JSON.stringify(e.payload, null, 2)}
                  </pre>
                )}
              </div>
            </Card>
          </div>
        )}
      </AsyncBoundary>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "truncate font-mono text-xs" : "font-medium"}>{value}</span>
    </div>
  );
}
