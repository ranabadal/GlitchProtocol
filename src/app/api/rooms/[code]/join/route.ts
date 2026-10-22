import { json, requireUser, route } from "@/lib/http";
import { joinRoom } from "@/lib/services/rooms";

export const dynamic = "force-dynamic";

export const POST = route<{ params: Promise<{ code: string }> }>(async (req, ctx) => {
  const user = await requireUser(req);
  return json(await joinRoom(user, (await ctx.params).code));
});
