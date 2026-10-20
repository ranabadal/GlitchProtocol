import { getDb } from "@/lib/db";
import { BAND_LABELS } from "@/lib/engine/types";
import { HttpError, json, requireUser, route } from "@/lib/http";
import { eventIsLive, findEvent } from "@/lib/services/missions";

export const dynamic = "force-dynamic";

export const GET = route<{ params: Promise<{ code: string }> }>(async (req, ctx) => {
  const user = await requireUser(req);
  const ev = await findEvent(getDb(), (await ctx.params).code);
  if (!ev) throw new HttpError(404, "EVENT_NOT_FOUND", "Is code ka koi event nahi hai.");
  const played = await getDb().prepare(`SELECT id FROM mission_instances WHERE user_id = ? AND event_id = ?`).get<{ id: string }>(user.id, ev.id);
  return json({ code: ev.code, name: ev.name, band: ev.band, bandLabel: BAND_LABELS[ev.band], live: eventIsLive(ev), endsAt: ev.ends_at, playedInstanceId: played?.id ?? null });
});
