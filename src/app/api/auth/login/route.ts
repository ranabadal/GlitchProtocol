import { createSession, rateLimitMany, sessionCookie } from "@/lib/auth";
import { config } from "@/lib/config";
import { clientKey, HttpError, isSecure, json, readJson, route } from "@/lib/http";
import { findLoginUser, loginUser, publicUser } from "@/lib/services/users";

export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const body = (await readJson(req)) as { identifier?: unknown };
  const ident = typeof body.identifier === "string" ? body.identifier.trim().toLowerCase().slice(0, 32) : "";
  // The rate-limit counters and the account lookup go to the database at the same time;
  // then the password check and the session. The hub loads the full profile itself.
  const found = findLoginUser(body);
  found.catch(() => {});
  const [byName, byDevice] = await rateLimitMany([{ key: `login:id:${ident}`, limit: 10 }, { key: `login:ip:${clientKey(req)}`, limit: 400 }], 10 * 60_000);
  if (!byName || !byDevice) {
    throw new HttpError(429, "SLOW_DOWN", "Bahut baar galat password. 10 minute ruko, ya operator se help lo.");
  }
  const user = await loginUser(body, found);
  const { token } = await createSession(user.id);
  return json({ ok: true, user: publicUser(user) }, { headers: { "Set-Cookie": sessionCookie(token, config.sessionHours * 3600, isSecure(req)) } });
});
