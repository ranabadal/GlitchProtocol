import type { DB } from "../db";
import { now } from "../clock";

/** Achievements are badges only: they never change points or XP. */
export const ACHIEVEMENTS = [
  { code: "FIRST_CLEAR", title: "City online", description: "Apna pehla mission clear karo." },
  { code: "FLAWLESS", title: "Flawless", description: "Ek bhi life khoye bina mission clear karo." },
  { code: "HACKERMAN", title: "Hackerman", description: "Ek mission mein har hack pehli try mein karo." },
  { code: "SCRAPYARD", title: "Scrapyard", description: "Ek mission mein 15 robots scrap karo." },
  { code: "SPEED_DEMON", title: "Speed demon", description: "Aadha timer bacha ke mission clear karo." },
  { code: "ALL_HACKS", title: "Triple threat", description: "Teeno hack types (Data Stream, Firewall, Identity) crack karo." },
  { code: "AGENT", title: "Agent rank", description: "Band 3 tak pahuncho." },
  { code: "LEGEND", title: "Legend", description: "Band 5 ka mission clear karo." },
  { code: "COMEBACK", title: "Comeback", description: "Do baar haarne ke baad jeeto." },
  { code: "EVENT_PLAYER", title: "Event player", description: "Ek shared event mission khelo." },
] as const;

export type AchievementCode = (typeof ACHIEVEMENTS)[number]["code"];

export function achievementInfo(code: string) {
  return ACHIEVEMENTS.find((a) => a.code === code) ?? { code, title: code, description: "" };
}

export interface AchievementContext {
  userId: string;
  scope: string;
  cleared: boolean;
  band: number;
  bandAfter: number;
  livesLost: number;
  kills: number;
  hacksFirstTry: number;
  hackCount: number;
  hackTypesCracked: string[];
  timeLeftFrac: number;
}

/** Runs inside the finishing transaction, after the attempt row is written. Returns newly unlocked codes. */
export async function checkAchievements(db: DB, a: AchievementContext): Promise<string[]> {
  const have = new Set((await db.prepare(`SELECT code FROM achievements WHERE user_id = ?`).all<{ code: string }>(a.userId)).map((r) => r.code));
  const earned: string[] = [];
  const give = async (code: AchievementCode, cond: boolean | (() => Promise<boolean>)) => {
    if (have.has(code)) return;
    if (typeof cond === "function" ? await cond() : cond) earned.push(code);
  };
  const win = a.cleared;
  await give("FIRST_CLEAR", win);
  await give("FLAWLESS", win && a.livesLost === 0);
  await give("HACKERMAN", a.hackCount > 0 && a.hacksFirstTry === a.hackCount);
  await give("SCRAPYARD", a.kills >= 15);
  await give("SPEED_DEMON", win && a.timeLeftFrac >= 0.5);
  await give("LEGEND", win && a.band === 5);
  await give("AGENT", a.bandAfter >= 3 || a.band >= 3);
  await give("EVENT_PLAYER", a.scope === "event");
  await give("ALL_HACKS", async () => {
    const rows = await db.prepare(`SELECT score_breakdown FROM attempts WHERE user_id = ?`).all<{ score_breakdown: string }>(a.userId);
    const types = new Set<string>(a.hackTypesCracked);
    for (const r of rows) {
      try { for (const t of (JSON.parse(r.score_breakdown).hackTypesCracked ?? []) as string[]) types.add(t); } catch { /* ignore */ }
    }
    return types.size >= 3;
  });
  await give("COMEBACK", async () => {
    if (!win || a.scope !== "personal") return false;
    const rows = await db.prepare(`SELECT outcome FROM attempts WHERE user_id = ? AND scope = 'personal' ORDER BY created_at DESC, seq DESC LIMIT 3`).all<{ outcome: string }>(a.userId);
    return rows.length === 3 && rows[0].outcome === "success" && rows[1].outcome !== "success" && rows[2].outcome !== "success";
  });
  const t = now();
  for (const code of earned) await db.prepare(`INSERT INTO achievements (user_id, code, unlocked_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`).run(a.userId, code, t);
  return earned;
}
