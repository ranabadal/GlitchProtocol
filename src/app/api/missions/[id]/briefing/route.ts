import { aiMissionPack } from "@/lib/ai/content";
import { fillCallsign } from "@/lib/engine/narratives";
import { json, requireUser, route } from "@/lib/http";
import { getMission, setNarrative } from "@/lib/services/missions";

export const dynamic = "force-dynamic";

/**
 * Optional AI story and NULL voice lines. The mission already has built-in text; this
 * only upgrades it before the mission starts. Any AI failure keeps the built-in text.
 */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = (await ctx.params).id;
  const view = await getMission(user, id);
  if (view.status === "briefing" && view.narrative.source === "fallback") {
    const r = await aiMissionPack({ band: view.band, theme: view.narrative.theme, userId: user.id });
    if (r) await setNarrative(id, { title: r.data.title, briefing: fillCallsign(r.data.briefing, user.nickname), threat: r.data.threat, voice: r.data.voice }, r.source);
  }
  return json((await getMission(user, id)).narrative);
});
