/*
 * EVENT-DAY JOURNEY CHECK. Plays complete missions over HTTP against a RUNNING server,
 * like a real player would (including real travel time between objectives, because the
 * server rejects teleporting). Start the server first (npm run event-day), then:
 *
 *   npm run journey                 # 1 round against http://localhost:3000
 *   npm run journey -- --rounds 3   # repeat the whole journey 3 times
 *   GP_URL=http://192.168.1.20:3000 npm run journey
 *
 * Each round: register, profile, start + resume a mission, an honest playthrough with a
 * deliberate wrong hack (alarm squad), resent events (no double points), early-upload
 * and too-early-finish refusals, the result + debrief, leaderboards, logout/login by
 * participant ID, an abandoned mission. Test accounts are deleted at the end.
 */
import { HACKS } from "../src/lib/engine/hacks";
import { coreIds, courierPos, MAX_TRAVEL_SPEED, TRAVEL_SLACK_MS, type MissionPublic, type Pt } from "../src/lib/shared/mission";

const BASE = (process.env.GP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const roundsArg = process.argv.indexOf("--rounds");
const ROUNDS = roundsArg > 0 ? Number(process.argv[roundsArg + 1]) : 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let checks = 0;
const t0 = Date.now();

function ok(cond: unknown, what: string): void {
  if (!cond) throw new Error(`CHECK FAILED: ${what}`);
  checks++;
}
function say(msg: string): void {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);
}

class Client {
  cookie = "";
  constructor(public name: string) {}
  async call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), Origin: BASE },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    let data: any = null;
    try { data = await res.json(); } catch { /* no body */ }
    return { status: res.status, data };
  }
}

async function travelWait(from: Pt, to: Pt, radius = 0): Promise<void> {
  const d = Math.max(0, Math.hypot(from.x - to.x, from.z - to.z) - radius);
  await sleep(Math.max(0, (d / MAX_TRAVEL_SPEED) * 1000 - TRAVEL_SLACK_MS) + 600);
}

