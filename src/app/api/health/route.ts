import { aiStatus } from "@/lib/ai/client";
import { getDb } from "@/lib/db";
import { RULESET_VERSION } from "@/lib/engine/types";
import { json, route } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  let users = 0;
  try {
    users = (await getDb().prepare(`SELECT COUNT(*) AS n FROM users`).get<{ n: number }>())?.n ?? 0;
  } catch (e) {
    // Shown so a fresh deployment can be checked by opening /api/health (never includes the password).
    const msg = (e instanceof Error ? e.message : String(e)).replace(/postgres(ql)?:\/\/[^\s]+/gi, "postgres://***");
    return json({ ok: false, ruleset: RULESET_VERSION, database: `not connected: ${msg}` }, { status: 503 });
  }
  const ai = await aiStatus();
  return json({ ok: true, ruleset: RULESET_VERSION, database: getDb().kind === "postgres" ? "postgres" : "built-in", players: users, ai: { configured: ai.configured, state: ai.state, label: ai.label, breakerOpen: ai.breakerOpen, usedToday: ai.usedToday, dailyBudget: ai.dailyBudget } });
});
