import { aiDebrief } from "@/lib/ai/content";
import { json, requireUser, route } from "@/lib/http";
import { debriefContext, getMission, setFeedback } from "@/lib/services/missions";

export const dynamic = "force-dynamic";

const inflight = new Map<string, Promise<void>>();

/** Personal AI debrief after a mission. Stored once; built-in text if the AI is unavailable. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = (await ctx.params).id;
  const c = await debriefContext(user, id);
  if (c && !c.attempt.feedback && c.attempt.outcome !== "abandoned") {
    let p = inflight.get(id);
    if (!p) {
      p = (async () => {
        const b = c.breakdown as Record<string, number>;
        const fb = await aiDebrief({
          outcome: c.attempt.outcome,
          band: c.attempt.band,
          cores: b.cores ?? 0,
          coresTotal: b.coresTotal ?? 0,
          kills: b.kills ?? 0,
          livesLost: b.livesLost ?? 0,
          hacksFirstTry: b.hacksFirstTry ?? 0,
          secondsLeft: b.secondsLeft ?? 0,
          missedHackNotes: c.missedHackNotes,
          practiceAreas: c.practiceAreas,
          userId: user.id,
        });
        const view = await getMission(user, id);
        if (fb) await setFeedback(id, fb, "ai");
        else if (view.result) await setFeedback(id, { headline: view.result.feedback.headline, feedback: view.result.feedback.feedback, next_tip: view.result.feedback.next_tip }, "fallback");
      })().finally(() => inflight.delete(id));
      inflight.set(id, p);
    }
    await p;
  }
  return json((await getMission(user, id)).result?.feedback ?? null);
});
