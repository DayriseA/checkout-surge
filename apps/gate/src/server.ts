import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import replyFrom from "@fastify/reply-from";
import { type FastifyReply, fastify } from "fastify";
import type { CoreStatus, GatePageState } from "./core-status.js";
import type { RecoveryPage, WakeOutcome } from "./core-wake.js";
import { renderGatePage, safeReturnPath, wakePath } from "./pages.js";
import { relayRequestHeaders } from "./relay-headers.js";

export interface BuildGateServerOptions {
  status: { current(): Promise<CoreStatus>; invalidate(): void };
  wake: { wake(): Promise<WakeOutcome>; recoveryState(): RecoveryPage | undefined };
  logger: CheckoutSurgeLogger;
}

// A dead core host must not hold visitors for undici's default 10 s before they see a page.
const relayConnectTimeoutMs = 3_000;

// Keeps the demo out of search engines.
const robotsTxt = "User-agent: *\nDisallow: /\n";

/**
 * The public entry point. It relays every request to the core's Caddy once the core is ready, and
 * otherwise answers with its own page. Only the start button's POST starts the core. It answers
 * `/robots.txt` itself, without reading the core's state.
 */
export async function buildGateServer(options: BuildGateServerOptions) {
  const app = fastify({ loggerInstance: options.logger });
  await app.register(replyFrom, {
    undici: { connectTimeout: relayConnectTimeoutMs },
    disableRequestLogging: true,
  });

  // Request bodies are relayed as raw streams, whatever their type.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, payload, done) => done(null, payload));

  // Fastify answers HEAD from this GET route too.
  app.get("/robots.txt", async (_request, reply) =>
    reply
      .header("cache-control", "public, max-age=86400")
      .type("text/plain; charset=utf-8")
      .send(robotsTxt),
  );

  app.post(wakePath, async (request, reply) => {
    const returnPath = safeReturnPath((request.query as { return?: unknown }).return);
    const outcome = await options.wake.wake();
    if (outcome === "starting" || outcome === "relocating") return reply.redirect(returnPath, 303);
    return sendPage(reply, outcome, returnPath);
  });

  app.all("/*", async (request, reply) => {
    const recovery = options.wake.recoveryState();
    if (recovery) return sendPage(reply, recovery, request.url);
    const status = await options.status.current();
    if (status.state !== "ready") return sendPage(reply, status.state, request.url);
    return reply.from(undefined, {
      getUpstream: () => status.target,
      rewriteRequestHeaders: (original, headers) =>
        relayRequestHeaders(headers, original.headers, original.socket.remoteAddress),
      // Never replay a request: the core answers for itself, including with a 503.
      retryDelay: () => null,
      onError: () => {
        // The core went away since its status was read, usually because it stopped.
        options.status.invalidate();
        void options.status.current().then((current) => {
          sendPage(reply, current.state === "ready" ? "unavailable" : current.state, request.url);
        });
      },
    });
  });

  return app;
}

function sendPage(reply: FastifyReply, state: GatePageState, returnPath: string): FastifyReply {
  return reply
    .code(503)
    .header("cache-control", "no-store")
    .type("text/html; charset=utf-8")
    .send(renderGatePage(state, safeReturnPath(returnPath)));
}
