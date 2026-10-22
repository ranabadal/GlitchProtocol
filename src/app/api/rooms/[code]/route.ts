import { json, requireUser, route } from "@/lib/http";
import { getRoom } from "@/lib/services/rooms";

export const dynamic = "force-dynamic";

export const GET = route<{ params: Promise<{ code: string }> }>(async (req, ctx) => {
  const user = await requireUser(req);
  return json(await getRoom(user, (await ctx.params).code));
});
