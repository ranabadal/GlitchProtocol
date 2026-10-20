import { clearSessionCookie, deleteSession } from "@/lib/auth";
import { isSecure, json, route, sessionToken } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  await deleteSession(sessionToken(req));
  return json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie(isSecure(req)) } });
});
