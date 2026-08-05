import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutoRefreshControl } from "./AutoRefreshControl";

describe("AutoRefreshControl", () => {
  it("emits the chosen interval id and fires manual refresh", async () => {
    const user = userEvent.setup();
    const onIntervalChange = vi.fn();
    const onRefresh = vi.fn();

    render(
      <AutoRefreshControl
        interval="off"
        onIntervalChange={onIntervalChange}
        onRefresh={onRefresh}
        lastUpdated={Date.now()}
        isFetching={false}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Auto-refresh"), "1m");
    expect(onIntervalChange).toHaveBeenCalledWith("1m");

    await user.click(screen.getByRole("button", { name: "Refresh now" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows the not-yet-loaded stamp when there is no timestamp", () => {
    render(
      <AutoRefreshControl
        interval="off"
        onIntervalChange={vi.fn()}
        onRefresh={vi.fn()}
        lastUpdated={null}
        isFetching={false}
      />,
    );
    expect(screen.getByText("Not yet loaded")).toBeInTheDocument();
  });

  it("disables manual refresh while a fetch is in flight", () => {
    render(
      <AutoRefreshControl
        interval="30s"
        onIntervalChange={vi.fn()}
        onRefresh={vi.fn()}
        lastUpdated={Date.now()}
        isFetching
      />,
    );
    expect(screen.getByRole("button", { name: "Refresh now" })).toBeDisabled();
  });
});
