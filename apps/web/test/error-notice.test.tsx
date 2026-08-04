// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorNotice } from "../src/app/components/error-notice.js";

describe("ErrorNotice action and disclosure boundary", () => {
  it("renders a Watch conflict as a real public link without technical details", () => {
    render(
      <ErrorNotice
        context="public-start"
        read={{
          status: "unavailable",
          errorCode: "run_conflict",
          details: { conflictReason: "active_run_exists" },
          correlationId: "private-correlation",
          reason: "internal reason",
        }}
      />,
    );

    expect(screen.getByRole("link", { name: "Watch live" }).getAttribute("href")).toBe("/watch");
    expect(screen.queryByText("Technical details")).toBeNull();
    expect(screen.queryByText("private-correlation")).toBeNull();
  });

  it("renders a callback action as a button and omits unsupported retry labels", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ErrorNotice
        context="public-start"
        onRetry={onRetry}
        read={{ status: "unavailable", errorCode: "service_unavailable" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onRetry).toHaveBeenCalledOnce();

    rerender(
      <ErrorNotice
        context="public-start"
        read={{ status: "unavailable", errorCode: "service_unavailable" }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(screen.queryByText("Check again")).toBeNull();
  });

  it.each([
    "edit",
    "contact-operator",
  ] as const)("does not wire recovery to a %s action", (actionKind) => {
    const onRetry = vi.fn();
    render(
      <ErrorNotice
        context="admin-operation"
        onRetry={onRetry}
        presentation={{
          headline: "Operator action failed",
          explanation: "Review the values or operation.",
          action: {
            kind: actionKind,
            label: actionKind === "edit" ? "Edit values" : "Review operation",
          },
          tone: "danger",
        }}
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
    const label = screen.getByText(actionKind === "edit" ? "Edit values" : "Review operation");
    expect(label).toBeTruthy();
    fireEvent.click(label);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("keeps operator diagnostics collapsed and protected", () => {
    render(
      <ErrorNotice
        context="admin-operation"
        protectedDetails
        read={{
          status: "unavailable",
          errorCode: "backend_unavailable",
          httpStatus: 503,
          correlationId: "admin-correlation",
          reason: "backend diagnostic",
        }}
      />,
    );

    expect(screen.getByText("Technical details")).toBeTruthy();
    expect(screen.getByText("admin-correlation")).toBeTruthy();
    expect(screen.getByText("backend diagnostic")).toBeTruthy();
  });
});
