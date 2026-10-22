import { json, readJson, requireUser, route } from "@/lib/http";
import { syncRoom } from "@/lib/services/rooms";

export const dynamic = "force-dynamic";

/** Several times a second during a race: my position in, everyone else's (and the scoreboard) out. */
export const POST = route<{ params: Promise<{ code: string }> }>(async (req, ctx) => {
  const user = await requireUser(req);
  return json(await syncRoom(user, (await ctx.params).code, await readJson(req, 4000)));
});
