import { createSession, rateLimit, sessionCookie } from "@/lib/auth";
import { config } from "@/lib/config";
import { clientKey, HttpError, isSecure, json, readJson, route } from "@/lib/http";
import { publicUser, registerUser } from "@/lib/services/users";

export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  if (!await rateLimit(`register:${clientKey(req)}`, 300, 3600_000)) throw new HttpError(429, "SLOW_DOWN", "Is device se bahut sign-ups ho gaye. Thoda ruko.");
  const user = await registerUser(await readJson(req));
  const { token } = await createSession(user.id);
  return json({ ok: true, user: publicUser(user) }, { status: 201, headers: { "Set-Cookie": sessionCookie(token, config.sessionHours * 3600, isSecure(req)) } });
});
