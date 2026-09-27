import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  ClientDisconnectedError,
  createHttpOperationLifecycle,
  OperationDeadlineExceededError,
} from "../../src/runtime/operation-lifecycle.js";

describe("HTTP operation lifecycle", () => {
  it("aborts on client disconnect and removes listeners and the deadline on dispose", () => {
    vi.useFakeTimers();
    try {
      const request = Object.assign(new EventEmitter(), { aborted: false }) as IncomingMessage;
      const response = Object.assign(new EventEmitter(), { destroyed: false }) as ServerResponse;
      const lifecycle = createHttpOperationLifecycle({ request, response, timeoutMs: 100 });

      response.emit("close");

      expect(lifecycle.signal.aborted).toBe(true);
      expect(lifecycle.signal.reason).toBeInstanceOf(ClientDisconnectedError);
      lifecycle.dispose();
      expect(request.listenerCount("aborted")).toBe(0);
      expect(response.listenerCount("close")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a stable deadline reason", async () => {
    vi.useFakeTimers();
    try {
      const request = Object.assign(new EventEmitter(), { aborted: false }) as IncomingMessage;
      const response = Object.assign(new EventEmitter(), { destroyed: false }) as ServerResponse;
      const lifecycle = createHttpOperationLifecycle({ request, response, timeoutMs: 100 });

      await vi.advanceTimersByTimeAsync(100);

      expect(lifecycle.signal.reason).toBeInstanceOf(OperationDeadlineExceededError);
      lifecycle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