async function playRound(round: number): Promise<string[]> {
  const nick = `jrny${round}${Math.floor(Math.random() * 9e5)}`;
  const pw = "journey-pass-123";
  const c = new Client(nick);
  const made: string[] = [];

  say(`round ${round}: register ${nick}`);
  let r = await c.call("POST", "/api/auth/register", { nickname: nick, password: pw, avatarId: "volt" });
  ok(r.status === 201 && /^GP-/.test(r.data.user.participantId), "register returns a participant ID");
  const pid = r.data.user.participantId as string;
  made.push(pw);
  r = await c.call("PATCH", "/api/profile", { avatarId: "nova", difficultyPref: "balanced" });
  ok(r.status === 200 && r.data.user.avatarId === "nova", "profile update");

  // Start, resume and read the briefing.
  r = await c.call("POST", "/api/missions/start", { mode: "personal" });
  ok(r.status === 200 && r.data.status === "briefing", "mission starts in briefing");
  const id = r.data.id as string;
  const m = r.data.mission as MissionPublic;
  ok(!JSON.stringify(r.data).includes('"solution"') && !JSON.stringify(r.data).includes('"round"'), "no hack answers or puzzles in the view");
  const again = await c.call("POST", "/api/missions/start", { mode: "personal" });
  ok(again.data.id === id && again.data.resumed === true, "starting again resumes the same mission");
  const brief = await c.call("GET", `/api/missions/${id}/briefing`);
  ok(brief.status === 200 && typeof brief.data.briefing === "string", `briefing text (${brief.data.source})`);
  say(`mission ${id.slice(0, 8)} band ${m.band} ${(m.op ?? "classic").toUpperCase()}: ${m.vaults.length} vaults (${m.vaults.map((v) => (v.lock === "titan" ? "TITAN" : v.hackType)).join(", ")})${m.courier ? ", data truck" : ""}, ${m.shards?.length ?? 0} shards, ${m.barricades.length} barricades`);

  r = await c.call("POST", `/api/missions/${id}/begin`, {});
  ok(r.status === 200 && r.data.status === "active", "begin");
  const startedAt = r.data.startedAt as number;
  const offset = r.data.serverNow - Date.now();
  await sleep(Math.max(0, r.data.startedAt - r.data.serverNow) + 300);

  // Robots at the start (in batches the per-second cap allows).
  const startIds = m.groups.filter((g) => g.release === "start").flatMap((g) => g.spawns.map((s) => s.id));
  let killPts = 0;
  for (let i = 0; i < startIds.length; i += 8) {
    r = await c.call("POST", `/api/missions/${id}/event`, { type: "kill", robots: startIds.slice(i, i + 8) });
    ok(r.status === 200, "kill batch accepted");
    killPts += (r.data.outcome.killed ?? []).reduce((n: number, k: { points: number }) => n + k.points, 0);
    await sleep(1050);
  }
  r = await c.call("POST", `/api/missions/${id}/event`, { type: "kill", robots: startIds.slice(0, 3) });
  ok(r.status === 200 && (r.data.outcome.killed ?? []).length === 0, "the same robots reported again score nothing");
  const fake = await c.call("POST", `/api/missions/${id}/event`, { type: "kill", robots: ["r9999"] });
  ok(fake.status === 200 && fake.data.outcome.rejected?.[0]?.reason === "unknown robot", "unknown robot rejected");
  const early = await c.call("POST", `/api/missions/${id}/event`, { type: "uplink_start" });
  ok(early.status === 409, "upload refused before collecting cores");

  // Vaults (the first hackable one gets a deliberately wrong answer first).
  let at: Pt = m.start;
  const firstHack = m.vaults.findIndex((v) => v.lock !== "titan");
  for (const [vi, v] of m.vaults.entries()) {
    await travelWait(at, v.terminal);
    at = v.terminal;
    if (v.lock === "titan") {
      const no = await c.call("POST", `/api/missions/${id}/event`, { type: "hack_start", vault: v.id });
      ok(no.status === 409 && no.data.error.code === "TITAN_LOCK", "the Titan's vault cannot be hacked");
      // The Titan was destroyed with the start robots: its lock is gone.
      r = await c.call("POST", `/api/missions/${id}/event`, { type: "pickup", vault: v.id });
      ok(r.status === 200 && r.data.progress.picked.includes(v.id), `core ${v.id} picked after the Titan fell`);
      at = v.core;
      continue;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await c.call("POST", `/api/missions/${id}/event`, { type: "hack_start", vault: v.id });
      ok(r.status === 200 && r.data.outcome.hack, `hack ${v.id} started (${r.status} ${r.data?.error?.code ?? ""})`);
      const hack = r.data.outcome.hack;
      await sleep(900);
      const right = !(vi === firstHack && attempt === 0);
      const solved = HACKS[v.hackType].solve(hack.round) as { index?: number; rot?: number[] };
      const pick = right ? solved : v.hackType === "power" ? { rot: hack.round.rot } : { index: ((solved.index ?? 0) + 1) % (hack.round.tiles?.length ?? hack.round.bots.length) };
      r = await c.call("POST", `/api/missions/${id}/event`, { type: "hack_answer", vault: v.id, attempt, pick });
      const j = r.data.outcome.judge;
      ok(r.status === 200 && j && j.correct === right, `hack ${v.id} attempt ${attempt} judged ${right ? "right" : "wrong"}`);
      const dup = await c.call("POST", `/api/missions/${id}/event`, { type: "hack_answer", vault: v.id, attempt, pick });
      ok(dup.data.outcome.duplicate === true && dup.data.progress.score === r.data.progress.score, "resent hack answer counted once");
      if (!right) {
        ok(r.data.progress.released.includes(`alarm:${v.id}:1`), "wrong hack released an alarm squad");
        const squad = m.groups.find((g) => g.release === `alarm:${v.id}:1`)?.spawns.map((s) => s.id) ?? [];
        if (squad.length) {
          r = await c.call("POST", `/api/missions/${id}/event`, { type: "kill", robots: squad.slice(0, 8) });
          ok((r.data.outcome.killed ?? []).length === Math.min(8, squad.length), "alarm robots can be destroyed after the alarm");
          await sleep(1050);
        }
        continue;
      }
      break;
    }
    r = await c.call("POST", `/api/missions/${id}/event`, { type: "pickup", vault: v.id });
    ok(r.status === 200 && r.data.progress.picked.includes(v.id), `core ${v.id} picked`);
    const before = r.data.progress.score;
    const dup = await c.call("POST", `/api/missions/${id}/event`, { type: "pickup", vault: v.id });
    ok(dup.data.progress.score === before, "resent pickup counted once");
    at = v.core;
  }

  // The data truck: chase it to where it will be, destroy it, take its core.
  if (m.courier) {
    const cr = m.courier;
    const pre = await c.call("POST", `/api/missions/${id}/event`, { type: "pickup", vault: cr.id });
    ok(pre.status === 409, "truck core refused while the truck still drives");
    let target = courierPos(cr, (Date.now() + offset - startedAt) / 1000);
    for (let i = 0; i < 3; i++) {
      const eta = Math.max(0, (Math.hypot(target.x - at.x, target.z - at.z) / MAX_TRAVEL_SPEED) * 1000 - TRAVEL_SLACK_MS) + 600;
      target = courierPos(cr, (Date.now() + offset + eta - startedAt) / 1000);
    }
    await travelWait(at, target);
    r = await c.call("POST", `/api/missions/${id}/event`, { type: "kill", robots: [cr.id] });
    ok(r.status === 200 && (r.data.outcome.killed ?? []).length === 1, `data truck destroyed (${JSON.stringify(r.data.outcome.rejected ?? [])})`);
    const drop = r.data.progress.courierDrop as Pt;
    at = target;
    await travelWait(at, drop);
    r = await c.call("POST", `/api/missions/${id}/event`, { type: "pickup", vault: cr.id });
    ok(r.status === 200 && r.data.progress.picked.includes(cr.id), "truck core picked");
    at = drop;
    say(`data truck down: ${cr.name}`);
  }

  // A couple of bonus shards on the way.
  for (const sh of [...(m.shards ?? [])].sort((a, b) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z)).slice(0, 2)) {
    await travelWait(at, sh);
    r = await c.call("POST", `/api/missions/${id}/event`, { type: "shard", id: sh.id });
    ok(r.status === 200 && r.data.outcome.points > 0, `shard ${sh.id} collected`);
    const dup = await c.call("POST", `/api/missions/${id}/event`, { type: "shard", id: sh.id });
    ok(dup.data.outcome.duplicate === true, "resent shard counted once");
    at = sh;
  }

  // Refresh mid-mission: same state comes back.
  const mid = await c.call("GET", `/api/missions/${id}`);
  ok(mid.data.progress.picked.length === coreIds(m).length && mid.data.status === "active", "refresh keeps progress");

  await travelWait(at, m.uplink, m.uplink.radius);
  r = await c.call("POST", `/api/missions/${id}/event`, { type: "uplink_start" });
  ok(r.status === 200 && r.data.progress.uplink.startedAt, "upload started");
  const soon = await c.call("POST", `/api/missions/${id}/event`, { type: "uplink_done" });
  ok(soon.status === 409, "upload cannot finish early");
  say(`uploading for ${m.uploadSec}s...`);
  await sleep(m.uploadSec * 1000 + 300);
  r = await c.call("POST", `/api/missions/${id}/event`, { type: "uplink_done" });
  ok(r.status === 200 && r.data.status === "completed" && r.data.result?.cleared, "mission cleared");
  const res = r.data.result;
  ok(res.breakdown.killPoints >= killPts, "kill points recorded");
  ok(res.score === res.breakdown.corePoints + res.breakdown.hackPoints + res.breakdown.killPoints + res.breakdown.shardPoints + res.breakdown.clear + res.breakdown.time + res.breakdown.flawless, "score adds up");
  say(`cleared: score ${res.score}, stars ${res.breakdown.stars}, XP +${res.xpAwarded}${res.breakdown.newAchievements.length ? `, badges ${res.breakdown.newAchievements.join(" ")}` : ""}`);
  const late = await c.call("POST", `/api/missions/${id}/event`, { type: "kill", robots: ["r0"] });
  ok(late.data.outcome?.duplicate === true && late.data.result.score === res.score, "events after the finish change nothing");
  const deb = await c.call("GET", `/api/missions/${id}/debrief`);
  ok(deb.status === 200 && deb.data?.headline, `debrief (${deb.data?.source})`);

  // Boards, logout, login by participant ID.
  r = await c.call("GET", "/api/leaderboard");
  ok(r.data.rows.some((x: { nickname: string }) => x.nickname === nick), "player on the overall leaderboard");
  r = await c.call("GET", `/api/leaderboard?board=band&band=${m.band}`);
  ok(r.data.rows.some((x: { nickname: string }) => x.nickname === nick), "player on their band board");
  await c.call("POST", "/api/auth/logout", {});
  c.cookie = "";
  ok((await c.call("GET", "/api/me")).status === 401, "logged out");
  r = await c.call("POST", "/api/auth/login", { identifier: pid, password: pw });
  ok(r.status === 200 && r.data.user.participantId === pid, "login by participant ID");
  r = await c.call("GET", "/api/me");
  ok(r.status === 200 && r.data.stats.wins >= 1, "history kept after logging back in");

  // Abandon a second mission.
  r = await c.call("POST", "/api/missions/start", { mode: "personal" });
  const id2 = r.data.id;
  await c.call("POST", `/api/missions/${id2}/begin`, {});
  r = await c.call("POST", `/api/missions/${id2}/abort`, {});
  ok(r.data.result?.outcome === "abandoned", "abandoned mission recorded");

  // Clean up the test account.
  r = await c.call("DELETE", "/api/account", { password: pw });
  ok(r.status === 200, "test account deleted");
  return made;
}

