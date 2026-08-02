"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Bot, Download, ScrollText } from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { DataTable, type Column } from "@/components/primitives/DataTable";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { Badge, Input } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { AuthzExplainPanel } from "@/components/admin/AuthzExplainPanel";
import { AuditComplianceCard } from "@/components/admin/AuditComplianceCard";
import { useAuditEvents, useAuditAgentActivity, useAuditExportFile } from "@/lib/graphql/hooks";
import type { AuditEvent, AuditEventsFilter, AuditExportFormat } from "@/lib/graphql/types";
import { formatLocal } from "@/lib/utils";

/** RFC3339 for `n` days ago (audit enforces a 92-day max window). */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

export default function AdminAuditPage() {
  const [tab, setTab] = useState<"events" | "agents">("events");
  const [eventType, setEventType] = useState("");
  const [actorType, setActorType] = useState("");
  const [actorId, setActorId] = useState("");
  const [days, setDays] = useState(7);

  const filter: AuditEventsFilter = useMemo(
    () => ({
      from: daysAgo(days),
      // `to` omitted → BFF defaults to now.
      eventType: eventType || undefined,
      actorType: actorType || undefined,
      actorId: actorId.trim() || undefined,
    }),
    [days, eventType, actorType, actorId],
  );

  const query = useAuditEvents(filter);
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.nodes) ?? [], [query.data]);

  const columns: Column<AuditEvent>[] = [
    { id: "when", header: "When", width: 180, cell: (e) => <span className="whitespace-nowrap">{formatLocal(e.occurredAt)}</span> },
    {
      id: "type", header: "Event", width: 190,
      cell: (e) => (
        <Link href={`/admin/audit/events/${e.eventId}`} className="font-medium text-primary hover:underline">
          {e.eventType}
        </Link>
      ),
    },
    {
      id: "actor", header: "Actor", width: 200,
      cell: (e) => (
        <span className="flex items-center gap-1">
          {e.actorType && <Badge variant="secondary">{e.actorType}</Badge>}
          <span className="truncate font-mono text-xs">{e.actorId ?? "—"}</span>
        </span>
      ),
    },
    {
      id: "via", header: "Via agent", width: 140,
      cell: (e) => e.viaAgentId ? <span className="truncate font-mono text-xs">{e.viaAgentId}</span> : <span className="text-muted-foreground">—</span>,
    },
    { id: "action", header: "Action", width: 170, cell: (e) => e.action || <span className="text-muted-foreground">—</span> },
    { id: "resource", header: "Resource", cell: (e) => <span className="truncate font-mono text-xs">{e.resourceUrn ?? "—"}</span> },
    {
      id: "chain", header: "Seq", width: 80,
      cell: (e) => e.chainSeq != null ? <span className="font-mono text-xs">#{e.chainSeq}</span> : <span className="text-muted-foreground">—</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Audit search"
        description="The tamper-evident WORM compliance trail (audit-service, ClickHouse). Dual-attribution: agent actions carry the on-behalf-of user."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/audit/export">SIEM &amp; WORM exports</Link>
          </Button>
        }
      />

      <AuditComplianceCard />

      <div className="mb-4">
        <AuthzExplainPanel />
      </div>

      <div className="mb-3 flex items-center gap-1" role="tablist" aria-label="Audit view">
        <Button
          role="tab"
          aria-selected={tab === "events"}
          variant={tab === "events" ? "default" : "ghost"}
          size="sm"
          onClick={() => setTab("events")}
        >
          <ScrollText /> Events
        </Button>
        <Button
          role="tab"
          aria-selected={tab === "agents"}
          variant={tab === "agents" ? "default" : "ghost"}
          size="sm"
          onClick={() => setTab("agents")}
        >
          <Bot /> Agent activity
        </Button>
      </div>

      {tab === "agents" ? (
        <AgentActivityPanel columns={columns} days={days} />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Window</span>
              <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Time window"
                className="h-9 rounded-md border border-input bg-background px-2 text-sm">
                <option value={1}>Last 24h</option>
                <option value={7}>Last 7 days</option>
                <option value={30}>Last 30 days</option>
                <option value={90}>Last 90 days</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Actor type</span>
              <select value={actorType} onChange={(e) => setActorType(e.target.value)} aria-label="Actor type"
                className="h-9 rounded-md border border-input bg-background px-2 text-sm">
                <option value="">any</option>
                <option value="user">user</option>
                <option value="service">service</option>
                <option value="agent">agent</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Event type</span>
              <Input value={eventType} onChange={(e) => setEventType(e.target.value)} placeholder="e.g. agent_run" className="h-9 w-44" aria-label="Event type" />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Actor id</span>
              <Input value={actorId} onChange={(e) => setActorId(e.target.value)} placeholder="exact id" className="h-9 w-44" aria-label="Actor id" />
            </label>
            {(eventType || actorType || actorId) && (
              <Button variant="ghost" size="sm" onClick={() => { setEventType(""); setActorType(""); setActorId(""); }}>Clear</Button>
            )}
            <span className="ml-auto">
              <RawExportDownload filter={filter} />
            </span>
          </div>

          <AsyncBoundary
            isLoading={query.isLoading}
            isError={query.isError}
            error={query.error}
            isEmpty={rows.length === 0}
            emptyTitle="No audit events match these filters."
            onRetry={() => query.refetch()}
          >
            <DataTable
              ariaLabel="Audit events"
              rows={rows}
              columns={columns}
              rowId={(e) => e.eventId}
              hasMore={query.hasNextPage}
              isFetchingMore={query.isFetchingNextPage}
              onLoadMore={() => query.fetchNextPage()}
              emptyState={
                <div className="flex flex-col items-center gap-2 p-10 text-muted-foreground">
                  <ScrollText className="size-8" />
                  <p>No audit events in this window.</p>
                </div>
              }
            />
          </AsyncBoundary>
        </>
      )}
    </div>
  );
}

