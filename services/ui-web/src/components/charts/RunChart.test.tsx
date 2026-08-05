/**
 * BRD 72 inc3 — the run-chart renderers.
 *
 * The artifact fixture is the exact shape experiment-service's
 * `GET /api/v1/artifacts?urn=<run urn>` returns (see
 * `services/experiment-service/app/domain/services.py::_run_metric_artifact`),
 * not an invented one.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunChart } from "./RunChart";
import { resolveKind } from "./ChartView";

const ARTIFACT = {
  kind: "run_summary",
  run_id: "run-1",
  algorithm: "random_forest",
  metrics: [
    { label: "Accuracy", value: 0.91 },
    { label: "ROC AUC", value: 0.96 },
  ],
  confusion_matrix: {
    labels: ["denied", "approved"],
    matrix: [
      [18, 2],
      [3, 17],
    ],
    total: 40,
  },
  roc_auc: 0.96,
};

describe("run chart dispatch", () => {
  it("routes the three run types away from the bar fallback they used to hit", () => {
    expect(resolveKind("confusion_matrix")).toBe("run");
    expect(resolveKind("roc_curve")).toBe("run");
    expect(resolveKind("decision_tree")).toBe("run");
  });
});

describe("confusion_matrix", () => {
  it("renders an N×N matrix with the real class labels", () => {
    render(<RunChart chartType="confusion_matrix" artifact={ARTIFACT} />);
    expect(screen.getByTestId("confusion-matrix")).toBeInTheDocument();
    // Labels appear as both a column header and a row header.
    expect(screen.getAllByText("denied").length).toBe(2);
    expect(screen.getAllByText("approved").length).toBe(2);
  });

  it("renders every cell value", () => {
    render(<RunChart chartType="confusion_matrix" artifact={ARTIFACT} />);
    for (const v of ["18", "2", "3", "17"]) {
      expect(screen.getAllByText(v).length).toBeGreaterThan(0);
    }
  });

  it("labels each cell with its actual→predicted meaning", () => {
    // Which KIND of error matters: a false negative on a fraud model is not the
    // same as a false positive, and an unlabelled grid cannot tell you which.
    render(<RunChart chartType="confusion_matrix" artifact={ARTIFACT} />);
    expect(screen.getByTitle("denied → approved: 2")).toBeInTheDocument();
    expect(screen.getByTitle("approved → denied: 3")).toBeInTheDocument();
  });

  it("refuses a matrix whose label count does not match its rows", () => {
    // A mislabelled matrix is worse than no matrix — it reads as authoritative.
    render(
      <RunChart
        chartType="confusion_matrix"
        artifact={{ confusion_matrix: { labels: ["a", "b", "c"], matrix: [[1, 2], [3, 4]] } }}
      />,
    );
    expect(screen.queryByTestId("confusion-matrix")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("explains itself when the run has no matrix (regression / many classes)", () => {
    render(<RunChart chartType="confusion_matrix" artifact={{ kind: "run_summary", metrics: [] }} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("does not crash on a missing or malformed artifact", () => {
    render(<RunChart chartType="confusion_matrix" artifact={undefined} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

describe("roc_curve", () => {
  it("shows the real mirrored AUC", () => {
    render(<RunChart chartType="roc_curve" artifact={ARTIFACT} />);
    expect(screen.getByText("0.960")).toBeInTheDocument();
  });

  it("says the curve itself is not available rather than drawing an invented one", () => {
    // The AUC scalar is mirrored; the curve POINTS live in the run's
    // evaluation.json, which the mirror does not carry yet (BRD 72 inc3b).
    render(<RunChart chartType="roc_curve" artifact={ARTIFACT} />);
    expect(screen.getByText(/evaluation artifact/i)).toBeInTheDocument();
  });

  it("renders without an AUC too", () => {
    render(<RunChart chartType="roc_curve" artifact={{ kind: "run_summary", metrics: [] }} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

describe("decision_tree", () => {
  it("states that the tree structure is not mirrored yet", () => {
    render(<RunChart chartType="decision_tree" artifact={ARTIFACT} />);
    expect(screen.getByText(/tree structure/i)).toBeInTheDocument();
  });
});
