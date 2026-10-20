import { json, readJson, requireUser, route, loadUser } from "@/lib/http";
import { mePayload, updateProfile } from "@/lib/services/users";

export const dynamic = "force-dynamic";

export const PATCH = route(async (req) => {
  const user = await requireUser(req);
  await updateProfile(user, await readJson(req));
  return json({ ok: true, ...(await mePayload(await loadUser(user.id))) });
});
