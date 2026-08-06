// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminSignIn, parseLoginRetryAfterMs } from "../src/app/components/admin/admin-sign-in.js";
import { AdminSignOut } from "../src/app/components/admin-nav.js";
import { adminPassphraseHeaderName, adminSessionProxyPath } from "../src/app/lib/control-paths.js";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  navigation.refresh.mockReset();
  vi.unstubAllGlobals();
});

describe("AdminSignIn", () => {
  it("preserves login Retry-After values above the dashboard retry cap", () => {
    expect(parseLoginRetryAfterMs("301")).toBe(301_000);
    expect(parseLoginRetryAfterMs("600")).toBe(600_000);
  });

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
    await user.click(screen.getByRole("button", { name: "Sign in" }));

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
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Admin sign-in failed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(navigation.refresh).not.toHaveBeenCalled();
    const error = screen.getByRole("alert");
    expect(error.textContent).not.toContain("secret-value");
  });

  it("honors Retry-After and disables sign-in during the authoritative wait", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "rate limited" }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "7" },
          }),
      ),
    );
    const user = userEvent.setup();
    render(<AdminSignIn />);

    await user.type(screen.getByLabelText("Admin passphrase"), "admin-pass");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Wait 7 seconds before trying again.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByRole("status").textContent).toContain("Wait 7 seconds");
  });

  it("expires a long login wait and cleans its timer on unmount", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "rate limited" }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "301" },
          }),
      ),
    );
    const view = render(<AdminSignIn />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const signInButton = () => screen.getByRole("button", { name: /Sign in|Signing in/ });
    expect((signInButton() as HTMLButtonElement).disabled).toBe(true);
    act(() => vi.advanceTimersByTime(301_000));
    expect((signInButton() as HTMLButtonElement).disabled).toBe(false);

    view.unmount();
    act(() => vi.advanceTimersByTime(301_000));
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