/** Two players on "different laptops": open a room, join by code, race, see each other, finish. */
async function multiplayerRound(): Promise<void> {
  const mk = async (tag: string) => {
    const nick = `mp${tag}${Math.floor(Math.random() * 9e5)}`;
    const c = new Client(nick);
    const r = await c.call("POST", "/api/auth/register", { nickname: nick, password: "journey-pass-123", avatarId: "volt" });
    ok(r.status === 201, `multiplayer: register ${tag}`);
    return { c, nick };
  };
  const a = await mk("a"), b = await mk("b");
  say("multiplayer: room + join + race");
  let r = await a.c.call("POST", "/api/rooms", { mode: "solo" });
  ok(r.status === 200 && /^[A-Z0-9]{5}$/.test(r.data.code), "multiplayer: room created with a code");
  const code = r.data.code as string;
  r = await b.c.call("POST", `/api/rooms/${code}/join`, {});
  ok(r.status === 200 && r.data.players.length === 2, "multiplayer: second player joined by code");
  r = await b.c.call("POST", `/api/rooms/${code}/start`, {});
  ok(r.status === 403, "multiplayer: only the host can start");
  r = await a.c.call("POST", `/api/rooms/${code}/start`, {});
  ok(r.status === 200 && r.data.status === "playing" && r.data.yourInstanceId, "multiplayer: race started");
  const ia = r.data.yourInstanceId as string;
  const ib = (await b.c.call("GET", `/api/rooms/${code}`)).data.yourInstanceId as string;
  const [ma, mb] = await Promise.all([a.c.call("GET", `/api/missions/${ia}`), b.c.call("GET", `/api/missions/${ib}`)]);
  ok(JSON.stringify(ma.data.mission) === JSON.stringify(mb.data.mission) && ma.data.startedAt === mb.data.startedAt, "multiplayer: same mission, same start time");
  await a.c.call("POST", `/api/rooms/${code}/sync`, { pose: { x: 1, y: 0, z: 2, h: 0.5, s: 5, m: "foot", w: "blaster" } });
  r = await b.c.call("POST", `/api/rooms/${code}/sync`, { pose: { x: 3, y: 0, z: 4, h: 0, s: 0, m: "foot" } });
  ok(r.status === 200 && r.data.others.length === 1 && r.data.others[0].nickname === a.nick, "multiplayer: players see each other's position");
  await a.c.call("POST", `/api/missions/${ia}/abort`, {});
  await b.c.call("POST", `/api/missions/${ib}/abort`, {});
  r = await a.c.call("GET", `/api/rooms/${code}`);
  ok(r.data.status === "finished" && r.data.players.every((p: { finished: boolean }) => p.finished), "multiplayer: race over once everyone is done");
  for (const p of [a, b]) ok((await p.c.call("DELETE", "/api/account", { password: "journey-pass-123" })).status === 200, "multiplayer: test account deleted");
}

async function main(): Promise<void> {
  const h = await fetch(BASE + "/api/health").then((x) => x.json());
  say(`server ok: ruleset ${h.ruleset}, ${h.players} players, AI ${h.ai.state}`);
  for (let i = 1; i <= ROUNDS; i++) await playRound(i);
  await multiplayerRound();
  say(`ALL GOOD: ${checks} checks passed in ${ROUNDS} round(s).`);
}

main().catch((err) => {
  console.error(`\nJOURNEY FAILED after ${checks} checks: ${(err as Error).message}`);
  console.error(`Is the server running at ${BASE}? (npm run event-day)`);
  process.exit(1);
});
