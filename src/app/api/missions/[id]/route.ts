import { json, requireUser, route } from "@/lib/http";
import { getMission } from "@/lib/services/missions";

export const dynamic = "force-dynamic";

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const user = await requireUser(req);
  return json(await getMission(user, (await ctx.params).id));
});
