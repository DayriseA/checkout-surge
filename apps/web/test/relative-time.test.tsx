// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelativeTime } from "../src/app/components/relative-time.js";

describe("relative time", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing on the server and adds deterministic relative copy after mount", async () => {
    const instant = "2026-06-20T10:00:00.000Z";
    expect(renderToStaticMarkup(createElement(RelativeTime, { instant }))).toBe("");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T12:00:00.000Z"));
    await act(async () => {
      render(createElement(RelativeTime, { instant }));
    });

    expect(screen.getByText(/2 hours ago/).getAttribute("aria-hidden")).toBe("true");
  });
});
