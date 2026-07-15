const defaultTimeoutMs = 25_000;
const defaultMaxBufferChars = 64 * 1024;

export async function checkDashboardSseStream(url, options = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const maxBufferChars = options.maxBufferChars ?? defaultMaxBufferChars;
  const controller = options.controller ?? new AbortController();
  const scheduleTimeout = options.setTimeout ?? setTimeout;
  const cancelTimeout = options.clearTimeout ?? clearTimeout;
  let reader;
  let cleanupStarted = false;
  let timeoutHandle;

  const cleanup = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    cancelTimeout(timeoutHandle);
    controller.abort();
    if (!reader) return;

    try {
      await reader.cancel();
    } catch {
      // Closing an already failed or aborted stream is best-effort cleanup.
    }
    try {
      reader.releaseLock();
    } catch {
      // A reader whose stream failed during cancellation may already be released.
    }
  };

  const operation = (async () => {
    const response = await fetchImpl(url, {
      cache: "no-store",
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      throw new Error(`Unexpected content-type: ${contentType || "missing"}.`);
    }
    if (!response.body) {
      throw new Error("SSE response did not include a readable body.");
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

      const inspected = inspectCompleteSseFrames(buffer, maxBufferChars);
      if (inspected.meaningfulFrameFound) return;
      buffer = inspected.remainder;
      if (buffer.length > maxBufferChars) {
        throw new Error(`Incomplete SSE frame exceeded ${maxBufferChars} characters.`);
      }
      if (done) {
        throw new Error("SSE stream ended before a heartbeat or event frame was received.");
      }
    }
  })();

  const deadline = new Promise((_, reject) => {
    timeoutHandle = scheduleTimeout(() => {
      controller.abort();
      reject(
        new Error(
          `SSE stream timed out waiting for a heartbeat or event frame after ${timeoutMs}ms.`,
        ),
      );
    }, timeoutMs);
  });

  try {
    await Promise.race([operation, deadline]);
  } finally {
    await cleanup();
  }
}

function inspectCompleteSseFrames(buffer, maxBufferChars) {
  const separator = /\r?\n\r?\n/g;
  let remainderStart = 0;
  let match = separator.exec(buffer);
  while (match) {
    const frame = buffer.slice(remainderStart, match.index);
    if (frame.length > maxBufferChars) {
      throw new Error(`Complete SSE frame exceeded ${maxBufferChars} characters.`);
    }
    if (isMeaningfulSseFrame(frame)) {
      return { meaningfulFrameFound: true, remainder: "" };
    }
    remainderStart = separator.lastIndex;
    match = separator.exec(buffer);
  }
  return { meaningfulFrameFound: false, remainder: buffer.slice(remainderStart) };
}

export function isMeaningfulSseFrame(frame) {
  return frame
    .replaceAll("\r\n", "\n")
    .split("\n")
    .some((line) => line.startsWith(": heartbeat ") || line.startsWith("data:"));
}
