import { describe, expect, it } from "vitest";
import { mapErrorPresentation } from "../src/app/lib/presentation/error-presentation.js";

describe("error presentation", () => {
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
    expect(presentation.headline).toBe("A run is already in progress");
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
    expect(presentation.action).toMatchObject({ kind: "wait", retryAfterMs: 5_000 });
    expect(presentation.explanation).toContain("5 seconds");
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
  });

  it.each([
    ["active_run_exists", "A run is already in progress", "watch", "/watch"],
    ["reset_incomplete", "The demo is still recovering", "wait", undefined],
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
    expect(presentation.headline).toBe("The demo is temporarily unavailable");
    expect(presentation.explanation).not.toContain("PostgreSQL");
  });
});
