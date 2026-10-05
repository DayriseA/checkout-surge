import type { IncomingHttpHeaders } from "node:http";

// Headers through which a client could claim another address, host or protocol.
const forwardingHeaders = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-forwarded-ssl",
  "x-real-ip",
  "fly-client-ip",
];

/**
 * The request headers relayed to the core: the visitor's original Host, and a single forwarded
 * address taken from `Fly-Client-IP`, which Fly Proxy sets and overwrites when a client supplies
 * it. Every client-supplied forwarding header is dropped. The socket address is the fallback for
 * a caller that did not come through Fly Proxy.
 */
export function relayRequestHeaders(
  headers: IncomingHttpHeaders,
  incoming: IncomingHttpHeaders,
  socketAddress: string | undefined,
): IncomingHttpHeaders {
  const relayed = { ...headers };
  for (const name of forwardingHeaders) delete relayed[name];
  const flyClientIp = incoming["fly-client-ip"];
  const visitorAddress = typeof flyClientIp === "string" ? flyClientIp : socketAddress;
  return {
    ...relayed,
    ...(incoming.host ? { host: incoming.host } : {}),
    // Fly Proxy redirects plain HTTP to HTTPS, so every visitor request arrives over HTTPS.
    "x-forwarded-proto": "https",
    ...(visitorAddress ? { "x-forwarded-for": visitorAddress } : {}),
  };
}
