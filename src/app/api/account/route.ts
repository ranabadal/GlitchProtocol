import { clearSessionCookie } from "@/lib/auth";
import { isSecure, json, readJson, requireUser, route } from "@/lib/http";
import { deleteAccount } from "@/lib/services/users";

export const dynamic = "force-dynamic";

export const DELETE = route(async (req) => {
  const user = await requireUser(req);
  await deleteAccount(user, await readJson(req));
  return json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie(isSecure(req)) } });
});
