import assert from "node:assert/strict";
import test from "node:test";
import { checkDashboardSseStream } from "./runtime-smoke-sse.mjs";

const encoder = new TextEncoder();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createReader(readResults) {
  const reads = [...readResults];
  return {
    cancelCalls: 0,
    releaseCalls: 0,
    async read() {
      return reads.shift();
    },
    async cancel() {
      this.cancelCalls += 1;
    },
    releaseLock() {
      this.releaseCalls += 1;
    },
  };
}

function sseResponse(reader) {
  return {
    body: { getReader: () => reader },
    headers: new Headers({ "content-type": "text/event-stream; charset=utf-8" }),
    ok: true,
    status: 200,
  };
}

function chunk(text) {
  return { done: false, value: encoder.encode(text) };
}

test("waits for a split timestamped heartbeat's frame terminator", async () => {
  const terminator = deferred();
  const reader = createReader([
    chunk("retry: 3000\n: connected\n\n: heart"),
    chunk("beat 2026-07-15T00:00:00.000Z\n"),
    terminator.promise,
  ]);
  let settled = false;
  const check = checkDashboardSseStream("http://dashboard/events", {
    fetch: async () => sseResponse(reader),
  }).then(() => {
    settled = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  terminator.resolve(chunk("\n"));
  await check;
  assert.equal(settled, true);
});

test("accepts a data frame after the control frame in the same chunk", async () => {
  const reader = createReader([chunk('retry: 9000\n: connected\n\ndata: {"type":"run"}\n\n')]);
  await checkDashboardSseStream("http://dashboard/events", {
    fetch: async (_url, init) => {
      assert.equal(init.cache, "no-store");
      assert.equal(init.headers.accept, "text/event-stream");
      assert.ok(init.signal instanceof AbortSignal);
      return sseResponse(reader);
    },
  });
});

test("ignores a control-only frame and fails clearly at EOF", async () => {
  const reader = createReader([chunk("retry: 3000\n: connected\n\n"), { done: true }]);
  await assert.rejects(
    checkDashboardSseStream("http://dashboard/events", {
      fetch: async () => sseResponse(reader),
    }),
    /ended before a heartbeat or event frame/,
  );
});

test("accepts a meaningful CRLF frame among multiple frames", async () => {
  const reader = createReader([
    chunk("retry: 3000\r\n: connected\r\n\r\n: note\r\n\r\n: heartbeat now\r\n\r\n"),
  ]);
  await checkDashboardSseStream("http://dashboard/events", {
    fetch: async () => sseResponse(reader),
  });
});

test("accepts small complete frames when their aggregate chunk exceeds the buffer limit", async () => {
  const reader = createReader([chunk(": note one\n\n: note two\n\n: heartbeat ok\n\n")]);
  await checkDashboardSseStream("http://dashboard/events", {
    fetch: async () => sseResponse(reader),
    maxBufferChars: 14,
  });
});

test("decodes a data frame whose UTF-8 payload is split between bytes", async () => {
  const encoded = encoder.encode('data: {"label":"💥"}\n\n');
  const splitAt = encoded.indexOf(0xf0) + 2;
  const reader = createReader([
    { done: false, value: encoded.slice(0, splitAt) },
    { done: false, value: encoded.slice(splitAt) },
  ]);
  await checkDashboardSseStream("http://dashboard/events", {
    fetch: async () => sseResponse(reader),
  });
});

test("preserves clear HTTP and content-type failures before reading a body", async () => {
  await assert.rejects(
    checkDashboardSseStream("http://dashboard/events", {
      fetch: async () => ({
        body: null,
        headers: new Headers({ "content-type": "text/event-stream" }),
        ok: false,
        status: 503,
      }),
    }),
    /HTTP 503/,
  );
  await assert.rejects(
    checkDashboardSseStream("http://dashboard/events", {
      fetch: async () => ({
        body: null,
        headers: new Headers({ "content-type": "text/plain" }),
        ok: true,
        status: 200,
      }),
    }),
    /Unexpected content-type: text\/plain/,
  );
});

test("reports an absent response body clearly", async () => {
  await assert.rejects(
    checkDashboardSseStream("http://dashboard/events", {
      fetch: async () => ({
        body: null,
        headers: new Headers({ "content-type": "text/event-stream" }),
        ok: true,
        status: 200,
      }),
    }),
    /did not include a readable body/,
  );
});

test("rejects an oversized incomplete frame and cleans up its reader", async () => {
  const reader = createReader([chunk("123456")]);
  await assert.rejects(
    checkDashboardSseStream("http://dashboard/events", {
      fetch: async () => sseResponse(reader),
      maxBufferChars: 5,
    }),
    /Incomplete SSE frame exceeded 5 characters/,
  );
  assert.equal(reader.cancelCalls, 1);
  assert.equal(reader.releaseCalls, 1);
});

test("rejects an oversized complete frame before a later meaningful frame", async () => {
  const reader = createReader([chunk(": unexpectedly long\n\n: heartbeat ok\n\n")]);
  await assert.rejects(
    checkDashboardSseStream("http://dashboard/events", {
      fetch: async () => sseResponse(reader),
      maxBufferChars: 14,
    }),
    /Complete SSE frame exceeded 14 characters/,
  );
  assert.equal(reader.cancelCalls, 1);
  assert.equal(reader.releaseCalls, 1);
});

test("the deadline aborts and cleans up once even if a pending read later settles", async () => {
  const pendingRead = deferred();
  const reader = createReader([pendingRead.promise]);
  const controller = new AbortController();
  await assert.rejects(
    checkDashboardSseStream("http://dashboard/events", {
      controller,
      fetch: async () => sseResponse(reader),
      timeoutMs: 5,
    }),
    /timed out waiting for a heartbeat or event frame after 5ms/,
  );
  assert.equal(controller.signal.aborted, true);
  assert.equal(reader.cancelCalls, 1);
  assert.equal(reader.releaseCalls, 1);

  pendingRead.resolve(chunk(": heartbeat late\n\n"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reader.cancelCalls, 1);
  assert.equal(reader.releaseCalls, 1);
});

test("success and failure clear their timers and release their readers", async () => {
  for (const readResults of [[chunk(": heartbeat now\n\n")], [{ done: true }]]) {
    const reader = createReader(readResults);
    const timer = Symbol("timer");
    const cleared = [];
    const result = checkDashboardSseStream("http://dashboard/events", {
      clearTimeout: (handle) => cleared.push(handle),
      fetch: async () => sseResponse(reader),
      setTimeout: () => timer,
    });
    if (readResults[0].done) await assert.rejects(result);
    else await result;

    assert.deepEqual(cleared, [timer]);
    assert.equal(reader.cancelCalls, 1);
    assert.equal(reader.releaseCalls, 1);
  }
});
