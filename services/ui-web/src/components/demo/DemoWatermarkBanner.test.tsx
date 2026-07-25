import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionProvider, type SessionInfo } from "@/lib/session/SessionContext";
import { DemoWatermarkBanner } from "./DemoWatermarkBanner";

function renderBanner(session: SessionInfo) {
  return render(
    <SessionProvider value={session}>
      <DemoWatermarkBanner />
    </SessionProvider>,
  );
}

const base: SessionInfo = { userId: "u", tenantId: "t-1", workspaceId: "ws-1", scopes: [] };

describe("DemoWatermarkBanner (BRD 70 DSP-FR-014)", () => {
  it("renders the watermark when session.profile is 'demo'", () => {
    renderBanner({ ...base, profile: "demo" });
    expect(screen.getByRole("status", { name: /demo sandbox/i })).toBeInTheDocument();
    expect(screen.getByText(/synthetic data/i)).toBeInTheDocument();
  });

  it("renders nothing for a standard-profile session (profile undefined)", () => {
    renderBanner({ ...base });
    expect(screen.queryByRole("status", { name: /demo sandbox/i })).not.toBeInTheDocument();
  });

  it("renders nothing when profile is explicitly 'standard'", () => {
    renderBanner({ ...base, profile: "standard" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders nothing for profile 'poc' (watermark is demo-only, DSP-FR-014)", () => {
    renderBanner({ ...base, profile: "poc" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
