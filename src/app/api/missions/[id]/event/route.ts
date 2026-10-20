import { json, readJson, requireUser, route } from "@/lib/http";
import { postEvent } from "@/lib/services/missions";

export const dynamic = "force-dynamic";

/** Gameplay events (hacks, pickups, robot kills, lives, upload). Every one is checked on the server. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const user = await requireUser(req);
  const { view, outcome } = await postEvent(user, (await ctx.params).id, await readJson(req));
  return json({ ...view, outcome });
});
