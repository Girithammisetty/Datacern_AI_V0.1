import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { BatchRunTimeline, phaseStates } from "./BatchRunTimeline";
import type { BatchJobRun } from "@/lib/graphql/types";

const BASE: BatchJobRun = {
  id: "bjr-1",
  urn: "wr:t-42:pipeline:batch-job-run/bjr-1",
  batchJobId: "bj-1",
  batchKey: "bjr-1",
  pipelineTemplateId: "tpl-1",
  pipelineVersionId: "ver-3",
  phase: "pipeline",
  status: "succeeded",
  trigger: "schedule",
  pipelineRunId: "run-7",
  inputDatasetUrns: ["wr:t-42:dataset:version/claims@v12"],
  outputDatasetUrns: ["wr:t-42:dataset:dataset/claims_scored"],
  error: null,
  phaseDeadlineAt: null,
  retriedFromRunId: null,
  submittedBy: "u-1",
  createdAt: "2026-08-05T02:00:00Z",
  startedAt: "2026-08-05T02:00:01Z",
  finishedAt: "2026-08-05T02:20:00Z",
  ingestions: [],
};

describe("phaseStates (projection of the run's phase + status)", () => {
  it("a succeeded run cleared every phase", () => {
    expect(phaseStates("pipeline", "succeeded")).toEqual({
      trigger: "succeeded", ingestion: "succeeded", pipeline: "succeeded",
    });
  });

  it("a run that failed IN ingestion never reached the pipeline phase", () => {
    expect(phaseStates("ingestion", "failed")).toEqual({
      trigger: "succeeded", ingestion: "failed", pipeline: "not_reached",
    });
  });

  it("a run parked in ingestion is running there, with the pipeline phase not reached", () => {
    expect(phaseStates("ingestion", "running")).toEqual({
      trigger: "succeeded", ingestion: "running", pipeline: "not_reached",
    });
  });

  it("a cancelled run stops where it was", () => {
    expect(phaseStates("trigger", "cancelled")).toEqual({
      trigger: "cancelled", ingestion: "not_reached", pipeline: "not_reached",
    });
  });

  it("returns null for a phase the enum does not contain rather than guessing a position", () => {
    expect(phaseStates("teleport", "running")).toBeNull();
  });
});

describe("BatchRunTimeline — per-binding section", () => {
  it("says the timeline was NOT RETURNED when ingestions is null (the runs list omits it)", () => {
    render(<BatchRunTimeline run={{ ...BASE, ingestions: null }} />);
    expect(screen.getByText("The per-source timeline was not returned for this run.")).toBeInTheDocument();
    expect(screen.queryByText("No ingestions recorded on this run yet.")).toBeNull();
  });

  it("says NO INGESTIONS RECORDED when ingestions is an empty array — a different fact entirely", () => {
    render(<BatchRunTimeline run={{ ...BASE, ingestions: [] }} />);
    expect(screen.getByText("No ingestions recorded on this run yet.")).toBeInTheDocument();
    expect(screen.queryByText("The per-source timeline was not returned for this run.")).toBeNull();
  });

  it("renders the recorded input and output dataset URNs", () => {
    render(<BatchRunTimeline run={BASE} />);
    expect(
      within(screen.getByTestId("batch-run-inputs")).getByText("wr:t-42:dataset:version/claims@v12"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("batch-run-outputs")).getByText("wr:t-42:dataset:dataset/claims_scored"),
    ).toBeInTheDocument();
  });

  it("reports an unplaceable phase as an error instead of drawing a timeline", () => {
    render(<BatchRunTimeline run={{ ...BASE, phase: "teleport", status: "running" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("We could not load this run's phase timeline.");
    expect(screen.queryByTestId("batch-phase-trigger")).toBeNull();
  });
});
