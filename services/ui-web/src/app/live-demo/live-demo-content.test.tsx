import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LiveDemoContent from "./live-demo-content";

// BRD 70 v1.1: self-serve demo signup page. Mirrors WalkthroughOverlay.test.tsx's
// next/navigation mocking pattern.
const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
  usePathname: () => "/live-demo",
}));

async function fillAndSubmit(email = "ada@acme-corp.example") {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/full name/i), "Ada Lovelace");
  await user.type(screen.getByLabelText(/work email/i), email);
  await user.type(screen.getByLabelText(/^company$/i), "Acme Corp");
  await user.click(screen.getByRole("button", { name: /start my live demo/i }));
}

beforeEach(() => {
  replace.mockClear();
  refresh.mockClear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LiveDemoContent (BRD 70 v1.1 self-serve demo signup)", () => {
  it("renders the signup form by default", () => {
    render(<LiveDemoContent />);
    expect(screen.getByRole("heading", { name: /try a live demo/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/full name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/work email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^company$/i)).toBeInTheDocument();
  });

  it("redirects straight into the app when the fast path returns ready:true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, ready: true, tenant: { id: "t-1" } }), { status: 201 })),
    );
    render(<LiveDemoContent />);
    await fillAndSubmit();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(refresh).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/live-demo-signup",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows a provisioning spinner and polls the claim endpoint until ready", async () => {
    let claimCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/live-demo-signup") {
          return new Response(JSON.stringify({ ok: true, ready: false, tenant: { id: "t-2", display_name: "Acme Corp" } }), {
            status: 202,
          });
        }
        if (url === "/api/live-demo-signup/claim") {
          claimCalls++;
          if (claimCalls < 2) {
            return new Response(JSON.stringify({ ok: true, ready: false }), { status: 202 });
          }
          return new Response(JSON.stringify({ ok: true, ready: true }), { status: 200 });
        }
        throw new Error("unexpected fetch " + url);
      }),
    );
    render(<LiveDemoContent />);
    await fillAndSubmit();

    await waitFor(() => expect(screen.getByText(/spinning up/i)).toBeInTheDocument());
    expect(replace).not.toHaveBeenCalled();

    // Advance past two poll intervals.
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(claimCalls).toBeGreaterThanOrEqual(2);
  });

  it("surfaces a clear message on 503 capacity and never silently degrades", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, error: "self-serve demo capacity reached, please try again later" }), {
          status: 503,
        }),
      ),
    );
    render(<LiveDemoContent />);
    await fillAndSubmit();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/capacity/i));
    expect(replace).not.toHaveBeenCalled();
    // The form must still be present so the visitor isn't stuck.
    expect(screen.getByRole("button", { name: /start my live demo/i })).toBeInTheDocument();
  });

  it("surfaces a clear message on 429 rate limiting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "rate limit exceeded" }), { status: 429 })),
    );
    render(<LiveDemoContent />);
    await fillAndSubmit();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/limit/i));
  });

  it("surfaces the disposable-email rejection from the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: "please sign up with a business email address",
            details: [{ field: "work_email" }],
          }),
          { status: 422 },
        ),
      ),
    );
    render(<LiveDemoContent />);
    await fillAndSubmit("someone@mailinator.com");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/business email/i));
    expect(screen.getByLabelText(/work email/i)).toHaveAttribute("aria-invalid", "true");
  });

  it("never sends a request when the honeypot field is not touched (real-user path only)", async () => {
    const fetchMock = vi.fn(async (_url?: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, ready: true }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<LiveDemoContent />);
    await fillAndSubmit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.website).toBe("");
  });
});
