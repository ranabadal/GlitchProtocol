import { json, requireUser, route } from "@/lib/http";
import { beginMission } from "@/lib/services/missions";

export const dynamic = "force-dynamic";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const user = await requireUser(req);
  return json(await beginMission(user, (await ctx.params).id));
});
