import net from "node:net";
import { describe, expect, it } from "vitest";
import { createAbortableDatabaseConnection } from "../../src/index.js";

describe("abortable postgres.js client", () => {
  it("aborts a pool with a statement in flight without leaving a rejection unhandled", async () => {
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", recordUnhandled);
    const server = await startUnresponsivePostgres();
    const controller = new AbortController();
    const connection = createAbortableDatabaseConnection(server.url, controller.signal, {
      max: 1,
    });

    try {
      const query = connection.sql`select 1`;
      const rejection = expect(query).rejects.toThrow();
      await server.firstStatement;
      controller.abort(new Error("operation deadline"));

      await rejection;
      await connection.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
      server.close();
    }
  });
});

/** Accepts a connection as PostgreSQL would, then never answers a statement. */
async function startUnresponsivePostgres() {
  const sockets = new Set<net.Socket>();
  let statementReceived: () => void = () => undefined;
  const firstStatement = new Promise<void>((resolve) => {
    statementReceived = resolve;
  });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    let started = false;
    socket.on("data", () => {
      if (started) {
        statementReceived();
        return;
      }
      started = true;
      const authenticationOk = [0x52, 0, 0, 0, 8, 0, 0, 0, 0];
      const readyForQuery = [0x5a, 0, 0, 0, 5, 0x49];
      socket.write(Buffer.from([...authenticationOk, ...readyForQuery]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    url: `postgres://checkout@127.0.0.1:${port}/checkout`,
    firstStatement,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
