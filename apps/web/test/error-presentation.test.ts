import { describe, expect, it } from "vitest";
import { mapErrorPresentation } from "../src/app/lib/presentation/error-presentation.js";

describe("error presentation", () => {
  it("distinguishes unsafe settlement timeout from admission-safe projection cleanup", () => {
    const present = (conflictReason: string) =>
      mapErrorPresentation(
        { status: "unavailable", errorCode: "run_cleanup_conflict", details: { conflictReason } },
        "admin-operation",
      );
    expect(present("active_settlement_timeout").explanation).toContain("New runs remain blocked");
    expect(present("projection_cleanup_incomplete").explanation).toContain(
      "does not block new runs",
    );
    expect(present("projection_cleanup_incomplete").headline).toBe(
      "Work cleanup and history completed",
    );
    expect(present("malformed_claimed_job").headline).toBe("Work cleanup needs operator review");
  });

  it("keeps loading neutral and outside error styling", () => {
    const presentation = mapErrorPresentation({ status: "loading" }, "watch-read");
    expect(presentation.tone).toBe("idle");
    expect(presentation.action.kind).toBe("none");
  });

  it("turns an active-run conflict into Watch guidance", () => {
    const presentation = mapErrorPresentation(
      {
        status: "unavailable",
        reason: "shared start contract conflict",
        errorCode: "run_conflict",
        details: { conflictReason: "active_run_exists" },
      },
      "public-start",
    );
    expect(presentation.headline).toBe("A demo run is already in progress");
    expect(presentation.action).toMatchObject({ kind: "watch", href: "/watch" });
    expect(presentation.explanation).not.toContain("contract");
  });

  it("uses authoritative wait timing without offering immediate retry", () => {
    const presentation = mapErrorPresentation(
      {
        status: "unavailable",
        reason: "rate limited",
        errorCode: "public_run_budget_exceeded",
        retryAfterMs: 5_000,
      },
      "public-start",
    );
    expect(presentation.headline).toBe("Public start limit reached for now — try again later");
    expect(presentation.action).toMatchObject({ kind: "wait", retryAfterMs: 5_000 });
    expect(presentation.explanation).toContain("5 seconds");
  });

  it.each([
    ["visitor", "You’ve reached your visitor start allowance"],
    ["global", "The shared demo has reached its start limit"],
  ] as const)("distinguishes the %s public budget without exposing details", (budget, headline) => {
    const presentation = mapErrorPresentation(
      {
        status: "unavailable",
        reason: "Private budget message.",
        errorCode: "public_run_budget_exceeded",
        details: { budget, internal: "private detail" },
        retryAfterMs: 90_000,
      },
      "public-start",
    );

    expect(presentation.headline).toBe(headline);
    expect(presentation.explanation).toBe("Wait 2 minutes before trying again.");
    expect(presentation.action).toMatchObject({ kind: "wait", retryAfterMs: 90_000 });
    expect(JSON.stringify(presentation)).not.toContain("private");
  });

  it.each([
    undefined,
    "future-budget",
  ])("uses safe generic budget copy for absent or invalid detail %s", (budget) => {
    const presentation = mapErrorPresentation(
      {
        status: "unavailable",
        errorCode: "public_run_budget_exceeded",
        ...(budget === undefined ? {} : { details: { budget } }),
        retryAfterMs: 1_000,
      },
      "public-start",
    );
    expect(presentation.headline).toBe("Public start limit reached for now — try again later");
    expect(presentation.explanation).toBe("Wait 1 second before trying again.");
  });

  it("fails closed for unknown or malformed reads while retaining details only for operators", () => {
    const publicPresentation = mapErrorPresentation(
      {
        status: "unavailable",
        reason: "schema parser stack and HTTP 502",
        httpStatus: 502,
        correlationId: "corr-private",
      },
      "history-read",
    );
    expect(publicPresentation.headline).not.toContain("schema");
    expect(publicPresentation.explanation).not.toContain("corr-private");
    expect(publicPresentation.technicalDetails).toBeUndefined();
    const adminPresentation = mapErrorPresentation(
      {
        status: "unavailable",
        reason: "schema parser stack and HTTP 502",
        httpStatus: 502,
        correlationId: "corr-private",
      },
      "admin-read",
    );
    expect(adminPresentation.technicalDetails).toMatchObject({
      reason: "schema parser stack and HTTP 502",
      httpStatus: 502,
      correlationId: "corr-private",
    });

    const publicStartPresentation = mapErrorPresentation(
      {
        status: "unavailable",
        reason: "raw backend probe failure",
        httpStatus: 502,
        correlationId: "corr-private",
      },
      "public-start",
    );
    expect(publicStartPresentation.headline).toBe(
      "The demo backend isn't ready yet — try again in a moment",
    );
    expect(publicStartPresentation.action.kind).toBe("check");
    expect(JSON.stringify(publicStartPresentation)).not.toContain("raw backend probe failure");
    expect(JSON.stringify(publicStartPresentation)).not.toContain("corr-private");
  });

  it.each([
    ["active_run_exists", "A demo run is already in progress", "watch", "/watch"],
    [
      "reset_incomplete",
      "The demo backend isn't ready yet — try again in a moment",
      "check",
      undefined,
    ],
  ] as const)("maps the bounded conflict cause %s", (cause, headline, kind, href) => {
    const presentation = mapErrorPresentation(
      {
        status: "unavailable",
        errorCode: "run_conflict",
        details: { conflictReason: cause, internal: "must not affect copy" },
      },
      "public-start",
    );
    expect(presentation.headline).toBe(headline);
    expect(presentation.action.kind).toBe(kind);
    expect(presentation.action.href).toBe(href);
  });

  it.each([
    ["slug_in_use", "That preset slug is already in use", "edit", "Choose another slug", undefined],
    [
      "not_archivable",
      "This preset can no longer be archived",
      "check",
      "Refresh presets",
      "/admin",
    ],
  ] as const)("maps the bounded preset conflict cause %s", (cause, headline, kind, label, href) => {
    const presentation = mapErrorPresentation(
      {
        status: "unavailable",
        errorCode: "preset_conflict",
        reason: "Backend preset message.",
        httpStatus: 409,
        correlationId: "preset-conflict-correlation",
        details: { conflictReason: cause, slug: "private-slug", internal: "private-detail" },
      },
      "admin-operation",
    );

    expect(presentation.headline).toBe(headline);
    expect(presentation.action).toMatchObject({ kind, label });
    expect(presentation.action.href).toBe(href);
    expect(presentation.technicalDetails).toEqual({
      code: "preset_conflict",
      httpStatus: 409,
      correlationId: "preset-conflict-correlation",
      reason: "Backend preset message.",
    });
    expect(JSON.stringify(presentation)).not.toContain("private-slug");
    expect(JSON.stringify(presentation)).not.toContain("private-detail");
  });

  it("fails closed for an unknown preset conflict cause", () => {
    const presentation = mapErrorPresentation(
      {
        status: "unavailable",
        errorCode: "preset_conflict",
        details: { conflictReason: "future_conflict", internal: "must not affect copy" },
      },
      "admin-operation",
    );

    expect(presentation.headline).toBe("Something didn't work on our side");
    expect(presentation.action.kind).toBe("retry");
    expect(JSON.stringify(presentation)).not.toContain("future_conflict");

    const publicPresentation = mapErrorPresentation(
      { status: "unavailable", errorCode: "preset_conflict" },
      "public-start",
    );
    expect(publicPresentation.headline).toBe(
      "The demo backend isn't ready yet — try again in a moment",
    );
  });

  it.each([
    ["resource_not_found", "No active product is available for demo runs."],
    ["control_token_required", "Control service token is not configured."],
    ["preset_operation_not_allowed", "That preset cannot be started here."],
    ["public_override_not_allowed", "That public override is not allowed."],
    ["invalid_runtime_policy", "The runtime policy is invalid."],
    ["invalid_chaos_configuration", "The chaos configuration is invalid."],
  ] as const)("maps non-correctable public start failure %s safely", (errorCode, reason) => {
    const presentation = mapErrorPresentation(
      {
        status: "unavailable",
        errorCode,
        reason,
        correlationId: "public-start-private-correlation",
        httpStatus: errorCode === "resource_not_found" ? 404 : 503,
      },
      "public-start",
    );

    expect(presentation.headline).toBe("The demo backend isn't ready yet — try again in a moment");
    expect(presentation.action).toMatchObject({ kind: "check", label: "Check again" });
    expect(presentation.technicalDetails).toBeUndefined();
    expect(JSON.stringify(presentation)).not.toContain(reason);
    expect(JSON.stringify(presentation)).not.toContain("public-start-private-correlation");
  });

  it.each([
    "invalid_request",
    "invalid_run_configuration",
  ] as const)("keeps visitor-correctable public start failure %s actionable", (errorCode) => {
    const presentation = mapErrorPresentation({ status: "unavailable", errorCode }, "public-start");

    expect(presentation.headline).toBe("Check the values and try again");
    expect(presentation.action).toMatchObject({ kind: "edit", label: "Edit values" });
  });

  it("keeps non-correctable validation mappings actionable on protected surfaces", () => {
    const presentation = mapErrorPresentation(
      { status: "unavailable", errorCode: "invalid_runtime_policy" },
      "admin-operation",
    );

    expect(presentation.headline).toBe("Check the values and try again");
    expect(presentation.action).toMatchObject({ kind: "edit", label: "Edit values" });
  });

  it("keeps resource-not-found actions contextual", () => {
    expect(
      mapErrorPresentation(
        { status: "unavailable", errorCode: "resource_not_found" },
        "history-detail",
      ).action.href,
    ).toBe("/run-history");
    expect(
      mapErrorPresentation(
        { status: "unavailable", errorCode: "resource_not_found" },
        "public-start",
      ).action.kind,
    ).toBe("check");
    expect(
      mapErrorPresentation(
        { status: "unavailable", errorCode: "resource_not_found" },
        "admin-operation",
      ).action.kind,
    ).toBe("contact-operator");
  });

  it("retains history-specific copy while enabling protected diagnostics explicitly", () => {
    const read = {
      status: "unavailable" as const,
      errorCode: "backend_unavailable" as const,
      httpStatus: 503,
      correlationId: "history-correlation",
      reason: "history backend diagnostic",
    };
    const anonymous = mapErrorPresentation(read, { surface: "history-read" });
    const authenticated = mapErrorPresentation(read, {
      surface: "history-read",
      protected: true,
    });

    expect(anonymous.technicalDetails).toBeUndefined();
    expect(authenticated.technicalDetails).toMatchObject({
      httpStatus: 503,
      correlationId: "history-correlation",
      reason: "history backend diagnostic",
    });
    expect(authenticated.headline).toBe(anonymous.headline);
    expect(authenticated.action).toEqual(anonymous.action);
  });

  it("treats a missing control token as protected deployment guidance, not sign-in", () => {
    const presentation = mapErrorPresentation(
      {
        status: "unavailable",
        errorCode: "control_token_required",
        reason: "Control service token is not configured.",
      },
      "admin-operation",
    );

    expect(presentation.headline).toBe("Operator connection needs attention");
    expect(presentation.action.kind).toBe("contact-operator");
    expect(presentation.action.href).toBeUndefined();
  });

  it("hides readiness probe details behind visitor-facing copy", () => {
    const presentation = mapErrorPresentation(
      {
        status: "unavailable",
        reason: "PostgreSQL readiness check failed",
      },
      { surface: "public-start", readiness: "unavailable" },
    );
    expect(presentation.headline).toBe("The demo backend isn't ready yet — try again in a moment");
    expect(presentation.explanation).not.toContain("PostgreSQL");
  });
});
