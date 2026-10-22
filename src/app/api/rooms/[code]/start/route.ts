import { json, requireUser, route } from "@/lib/http";
import { startRoom } from "@/lib/services/rooms";

export const dynamic = "force-dynamic";

/** Host only: everyone in the room gets the same mission, starting together. */
export const POST = route<{ params: Promise<{ code: string }> }>(async (req, ctx) => {
  const user = await requireUser(req);
  return json(await startRoom(user, (await ctx.params).code));
});