/** Raw CSV/NDJSON download of the current filters (audit-service GET
 * /audit/export via the BFF's auditExportFile descriptor). The link is the
 * same-origin /api/audit-export proxy — the file streams with the session JWT,
 * never through GraphQL. */
function RawExportDownload({ filter }: { filter: AuditEventsFilter }) {
  const [format, setFormat] = useState<AuditExportFormat>("CSV");
  const file = useAuditExportFile({ ...filter, format });
  return (
    <span className="flex items-end gap-2">
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Raw export</span>
        <select
          value={format} onChange={(e) => setFormat(e.target.value as AuditExportFormat)}
          aria-label="Raw export format"
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="CSV">CSV</option>
          <option value="NDJSON">NDJSON</option>
        </select>
      </label>
      {file.data ? (
        <Button size="sm" variant="outline" asChild>
          <a href={file.data.downloadPath}>
            <Download className="mr-1 size-3.5" aria-hidden />
            Download
          </a>
        </Button>
      ) : (
        <Button size="sm" variant="outline" disabled>
          <Download className="mr-1 size-3.5" aria-hidden />
          Download
        </Button>
      )}
    </span>
  );
}

/** Dual-attribution activity for one agent (audit-service GET
 * /audit/agent-activity): every row shows which agent acted (via) AND whose
 * authority it acted under (actor). Bounded at 200 rows, newest first. */
function AgentActivityPanel({ columns, days }: { columns: Column<AuditEvent>[]; days: number }) {
  const [agentId, setAgentId] = useState("");
  const [oboUserId, setOboUserId] = useState("");
  const [includeAutonomous, setIncludeAutonomous] = useState(false);

  const vars = useMemo(
    () => ({
      agentId: agentId.trim(),
      oboUserId: oboUserId.trim() || undefined,
      from: daysAgo(days),
      includeAutonomous,
    }),
    [agentId, oboUserId, days, includeAutonomous],
  );
  const query = useAuditAgentActivity(vars);
  const rows = query.data?.nodes ?? [];

  // Same table shape as the events tab, but lead with the dual attribution:
  // the agent (via) then the human principal (on behalf of).
  const activityColumns: Column<AuditEvent>[] = [
    columns[0], // When
    columns[1], // Event (deep link)
    {
      id: "agent", header: "Agent", width: 180,
      cell: (e) => (
        <span className="truncate font-mono text-xs">
          {e.viaAgentId ?? "—"}{e.viaAgentVersion ? `@${e.viaAgentVersion}` : ""}
        </span>
      ),
    },
    {
      id: "obo", header: "On behalf of", width: 200,
      cell: (e) =>
        e.actorType === "user" ? (
          <span className="truncate font-mono text-xs">{e.actorId}</span>
        ) : (
          <Badge variant="secondary">autonomous</Badge>
        ),
    },
    ...columns.slice(4), // Action, Resource, Seq
  ];

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Agent id</span>
          <Input value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="e.g. triage-bot" className="h-9 w-44" aria-label="Agent id" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">On-behalf-of user id (optional)</span>
          <Input value={oboUserId} onChange={(e) => setOboUserId(e.target.value)} placeholder="exact user id" className="h-9 w-44" aria-label="On-behalf-of user id" />
        </label>
        <label className="flex h-9 items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={includeAutonomous}
            onChange={(e) => setIncludeAutonomous(e.target.checked)}
            aria-label="Include autonomous actions"
          />
          <span className="text-muted-foreground">Include autonomous (no human principal)</span>
        </label>
      </div>

      {!vars.agentId ? (
        <div className="flex flex-col items-center gap-2 rounded-md border p-10 text-muted-foreground">
          <Bot className="size-8" />
          <p>Enter an agent id to see everything it did — and on whose behalf.</p>
        </div>
      ) : (
        <AsyncBoundary
          isLoading={query.isLoading}
          isError={query.isError}
          error={query.error}
          isEmpty={rows.length === 0}
          emptyTitle="No activity for this agent in the window."
          onRetry={() => query.refetch()}
        >
          <DataTable
            ariaLabel="Agent activity"
            rows={rows}
            columns={activityColumns}
            rowId={(e) => e.eventId}
            emptyState={
              <div className="flex flex-col items-center gap-2 p-10 text-muted-foreground">
                <Bot className="size-8" />
                <p>No activity for this agent in the window.</p>
              </div>
            }
          />
        </AsyncBoundary>
      )}
    </>
  );
}
