import { json, requireUser, route } from "@/lib/http";
import { abortMission } from "@/lib/services/missions";

export const dynamic = "force-dynamic";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const user = await requireUser(req);
  return json(await abortMission(user, (await ctx.params).id));
});
