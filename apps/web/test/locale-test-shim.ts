import { vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
  headers: vi.fn(async () => ({ get: () => null })),
}));
