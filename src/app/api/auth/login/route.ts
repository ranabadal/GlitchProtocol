import { createSession, rateLimit, sessionCookie } from "@/lib/auth";
import { config } from "@/lib/config";
import { clientKey, HttpError, isSecure, json, readJson, route } from "@/lib/http";
import { loginUser, mePayload } from "@/lib/services/users";

export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const body = (await readJson(req)) as { identifier?: unknown };
  const ident = typeof body.identifier === "string" ? body.identifier.trim().toLowerCase().slice(0, 32) : "";
  if (!await rateLimit(`login:id:${ident}`, 10, 10 * 60_000) || !await rateLimit(`login:ip:${clientKey(req)}`, 400, 10 * 60_000)) {
    throw new HttpError(429, "SLOW_DOWN", "Bahut baar galat password. 10 minute ruko, ya operator se help lo.");
  }
  const user = await loginUser(body);
  const { token } = await createSession(user.id);
  return json({ ok: true, ...(await mePayload(user)) }, { headers: { "Set-Cookie": sessionCookie(token, config.sessionHours * 3600, isSecure(req)) } });
});
