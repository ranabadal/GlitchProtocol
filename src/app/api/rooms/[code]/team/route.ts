import { z } from "zod";
import { HttpError, json, readJson, requireUser, route } from "@/lib/http";
import { setTeam } from "@/lib/services/rooms";

export const dynamic = "force-dynamic";

export const POST = route<{ params: Promise<{ code: string }> }>(async (req, ctx) => {
  const user = await requireUser(req);
  const r = z.object({ team: z.enum(["A", "B"]) }).safeParse(await readJson(req));
  if (!r.success) throw new HttpError(400, "INVALID_INPUT", "Team A ya B chuno.");
  return json(await setTeam(user, (await ctx.params).code, r.data.team));
});
