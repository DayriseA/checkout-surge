// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import NotFound from "../src/app/not-found.js";

it("renders public-safe not-found recovery content", () => {
  render(<NotFound />);

  expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeTruthy();
  expect(screen.getByText(/could not find this page or saved run report/i)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Back to run history" }).getAttribute("href")).toBe(
    "/run-history",
  );
  expect(screen.getByRole("link", { name: "Go to the demo home" }).getAttribute("href")).toBe("/");
});
