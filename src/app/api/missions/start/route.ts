import { z } from "zod";
import { HttpError, json, readJson, requireUser, route } from "@/lib/http";
import { startMission } from "@/lib/services/missions";

export const dynamic = "force-dynamic";

const schema = z.union([
  z.object({ mode: z.literal("personal") }),
  z.object({ mode: z.literal("event"), eventCode: z.string().trim().min(4).max(12) }),
]);

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const r = schema.safeParse(await readJson(req));
  if (!r.success) throw new HttpError(400, "INVALID_INPUT", "Mission mode chuno, ya event code daalo.");
  return json(await startMission(user, r.data));
});
