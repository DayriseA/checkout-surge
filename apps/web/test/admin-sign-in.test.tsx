// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminSignIn } from "../src/app/components/admin/admin-sign-in.js";
import { AdminSignOut } from "../src/app/components/admin-nav.js";
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
    await user.keyboard("{Enter}");

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

  it("shows a clear pending state while sign-in is in progress", async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveRequest = resolve;
          }),
      ),
    );
    const user = userEvent.setup();
    render(<AdminSignIn />);

    await user.type(screen.getByLabelText("Admin passphrase"), "admin-pass");
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    expect(
      (screen.getByRole("button", { name: "Signing in…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByLabelText("Admin passphrase") as HTMLInputElement).disabled).toBe(true);

    resolveRequest?.(jsonResponse({ authenticated: true }));
    await waitFor(() => expect(navigation.refresh).toHaveBeenCalledOnce());
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
    const error = screen.getByRole("alert");
    expect(error.textContent).not.toContain("secret-value");
  });
});

describe("AdminSignOut", () => {
  it("clears the server session and refreshes server-rendered navigation", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ authenticated: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminSignOut />);
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(navigation.refresh).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0]).toEqual([
      adminSessionProxyPath,
      { method: "DELETE", cache: "no-store" },
    ]);
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
