import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";
import type { Viewer } from "@/lib/graphql/types";
import { vi } from "vitest";

// The trail degrades gated crumbs to plain text via useCapabilities, which
// reads the viewer query — same mocking shape as gating.test.tsx.
let mockViewer: Viewer | undefined;
vi.mock("@/lib/graphql/hooks", () => ({
  useMe: () => ({ data: mockViewer ? { me: mockViewer } : undefined, isLoading: false, isError: false }),
  useTenantCommercial: () => ({ data: undefined, isLoading: false, isError: false }),
}));

import { Breadcrumbs, BackLink } from "./Breadcrumbs";
import { crumbsFor, backTargetFor } from "@/lib/nav/breadcrumbs";

function viewer(capabilities: string[]): Viewer {
  return {
    userId: "u",
    tenantId: "t",
    tenantName: "Tenant T",
    workspaceId: "w",
    workspaceName: "Default use case",
    type: "user",
    scopes: [],
    isPlatformAdmin: false,
    roles: ["Model Builder"],
    capabilities,
    capsDegraded: false,
  };
}

const PATH = "/ml/eval/runs/abc123";
const FULL_ACCESS = ["experiment.experiment.read", "eval.run.read"];

beforeEach(() => {
  mockViewer = viewer(FULL_ACCESS);
});

describe("Breadcrumbs", () => {
  it("renders the trail as a labelled nav with an ordered list", () => {
    renderWithProviders(<Breadcrumbs crumbs={crumbsFor(PATH)} />);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(nav).toBeInTheDocument();
    expect(nav.querySelector("ol")).toBeTruthy();
  });

  it("marks the last crumb aria-current='page' and never links it", () => {
    renderWithProviders(<Breadcrumbs crumbs={crumbsFor(PATH, { currentLabel: "Nightly regression" })} />);
    const current = screen.getByText("Nightly regression");
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current.tagName).toBe("SPAN");
    expect(current.closest("a")).toBeNull();
    // Exactly one crumb may claim to be the current page.
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it("links every ancestor the viewer can reach", () => {
    renderWithProviders(<Breadcrumbs crumbs={crumbsFor(PATH)} />);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "ML" })).toHaveAttribute("href", "/ml");
    expect(screen.getByRole("link", { name: "Eval" })).toHaveAttribute("href", "/ml/eval");
    expect(screen.getByRole("link", { name: "Runs" })).toHaveAttribute("href", "/ml/eval/runs");
  });

  it("renders a crumb the viewer's capabilities do not unlock as plain text", () => {
    // No eval.run.read: /ml/eval and /ml/eval/runs must not be offered as links.
    mockViewer = viewer(["experiment.experiment.read"]);
    renderWithProviders(<Breadcrumbs crumbs={crumbsFor(PATH)} />);
    expect(screen.getByRole("link", { name: "ML" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Eval" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Runs" })).toBeNull();
    expect(screen.getByText("Eval").tagName).toBe("SPAN");
    expect(screen.getByText("Runs").tagName).toBe("SPAN");
  });

  it("renders section crumbs as text (a sidebar section has no route)", () => {
    renderWithProviders(<Breadcrumbs crumbs={crumbsFor(PATH)} />);
    expect(screen.queryByRole("link", { name: "Machine Learning" })).toBeNull();
    expect(screen.getByText("Machine Learning")).toBeInTheDocument();
  });

  it("renders nothing for an empty trail (the home route)", () => {
    const { container } = renderWithProviders(<Breadcrumbs crumbs={crumbsFor("/")} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("BackLink", () => {
  it("offers a one-click way back to the record's parent", () => {
    const crumbs = crumbsFor(PATH);
    const back = backTargetFor(PATH, crumbs);
    expect(back).toBeDefined();
    renderWithProviders(<BackLink crumb={back!} />);
    const link = screen.getByRole("link", { name: "Back to Runs" });
    expect(link).toHaveAttribute("href", "/ml/eval/runs");
  });

  it("hides itself when the viewer cannot reach the parent", () => {
    mockViewer = viewer(["experiment.experiment.read"]);
    const crumbs = crumbsFor(PATH);
    const { container } = renderWithProviders(<BackLink crumb={backTargetFor(PATH, crumbs)!} />);
    expect(container).toBeEmptyDOMElement();
  });
});
