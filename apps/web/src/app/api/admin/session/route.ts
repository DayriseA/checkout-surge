import {
  createAdminSessionCookie,
  requireAdminPassphrase,
} from "../../../lib/server/backend-proxy";

export async function POST(request: Request): Promise<Response> {
  const unauthorized = requireAdminPassphrase(request);
  if (unauthorized) {
    return unauthorized;
  }

  const cookie = createAdminSessionCookie();
  if (cookie instanceof Response) {
    return cookie;
  }

  return Response.json(
    { authenticated: true },
    {
      status: 200,
      headers: {
        "set-cookie": cookie,
      },
    },
  );
}
