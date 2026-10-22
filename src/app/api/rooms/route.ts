import { z } from "zod";
import { HttpError, json, readJson, requireUser, route } from "@/lib/http";
import { createRoom, myRoom } from "@/lib/services/rooms";

export const dynamic = "force-dynamic";

/** The room you are in right now (for the hub). */
export const GET = route(async (req) => {
  const user = await requireUser(req);
  return json({ room: await myRoom(user.id) });
});

/** Open a new multiplayer room: solo race or Team A vs Team B. */
export const POST = route(async (req) => {
  const user = await requireUser(req);
  const r = z.object({ mode: z.enum(["solo", "teams"]) }).safeParse(await readJson(req));
  if (!r.success) throw new HttpError(400, "INVALID_INPUT", "Race ka type chuno: solo ya teams.");
  return json(await createRoom(user, r.data.mode));
});
