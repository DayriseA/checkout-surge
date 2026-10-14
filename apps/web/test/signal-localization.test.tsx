// @vitest-environment jsdom

import { emptyHttpTimingBreakdownSummary } from "@checkout-surge/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { formatRate } from "../src/app/components/dashboard-panels";
import { ErrorNotice } from "../src/app/components/error-notice";
import { FieldHint } from "../src/app/components/field-hint";
import { RunFailureExplanation } from "../src/app/components/run-failure-explanation";
import { describeSeries } from "../src/app/components/signal-chart-math";
import { LocaleProvider } from "../src/app/lib/i18n/locale-context";
import { comparisonRunLabel } from "../src/app/lib/presentation/comparison";
import { presentInvalidCustomRunControls } from "../src/app/lib/presentation/custom-run-issue-presentation";
import { deriveRunErpStory } from "../src/app/lib/presentation/erp-story";
import { mapErrorPresentation } from "../src/app/lib/presentation/error-presentation";
import { fieldHints } from "../src/app/lib/presentation/field-hints";
import type { RunFailureExplanationEvidence } from "../src/app/lib/presentation/run-failure-explanation";
import { deriveRunPresentationState } from "../src/app/lib/presentation/run-presentation-state";

afterEach(cleanup);

describe("French signal presentation", () => {
  it("localizes labels while preserving canonical state and comparison identifiers", () => {
    const state = deriveRunPresentationState({ status: "loading" }, undefined, undefined, "fr");
    expect(state.state).toBe("checking-availability");
    expect(state.label).toBe("vérification de la disponibilité");
    expect(comparisonRunLabel("synchronous_confirmation", "fr")).toBe(
      "Exécution 2 sur 2 · Sans la file de commandes",
    );
    expect(deriveRunErpStory(null, "fr")).toBe("Aucune activité récente de l’ERP simulé");
  });

  it("keeps absent rates distinct from zero and uses French number formatting", () => {
    expect(formatRate(null, "attempts/s", undefined, "fr")).toBe("—");
    expect(formatRate(1.5, "attempts/s", undefined, "fr")).toBe("1,5 tentatives/s");
    expect(formatRate(0, "attempts/s", undefined, "fr")).toBe("0 tentatives/s");
  });

  it("translates accessible chart descriptions including units and fractional times", () => {
    expect(
      describeSeries(
        { label: "Arrivals", points: [{ elapsedSeconds: 1.5, value: 3 }] },
        "attempts/s",
        "fr",
      ),
    ).toBe("Arrivées : 3 tentatives/s à 1,5s.");
    expect(describeSeries({ label: "Arrivals", points: [] }, "attempts/s", "fr")).toBe(
      "Arrivées : aucun échantillon conservé.",
    );
  });

  it("translates app-owned field labels and preserves browser-owned validation messages", () => {
    const message = "Please enter a valid value.";
    const [entry] = presentInvalidCustomRunControls(
      [{ controlId: "custom-buyers", message }],
      "fr",
    );
    expect(entry).toMatchObject({
      fieldId: "custom-buyers",
      fieldError: message,
      message: `Nombre d’acheteurs: ${message}`,
      targetId: "custom-buyers",
    });
  });

  it("uses French plurals and percentages in failure evidence, including one unsent request", () => {
    const evidence: RunFailureExplanationEvidence = {
      failureDiagnostic: { cause: "virtual_user_limit", maxVus: 4_000 },
      transportAttemptCounts: {
        plannedRequests: 30_000,
        startedRequests: 27_443,
        completedRequests: 27_443,
        unstartedRequests: 2_557,
        interruptedRequests: 0,
      },
      httpSummary: {
        acceptedResponses: 1_500,
        soldOutResponses: 25_943,
        unexpectedResponses: 0,
        transportFailures: 0,
        failedRequests: 0,
        failureRate: 0,
      },
      httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
      businessOutcomeSummary: {
        acceptedReservations: 1_500,
        reservedUnits: 1_500,
        soldOutRejections: 25_943,
        confirmedOrders: 1_500,
        notificationsRecorded: 1_500,
        failedOrders: 0,
        queuedOrders: 0,
        processingOrders: 0,
        retryingOrders: 0,
        pendingPersistenceCount: 0,
      },
    };
    const { container, rerender } = render(
      <LocaleProvider locale="fr">
        <RunFailureExplanation evidence={evidence} />
      </LocaleProvider>,
    );
    expect(container.textContent).toContain("utilisateurs virtuels simultanés");
    expect(container.textContent).toContain("8,52%");

    const oneUnsent: RunFailureExplanationEvidence = {
      ...evidence,
      transportAttemptCounts: {
        ...evidence.transportAttemptCounts,
        startedRequests: 29_999,
        completedRequests: 29_999,
        unstartedRequests: 1,
      },
      httpSummary: { ...evidence.httpSummary, soldOutResponses: 28_499 },
      businessOutcomeSummary: { ...evidence.businessOutcomeSummary, soldOutRejections: 28_499 },
    };
    rerender(
      <LocaleProvider locale="fr">
        <RunFailureExplanation evidence={oneUnsent} />
      </LocaleProvider>,
    );
    expect(screen.getByText("Requêtes prévues jamais envoyées : 1.")).toBeTruthy();

    rerender(
      <LocaleProvider locale="en">
        <RunFailureExplanation evidence={oneUnsent} />
      </LocaleProvider>,
    );
    expect(screen.getByText("1 planned request was never sent.")).toBeTruthy();
  });

  it("renders translated hints and protected error details without changing diagnostic codes", () => {
    render(
      <LocaleProvider locale="fr">
        <FieldHint label="Starting stock" text={fieldHints.startingStock} />
        <ErrorNotice
          context="admin-read"
          protectedDetails
          read={{
            status: "unavailable",
            httpStatus: 503,
            errorCode: "dashboard_recovery_unavailable",
            correlationId: "trace-fr",
          }}
        />
      </LocaleProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "À propos de Stock initial" }));
    expect(screen.getByRole("tooltip").textContent).toContain("Unités en vente au démarrage.");
    expect(screen.getByText("Détails techniques")).toBeTruthy();
    expect(screen.getByText("Statut HTTP")).toBeTruthy();
    expect(screen.getByText("dashboard_recovery_unavailable")).toBeTruthy();
    expect(screen.getByText("trace-fr")).toBeTruthy();
    const failure = mapErrorPresentation(
      { status: "unavailable", httpStatus: 500 },
      "watch-read",
      "fr",
    );
    expect(failure.headline).not.toBe(
      mapErrorPresentation({ status: "unavailable", httpStatus: 500 }, "watch-read").headline,
    );
  });
});
