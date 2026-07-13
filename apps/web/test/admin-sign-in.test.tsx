// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminSignIn } from "../src/app/components/admin/admin-sign-in.js";
import { adminPassphraseHeaderName, adminSessionProxyPath } from "../src/app/lib/control-paths.js";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));

afterEach(() => {
  cleanup();
  navigation.refresh.mockReset();
  vi.unstubAllGlobals();
});

describe("AdminSignIn", () => {
  it("posts the exact passphrase header, clears the secret, and refreshes after success", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ authenticated: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminSignIn />);

    await user.type(screen.getByLabelText("Admin passphrase"), "admin-pass");
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => expect(navigation.refresh).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe(adminSessionProxyPath);
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      headers: { [adminPassphraseHeaderName]: "admin-pass" },
    });
    expect((screen.getByLabelText("Admin passphrase") as HTMLInputElement).value).toBe("");
  });

  it("keeps the sign-in island and never reflects the passphrase in an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "Rejected credential secret-value" }, 401)),
    );
    const user = userEvent.setup();
    render(<AdminSignIn />);

    await user.type(screen.getByLabelText("Admin passphrase"), "secret-value");
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    expect(await screen.findByText("Admin sign-in failed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign In" })).toBeTruthy();
    expect(navigation.refresh).not.toHaveBeenCalled();
    const error = screen.getByText("Admin sign-in failed.");
    expect(error.textContent).not.toContain("secret-value");
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
