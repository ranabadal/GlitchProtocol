import { beforeEach, describe, expect, it } from "vitest";
import { __advanceClockForTests } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { VERIFIED_BANK } from "@/lib/engine/bank";
import { applyOutcome, freshSkill, initialBand, PACE_RULES } from "@/lib/engine/difficulty";
import { GenerationError, generateFromSeed, getTemplate, selectInstance, type AnyTemplate } from "@/lib/engine/generator";
import { HACKS } from "@/lib/engine/hacks";
import { glitchHack, type GlitchRound, type Tile } from "@/lib/engine/hacks/glitch";
import { imposterHack, type Bot } from "@/lib/engine/hacks/imposter";
import { powerHack, type PowerRound } from "@/lib/engine/hacks/power";
import { sha256 } from "@/lib/engine/rng";
import { cityHeist, type Heist } from "@/lib/engine/templates/cityHeist";
import { BANDS } from "@/lib/engine/types";
import { killPoints, shardPoints } from "@/lib/engine/scoring";
import { createEvent } from "@/lib/services/events";
import { beginMission, buildFromBank, getMission, postEvent, startMission, type InstanceRow } from "@/lib/services/missions";
import { accessNodes, getCity, isBlocked } from "@/lib/shared/city";
import { coreIds, COUNTDOWN_MS, courierPos, type MissionPublic } from "@/lib/shared/mission";
import { aiReply, chaseTruck, fakeAi, freshDb, makeUser, playMission, playStarted, reloadUser, restartDb, travel } from "./helpers";

const heist = getTemplate("city-heist")!;
const hackVault = (m: MissionPublic) => m.vaults.find((v) => v.lock !== "titan")!;
const row = async (id: string) => (await getDb().prepare(`SELECT * FROM mission_instances WHERE id = ?`).get<InstanceRow>(id))!;

beforeEach(async () => {
  await freshDb();
});

describe("1. two players receive different valid missions", () => {
  it("different seeds, vaults and hack puzzles; both regenerate and validate", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const ra = await row((await startMission(a, { mode: "personal" })).id);
    const rb = await row((await startMission(b, { mode: "personal" })).id);
    expect(ra.band).toBe(rb.band);
    expect(ra.seed).not.toBe(rb.seed);
    expect(ra.fingerprint).not.toBe(rb.fingerprint);
    expect(ra.mission_public).not.toBe(rb.mission_public);
    for (const r of [ra, rb]) {
      const regen = generateFromSeed(heist, r.seed, r.gen_attempt, JSON.parse(r.gen_inputs));
      expect(regen.ok).toBe(true);
      if (regen.ok) expect(heist.validate(regen.puzzle)).toEqual({ ok: true });
    }
  });
});

describe("2. a stored seed recreates the same mission", () => {
  it("engine: every band regenerates identically from (seed, attempt, inputs)", () => {
    for (const band of BANDS) {
      const inputs = { band, focusTags: [] as string[] };
      const sel = selectInstance(heist, `repro-${band}`, inputs);
      const again = generateFromSeed(heist, `repro-${band}`, sel.attempt, inputs);
      expect(again.ok).toBe(true);
      if (!again.ok) continue;
      expect(again.puzzle.publicPuzzle).toEqual(sel.puzzle.publicPuzzle);
      expect(again.puzzle.answerKey).toEqual(sel.puzzle.answerKey);
      expect(again.puzzle.fingerprint).toBe(sel.puzzle.fingerprint);
    }
  });

  it("service: the stored row regenerates to exactly what was persisted", async () => {
    const u = await makeUser();
    const r = await row((await startMission(u, { mode: "personal" })).id);
    const regen = generateFromSeed(heist, r.seed, r.gen_attempt, JSON.parse(r.gen_inputs));
    expect(regen.ok).toBe(true);
    if (!regen.ok) return;
    expect(JSON.stringify(regen.puzzle.publicPuzzle)).toBe(r.mission_public);
    expect(JSON.stringify(regen.puzzle.answerKey)).toBe(r.mission_key);
    expect(r.template_version).toBe(heist.version);
    expect(r.ruleset_version).toBeTruthy();
  });
});

describe("3. an active mission does not change after refresh or restart", () => {
  it("keeps the same mission, progress, lives and running score across reloads and a database reopen", async () => {
    const file = await freshDb(true);
    const u = await makeUser();
    const first = await startMission(u, { mode: "personal" });
    await beginMission(u, first.id);
    __advanceClockForTests(COUNTDOWN_MS + 100);
    const half = await playStarted(u.id, first.id, first.mission, { stopAfterVaults: 1, downs: 1 });
    const snapshot = { mission: half.mission, progress: half.progress };
    expect(half.progress.picked).toHaveLength(1);
    expect(half.progress.lives).toBe(2);
    expect(await getMission(await reloadUser(u.id), first.id)).toMatchObject(snapshot);
    const again = await startMission(await reloadUser(u.id), { mode: "personal" });
    expect(again.id).toBe(first.id);
    expect(again.resumed).toBe(true);
    expect((await beginMission(await reloadUser(u.id), first.id)).startedAt).toBe(half.startedAt);
    await restartDb(file);
    expect(await getMission(await reloadUser(u.id), first.id)).toMatchObject(snapshot);
  });

  it("an open hack puzzle comes back unchanged after a refresh", async () => {
    const u = await makeUser();
    const v = await beginMission(u, (await startMission(u, { mode: "personal" })).id);
    __advanceClockForTests(COUNTDOWN_MS + 100);
    const hv = hackVault(v.mission);
    travel(v.mission.start, hv.terminal);
    const h = (await postEvent(u, v.id, { type: "hack_start", vault: hv.id })).outcome.hack!;
    const again = await postEvent(u, v.id, { type: "hack_start", vault: hv.id });
    expect(again.outcome.duplicate).toBe(true);
    expect(again.outcome.hack!.round).toEqual(h.round);
    expect((await getMission(u, v.id)).progress.hacks[hv.id].active!.round).toEqual(h.round);
  });
});

describe("4. invalid generated missions are rejected", () => {
  const base = () => selectInstance(heist, "invalid-base", { band: 3, focusTags: [] }).puzzle as Heist;
  const mutate = (fn: (m: Heist) => void): Heist => { const m = structuredClone(base()); fn(m); return m; };

  it("a valid mission passes", () => {
    expect(cityHeist.validate(base())).toEqual({ ok: true });
  });

  it("barricades that cut off an objective are rejected", () => {
    const m = mutate((x) => {
      const city = getCity();
      const v = x.publicPuzzle.vaults[0];
      const [a, b] = accessNodes(v.door.x, v.door.z);
      const doorEdge = city.adjacency[a].find((e) => city.adjacency[b].includes(e))!;
      // Wall off both ends of the vault's street: the street itself stays open but nothing reaches it.
      const walls = new Set([...city.adjacency[a], ...city.adjacency[b]].filter((e) => e !== doorEdge));
      x.publicPuzzle.barricades = [...walls].map((edge, i) => ({ id: `b${i}`, edge, x: 0, z: 0, horizontal: city.edgeById.get(edge)!.horizontal, span: 26 }));
    });
    expect(cityHeist.validate(m)).toMatchObject({ ok: false, reason: expect.stringMatching(/cut off/) });
  });

  it("vaults too close together, a non-lobby vault, or a robot inside a wall are rejected", () => {
    const city = getCity();
    expect(cityHeist.validate(mutate((x) => { x.publicPuzzle.vaults[1].door = { ...x.publicPuzzle.vaults[0].door }; })).ok).toBe(false);
    const notLobby = city.buildings.find((b) => !b.lobby)!;
    expect(cityHeist.validate(mutate((x) => { x.publicPuzzle.vaults[0].buildingId = notLobby.id; })).ok).toBe(false);
    const vaultIds = new Set(base().publicPuzzle.vaults.map((v) => v.buildingId));
    const solid = city.buildings.find((b) => !vaultIds.has(b.id) && b.h > 30)!;
    expect(isBlocked(solid.x, solid.z)).toBe(true);
    expect(cityHeist.validate(mutate((x) => { x.publicPuzzle.groups[0].spawns[0] = { ...x.publicPuzzle.groups[0].spawns[0], kind: "walker", x: solid.x, z: solid.z }; }))).toMatchObject({ ok: false, reason: expect.stringMatching(/inside a wall/) });
  });

  it("a timer too short for the route is rejected", () => {
    expect(cityHeist.validate(mutate((x) => { x.publicPuzzle.timeLimitSec = 60; }))).toMatchObject({ ok: false, reason: expect.stringMatching(/too long for the timer/) });
  });

  it("ambiguous or wrong-key hack puzzles are rejected", () => {
    // Data Stream with two broken nodes.
    const t = (c: number): Tile => ({ c, s: 0, z: 1, n: null });
    expect(glitchHack.validate({ tiles: [t(0), t(1), t(2), t(1), t(3), t(1)] }, { glitch: 2, attr: "c" }).ok).toBe(false);
    expect(glitchHack.validate({ tiles: [t(0), t(1), t(0), t(1), t(0), t(1)] }, { glitch: 2, attr: "c" }).ok).toBe(false);
    expect(glitchHack.validate({ tiles: [t(0), t(1), t(0), t(1), t(2), t(1)] }, { glitch: 4, attr: "c" })).toEqual({ ok: true });
    // Firewall already solved at the start.
    const board: PowerRound = { rows: 1, cols: 3, types: ["I", "I", "I"], rot: [1, 1, 1], source: 0, core: 0 };
    expect(powerHack.validate(board, { solution: [1, 1, 1], path: [0, 1, 2] }).ok).toBe(false);
    expect(powerHack.validate({ ...board, rot: [0, 0, 0] }, { solution: [1, 1, 1], path: [0, 1, 2] })).toEqual({ ok: true });
    // Identity Scan with two fakes, or a fake that differs in two parts.
    const bot = (o: Partial<Bot> = {}): Bot => ({ body: 1, eyes: 1, ant: 1, mouth: 1, badge: 1, pose: 0, ...o });
    expect(imposterHack.validate({ bots: [bot(), bot({ eyes: 2 }), bot({ eyes: 2 }), bot(), bot(), bot()], cols: 3 }, { imposter: 1, feature: "eyes" }).ok).toBe(false);
    expect(imposterHack.validate({ bots: [bot(), bot({ eyes: 2, ant: 3 }), bot(), bot(), bot(), bot()], cols: 3 }, { imposter: 1, feature: "eyes" }).ok).toBe(false);
    // And the mission validator catches a bad hack inside a mission.
    const hv = base().publicPuzzle.vaults.find((v) => v.lock !== "titan")!.id;
    const m = mutate((x) => { const a = x.answerKey.hacks[hv][0]; if (a.type === "glitch") (a.round as GlitchRound).tiles = (a.round as GlitchRound).tiles.map((tt) => ({ ...tt, c: 0, s: 0, z: 1, n: null })); else if (a.type === "power") (a.round as PowerRound).rot = (a.key as { solution: number[] }).solution.slice(); else (a.round as { bots: Bot[] }).bots = (a.round as { bots: Bot[] }).bots.map(() => bot()); });
    expect(cityHeist.validate(m)).toMatchObject({ ok: false, reason: expect.stringMatching(/hack/) });
  });

  it("selection skips invalid candidates and stays within its attempt bound", () => {
    let calls = 0;
    const flaky: AnyTemplate = { ...heist, generateCandidate: (rng, inputs) => { const p = heist.generateCandidate(rng, inputs); if (p && ++calls <= 3) { p.publicPuzzle.timeLimitSec = 30; } return p; } };
    const sel = selectInstance(flaky, "flaky", { band: 2, focusTags: [] });
    expect(sel.rejected.length).toBeGreaterThanOrEqual(3);
    expect(heist.validate(sel.puzzle)).toEqual({ ok: true });
    const broken: AnyTemplate = { ...heist, generateCandidate: () => null };
    expect(() => selectInstance(broken, "x", { band: 1, focusTags: [] }, undefined, 10)).toThrow(GenerationError);
  });

  it("every entry in the verified fallback bank regenerates and validates", () => {
    for (const band of BANDS) expect(VERIFIED_BANK.filter((e) => e.band === band).length).toBeGreaterThan(0);
    for (const e of VERIFIED_BANK) expect(generateFromSeed(heist, e.seed, e.attempt, { band: e.band, focusTags: [] }).ok, e.seed).toBe(true);
    expect(buildFromBank(3, { fingerprints: new Map(), recentVariants: [] }, false).source).toBe("bank");
  });

  it("every hack in many random missions is solvable from public data alone", () => {
    for (const band of BANDS) for (let i = 0; i < 4; i++) {
      const s = selectInstance(heist, `solve-${band}-${i}`, { band, focusTags: [] }).puzzle as Heist;
      for (const attempts of Object.values(s.answerKey.hacks)) for (const a of attempts) {
        expect(HACKS[a.type].judge(a.key, HACKS[a.type].solve(a.round), a.round).correct).toBe(true);
      }
    }
  });
});

describe("5. repeated submissions do not duplicate rewards", () => {
  it("the same kill, pickup, hack answer or upload sent twice is counted once", async () => {
    const u = await makeUser();
    const v = await beginMission(u, (await startMission(u, { mode: "personal" })).id);
    __advanceClockForTests(COUNTDOWN_MS + 100);
    const m = v.mission;
    const hv = hackVault(m);
    const rid = m.groups.find((g) => g.release === "start")!.spawns[0].id;
    const k1 = await postEvent(u, v.id, { type: "kill", robots: [rid] });
    const k2 = await postEvent(u, v.id, { type: "kill", robots: [rid, rid] });
    expect(k1.outcome.killed).toHaveLength(1);
    expect(k2.outcome.killed).toHaveLength(0);
    expect(k2.outcome.duplicate).toBe(true);
    const scoreAfterKill = k2.view.progress.score;
    expect(scoreAfterKill).toBe(k1.view.progress.score);

    travel(m.start, hv.terminal);
    const h = (await postEvent(u, v.id, { type: "hack_start", vault: hv.id })).outcome.hack!;
    const pick = HACKS[hv.hackType].solve(h.round);
    const a1 = await postEvent(u, v.id, { type: "hack_answer", vault: hv.id, attempt: 0, pick });
    const a2 = await postEvent(u, v.id, { type: "hack_answer", vault: hv.id, attempt: 0, pick: { index: 0, rot: null } });
    expect(a1.outcome.judge!.correct).toBe(true);
    expect(a2.outcome.duplicate).toBe(true);
    expect(a2.outcome.judge!.correct).toBe(true);
    expect(a2.view.progress.score).toBe(a1.view.progress.score);
    const p1 = await postEvent(u, v.id, { type: "pickup", vault: hv.id });
    const p2 = await postEvent(u, v.id, { type: "pickup", vault: hv.id });
    expect(p2.outcome.duplicate).toBe(true);
    expect(p2.view.progress.score).toBe(p1.view.progress.score);
  });

  it("a finished mission ignores further events and awards XP exactly once", async () => {
    const u = await makeUser();
    const done = await playMission(u.id);
    expect(done.status).toBe("completed");
    const xp = (await reloadUser(u.id)).xp;
    expect(xp).toBe(done.result!.xpAwarded);
    const again = await postEvent(await reloadUser(u.id), done.id, { type: "uplink_done" });
    expect(again.outcome.duplicate).toBe(true);
    await postEvent(await reloadUser(u.id), done.id, { type: "kill", robots: [done.mission.groups[0].spawns[0].id] });
    expect((await reloadUser(u.id)).xp).toBe(xp);
    expect((await getDb().prepare(`SELECT COUNT(*) AS n FROM attempts WHERE instance_id = ?`).get<{ n: number }>(done.id))!.n).toBe(1);
  });

  it("concurrent kill reports for one robot apply exactly once", async () => {
    const u = await makeUser();
    const v = await beginMission(u, (await startMission(u, { mode: "personal" })).id);
    __advanceClockForTests(COUNTDOWN_MS + 100);
    const rid = v.mission.groups[0].spawns[0].id;
    const results = await Promise.all(Array.from({ length: 6 }, async () => postEvent(await reloadUser(u.id), v.id, { type: "kill", robots: [rid] })));
    expect(results.filter((r) => r.outcome.killed?.length).length).toBe(1);
    expect((await getMission(u, v.id)).progress.killed).toEqual([rid]);
  });
});

describe("6. recent mission repetition is minimised", () => {
  it("one player gets no repeated mission across many games", async () => {
    const u = await makeUser();
    await getDb().prepare(`UPDATE users SET difficulty_pref = 'steady' WHERE id = ?`).run(u.id);
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const v = await playMission(u.id, { hackRight: () => i % 3 !== 0 });
      const fp = (await row(v.id)).fingerprint;
      expect(seen.has(fp), `repeated at mission ${i + 1}`).toBe(false);
      seen.add(fp);
    }
  });

  it("avoids back-to-back repeats of the same mission shape when other shapes exist", () => {
    const history = { fingerprints: new Map<string, number>(), recentVariants: [] as string[] };
    let repeats = 0;
    for (let i = 0; i < 12; i++) {
      const sel = selectInstance(heist, `shape-${i}`, { band: 2, focusTags: [] }, history);
      if (history.recentVariants[0] === sel.puzzle.variant) repeats++;
      history.fingerprints.set(sel.puzzle.fingerprint, i);
      history.recentVariants.unshift(sel.puzzle.variant);
    }
    expect(repeats).toBe(0);
  });

  it("when the pool is exhausted it reuses the least recently played mission instead of failing", () => {
    const tiny: AnyTemplate = {
      ...heist,
      generateCandidate: (rng, inputs) => { const k = rng.int(0, 2); const p = heist.generateCandidate(rng, inputs)!; return p && { ...p, variant: "tiny", fingerprint: sha256(`tiny-${k}`) }; },
      validate: () => ({ ok: true }),
    };
    const history = { fingerprints: new Map<string, number>(), recentVariants: [] as string[] };
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      const sel = selectInstance(tiny, `tiny-${i}`, { band: 1, focusTags: [] }, history);
      order.push(sel.puzzle.fingerprint);
      expect(sel.status).toBe(i < 3 ? "fresh" : "pool-exhausted");
      history.fingerprints.set(sel.puzzle.fingerprint, i);
    }
    expect(new Set(order.slice(0, 3)).size).toBe(3);
    expect(order.slice(3)).toEqual(order.slice(0, 3));
  });
});

describe("7. adaptive difficulty follows the documented rules", () => {
  it("rules table", () => {
    expect(initialBand(1)).toBe(1);
    expect(initialBand(4)).toBe(2);
    expect(initialBand(9)).toBe(3);
    for (const [pref, rule] of Object.entries(PACE_RULES)) {
      let s = freshSkill(1);
      for (let i = 0; i < rule.promoteAfter - 1; i++) s = applyOutcome(s, true, pref as never).next;
      expect(s.band).toBe(1);
      const up = applyOutcome(s, true, pref as never);
      expect(up.change).toBe("up");
      s = up.next;
      for (let i = 0; i < rule.demoteAfter - 1; i++) s = applyOutcome(s, false, pref as never).next;
      expect(s.band).toBe(2);
      expect(applyOutcome(s, false, pref as never).next.band).toBe(1);
    }
    let s = freshSkill(1);
    for (let i = 0; i < 10; i++) s = applyOutcome(s, false, "balanced").next;
    expect(s.band).toBe(1);
    for (let i = 0; i < 20; i++) s = applyOutcome(s, true, "bold").next;
    expect(s.band).toBe(5);
  });

  it("service: starts at band 1, two clears move up, two failures move down, and each attempt stores its band", async () => {
    const u = await makeUser();
    const bands: number[] = [];
    for (const win of [true, true, false, false, true]) {
      const v = win ? await playMission(u.id) : await playMission(u.id, { downs: 3 });
      expect(v.result?.cleared).toBe(win);
      bands.push(v.band);
    }
    expect(bands).toEqual([1, 1, 2, 2, 1]);
    const stored = await getDb().prepare(`SELECT band FROM attempts WHERE user_id = ? ORDER BY created_at, seq`).all<{ band: number }>(u.id);
    expect(stored.map((s) => s.band)).toEqual(bands);
    // Harder bands really are harder: more cores, robots and hurdles.
    const b1 = selectInstance(heist, "cmp", { band: 1, focusTags: [] }).puzzle.publicPuzzle as MissionPublic;
    const b5 = selectInstance(heist, "cmp", { band: 5, focusTags: [] }).puzzle.publicPuzzle as MissionPublic;
    const count = (m: MissionPublic) => m.groups.reduce((n, g) => n + g.spawns.length, 0);
    expect(b5.vaults.length).toBeGreaterThan(b1.vaults.length);
    expect(count(b5)).toBeGreaterThan(count(b1));
    expect(b5.barricades.length + b5.fences.length + b5.turrets.length).toBeGreaterThan(b1.barricades.length + b1.fences.length + b1.turrets.length);
  });

  it("failed hacks make the next mission lean toward that hack type, inside the same band", async () => {
    const u = await makeUser();
    const v = await playMission(u.id, { hackRight: () => false });
    const failedTypes = new Set(v.mission.vaults.map((x) => x.hackType));
    const next = await startMission(await reloadUser(u.id), { mode: "personal" });
    const inputs = JSON.parse((await row(next.id)).gen_inputs);
    expect(inputs.focusTags.length).toBeGreaterThan(0);
    expect(inputs.focusTags.some((t: string) => [...failedTypes].some((ft) => t.startsWith(`hack:${ft}`)))).toBe(true);
  });
});

describe("8. shared-event mode gives every participant the same mission", () => {
  it("identical mission and hack puzzles for everyone, labelled as an event, playable once, separate from personal bands", async () => {
    const ev = await createEvent({ name: "Grand finale", band: 3, minutes: 60 });
    const players = [await makeUser(), await makeUser(), await makeUser()];
    const views = [];
    for (const p of players) {
      const m = await startMission(p, { mode: "event", eventCode: ev.code.toLowerCase() });
      expect(m.mode).toBe("event");
      expect(m.event?.name).toBe("Grand finale");
      expect(m.band).toBe(3);
      views.push(await beginMission(p, m.id));
    }
    for (const v of views.slice(1)) expect(v.mission).toEqual(views[0].mission);
    const rows = await Promise.all(views.map((v) => row(v.id)));
    expect(new Set(rows.map((r) => r.mission_key)).size).toBe(1);
    expect(new Set(rows.map((r) => r.fingerprint))).toEqual(new Set([ev.fingerprint]));
    __advanceClockForTests(COUNTDOWN_MS + 100);
    const done = await playStarted(players[0].id, views[0].id, views[0].mission);
    expect(done.result?.cleared).toBe(true);
    await expect(startMission(await reloadUser(players[0].id), { mode: "event", eventCode: ev.code })).rejects.toThrowError(/pehle hi khel/);
    expect(await getDb().prepare(`SELECT * FROM skill_state WHERE user_id = ?`).all(players[0].id)).toHaveLength(0);
  });
});

describe("9. missions still work when the AI API is unavailable", () => {
  it("no AI configured: missions start, play and score with built-in text", async () => {
    const u = await makeUser();
    const v = await playMission(u.id);
    expect(v.narrative.source).toBe("fallback");
    expect(v.narrative.voice.onKill.length).toBeGreaterThan(0);
    expect(v.result?.cleared).toBe(true);
    expect(v.result?.feedback.source).toBe("fallback");
  });

  it("AI that hangs, errors or returns junk never blocks or alters a mission", async () => {
    const { GET: briefing } = await import("@/app/api/missions/[id]/briefing/route");
    const { GET: debrief } = await import("@/app/api/missions/[id]/debrief/route");
    const { createSession } = await import("@/lib/auth");
    const { req, params } = await import("./helpers");
    process.env.AI_TIMEOUT_MS = "300";
    const u = await makeUser();
    const cookie = `gp_session=${(await createSession(u.id)).token}`;
    const behaviours = [
      () => new Promise(() => {}),
      () => { throw new Error("503 Service Unavailable"); },
      () => ({ choices: [{ message: { content: "not json" } }] }),
      () => aiReply({ title: "x" }),
    ];
    for (const behave of behaviours) {
      fakeAi(behave as never);
      const m = await startMission(await reloadUser(u.id), { mode: "personal" });
      const before = (await row(m.id)).mission_public;
      const t0 = Date.now();
      const res = await briefing(req("GET", `/api/missions/${m.id}/briefing`, undefined, cookie), params({ id: m.id }));
      expect(Date.now() - t0).toBeLessThan(3000);
      expect((await res.json()).source).toBe("fallback");
      expect((await row(m.id)).mission_public).toBe(before);
      const done = await playMission(u.id);
      expect(done.id).toBe(m.id);
      expect(done.result?.cleared).toBe(true);
      const fb = await (await debrief(req("GET", `/api/missions/${m.id}/debrief`, undefined, cookie), params({ id: m.id }))).json();
      expect(fb.source).toBe("fallback");
    }
    delete process.env.AI_TIMEOUT_MS;
  });

  it("a valid AI pack is used before the mission starts, cached for reuse, and never sees the mission or the player's name", async () => {
    const { GET: briefing } = await import("@/app/api/missions/[id]/briefing/route");
    const { createSession } = await import("@/lib/auth");
    const { req, params } = await import("./helpers");
    const pack = {
      title: "Operation Neon Storm", briefing: "{{callsign}}, NULL ne city ka data chura liya hai! Vaults todo aur cores uplink pe bhejo.", threat: "Tum kabhi nahi jeetoge!",
      on_kill: ["Mera robot!", "Grrr!", "Nahi!", "Aur bhejta hoon!"], on_down: ["Hehe!", "Gir gaye?", "Ek life gayi!", "Haha!"],
      on_alarm: ["Alarm!", "Pakdo!", "Galat code!"], on_core: ["Chor!", "Wapas karo!", "Mera data!"], on_win: "Mera system crash!", on_lose: "Phir aana, operator!",
    };
    const { calls } = fakeAi(() => aiReply(pack));
    const u = await makeUser("Ada_Lovelace");
    const cookie = `gp_session=${(await createSession(u.id)).token}`;
    const m = await startMission(u, { mode: "personal" });
    const before = await row(m.id);
    const n = await (await briefing(req("GET", `/api/missions/${m.id}/briefing`, undefined, cookie), params({ id: m.id }))).json();
    expect(n.source).toBe("ai");
    expect(n.briefing).toContain("Ada_Lovelace");
    expect(n.voice.onWin).toBe("Mera system crash!");
    expect((await row(m.id)).mission_public).toBe(before.mission_public);
    const prompt = JSON.stringify(calls[0]);
    expect(prompt).not.toContain("Ada_Lovelace");
    expect(prompt).not.toContain(m.mission.vaults[0].name);
    await beginMission(await reloadUser(u.id), m.id);
    fakeAi(() => aiReply({ ...pack, title: "Changed" }));
    expect((await (await briefing(req("GET", `/api/missions/${m.id}/briefing`, undefined, cookie), params({ id: m.id }))).json()).title).toBe("Operation Neon Storm");
    const counter = fakeAi(() => aiReply({ ...pack, title: "Should not be called" }));
    const v = await makeUser("Grace_H");
    const mv = await startMission(v, { mode: "personal" });
    await getDb().prepare(`UPDATE mission_instances SET narrative = jsonb_set(narrative::jsonb, '{theme}', to_jsonb(?::text))::text WHERE id = ?`).run(n.theme, mv.id);
    const nv = await (await briefing(req("GET", `/api/missions/${mv.id}/briefing`, undefined, `gp_session=${(await createSession(v.id)).token}`), params({ id: mv.id }))).json();
    expect(nv.source).toBe("cache");
    expect(nv.briefing).toContain("Grace_H");
    expect(counter.calls).toHaveLength(0);
  });
});

describe("server-side checks on gameplay events", () => {
  async function started() {
    const u = await makeUser();
    const v = await beginMission(u, (await startMission(u, { mode: "personal" })).id);
    __advanceClockForTests(COUNTDOWN_MS + 100);
    return { u, v, m: v.mission, hv: hackVault(v.mission) };
  }

  it("rejects teleporting: a hack started too soon after leaving the start", async () => {
    const { u, v, m, hv } = await started();
    await expect(postEvent(u, v.id, { type: "hack_start", vault: hv.id })).rejects.toThrowError(/mumkin nahi/);
    travel(m.start, hv.terminal);
    expect((await postEvent(u, v.id, { type: "hack_start", vault: hv.id })).outcome.hack).toBeTruthy();
  });

  it("objectives run in order: no pickup before the hack, no upload before every core", async () => {
    const { u, v, m, hv } = await started();
    travel(m.start, hv.terminal);
    await expect(postEvent(u, v.id, { type: "pickup", vault: hv.id })).rejects.toThrowError(/locked/);
    travel(hv.terminal, m.uplink);
    await expect(postEvent(u, v.id, { type: "uplink_start" })).rejects.toThrowError(/core baaki/);
  });

  it("a failed hack raises an alarm squad; three failures brute-force the vault open after the countdown", async () => {
    const { u, v, m, hv } = await started();
    const rid = m.groups.find((g) => g.release === `alarm:${hv.id}:1`)!.spawns[0].id;
    expect((await postEvent(u, v.id, { type: "kill", robots: [rid] })).outcome.rejected![0].reason).toMatch(/not deployed/);
    travel(m.start, hv.terminal);
    for (let a = 0; a < 3; a++) {
      const h = (await postEvent(u, v.id, { type: "hack_start", vault: hv.id })).outcome.hack!;
      const wrong = hv.hackType === "power" ? { rot: (h.round as PowerRound).rot } : { index: (HACKS[hv.hackType].solve(h.round) as { index: number }).index === 0 ? 1 : 0 };
      const j = (await postEvent(u, v.id, { type: "hack_answer", vault: hv.id, attempt: a, pick: wrong })).outcome.judge!;
      expect(j.correct).toBe(false);
      expect(j.reveal).toBeTruthy();
      if (a === 0) expect((await postEvent(u, v.id, { type: "kill", robots: [rid] })).outcome.killed).toHaveLength(1);
    }
    await expect(postEvent(u, v.id, { type: "pickup", vault: hv.id })).rejects.toThrowError(/locked/);
    __advanceClockForTests(m.bruteForceSec * 1000);
    expect((await postEvent(u, v.id, { type: "pickup", vault: hv.id })).view.progress.picked).toContain(hv.id);
  });

  it("an unanswered hack times out and counts as a failure", async () => {
    const { u, v, m, hv } = await started();
    travel(m.start, hv.terminal);
    await postEvent(u, v.id, { type: "hack_start", vault: hv.id });
    __advanceClockForTests(hv.hackTimeMs + 5000);
    const j = (await postEvent(u, v.id, { type: "hack_answer", vault: hv.id, attempt: 0, pick: { index: 0, rot: null } })).outcome.judge!;
    expect(j).toMatchObject({ correct: false, timeout: true });
  });

  it("the upload must actually run for its full duration", async () => {
    const { u, v, m } = await started();
    const done = await playStarted(u.id, v.id, m, { skipUplink: true });
    expect(done.progress.picked).toHaveLength(coreIds(m).length);
    travel(done.progress.courierDrop ?? m.vaults[m.vaults.length - 1].core, m.uplink);
    await postEvent(u, v.id, { type: "uplink_start" });
    __advanceClockForTests(2000);
    await expect(postEvent(u, v.id, { type: "uplink_done" })).rejects.toThrowError(/chal raha/);
    const rid = m.groups.find((g) => g.release === "uplink:1")!.spawns[0].id;
    expect((await postEvent(u, v.id, { type: "kill", robots: [rid] })).outcome.killed).toHaveLength(1);
    __advanceClockForTests(m.uploadSec * 1000);
    expect((await postEvent(u, v.id, { type: "uplink_done" })).view.result?.cleared).toBe(true);
  });

  it("the mission clock is enforced: an unfinished mission times out on its own", async () => {
    const { u, v, m } = await started();
    __advanceClockForTests(m.timeLimitSec * 1000 + 5000);
    const after = await getMission(u, v.id);
    expect(after.status).toBe("failed");
    expect(after.result?.outcome).toBe("timeout");
  });

  it("caps how many robots can be reported destroyed per second", async () => {
    const { u, v, m } = await started();
    const ids = m.groups.filter((g) => g.release === "start").flatMap((g) => g.spawns.map((s) => s.id));
    const many = [...ids, ...m.turrets.map((t) => t.id)];
    if (many.length < 12) return;
    const r = await postEvent(u, v.id, { type: "kill", robots: many.slice(0, 16) });
    expect(r.outcome.killed!.length).toBe(10);
    expect(r.outcome.rejected!.some((x) => x.reason === "too many at once")).toBe(true);
  });
});

describe("mission variety: Titan Hunt, Data Truck Chase, Blitz and data shards", () => {
  /** Start personal missions for fresh players until one matches. */
  async function missionWhere(pred: (m: MissionPublic) => boolean) {
    for (let i = 0; i < 40; i++) {
      const u = await makeUser();
      const s = await startMission(u, { mode: "personal" });
      if (!pred(s.mission)) continue;
      const v = await beginMission(u, s.id);
      __advanceClockForTests(COUNTDOWN_MS + 100);
      return { u, v, m: v.mission };
    }
    throw new Error("no matching mission in 40 tries");
  }

  it("every operation type is generated, validates, and harder bands get more bosses and trucks", () => {
    const seen: Record<string, number> = {};
    const byBand: Record<number, { boss: number; n: number }> = {};
    for (const band of BANDS) for (let i = 0; i < 24; i++) {
      const sel = selectInstance(heist, `ops-${band}-${i}`, { band, focusTags: [] });
      const p = sel.puzzle.publicPuzzle as MissionPublic;
      expect(heist.validate(sel.puzzle)).toEqual({ ok: true });
      seen[p.op!] = (seen[p.op!] ?? 0) + 1;
      byBand[band] ??= { boss: 0, n: 0 };
      byBand[band].n++;
      if (p.op !== "classic") byBand[band].boss++;
      expect(p.vaults.filter((v) => v.lock === "titan").length).toBe(p.op === "titan" || p.op === "blitz" ? 1 : 0);
      expect(!!p.courier).toBe(p.op === "courier" || p.op === "blitz");
      expect((p.shards ?? []).length).toBeGreaterThanOrEqual(4);
    }
    for (const op of ["classic", "titan", "courier", "blitz"]) expect(seen[op], op).toBeGreaterThan(0);
    expect(byBand[5].boss / byBand[5].n).toBeGreaterThan(byBand[1].boss / byBand[1].n);
  });

  it("a truck loop that is barricaded or leaves the roads is rejected", () => {
    let base: Heist | null = null;
    for (let i = 0; !base; i++) { const s = selectInstance(heist, `truck-${i}`, { band: 3, focusTags: [] }).puzzle as Heist; if (s.publicPuzzle.courier) base = s; }
    const bad1 = structuredClone(base);
    bad1.publicPuzzle.courier!.loop[1] = { x: bad1.publicPuzzle.courier!.loop[1].x + 7, z: bad1.publicPuzzle.courier!.loop[1].z };
    expect(cityHeist.validate(bad1)).toMatchObject({ ok: false, reason: expect.stringMatching(/leaves the roads/) });
    const bad2 = structuredClone(base);
    bad2.publicPuzzle.courier!.speed = 45;
    expect(cityHeist.validate(bad2)).toMatchObject({ ok: false, reason: expect.stringMatching(/too fast/) });
  });

  it("Titan Hunt: the Titan's vault cannot be hacked, and its core unlocks only when the Titan falls", async () => {
    const { u, v, m } = await missionWhere((x) => x.vaults.some((q) => q.lock === "titan"));
    const tv = m.vaults.find((q) => q.lock === "titan")!;
    travel(m.start, tv.terminal);
    await expect(postEvent(u, v.id, { type: "hack_start", vault: tv.id })).rejects.toThrowError(/TITAN/);
    await expect(postEvent(u, v.id, { type: "pickup", vault: tv.id })).rejects.toThrowError(/TITAN/);
    const k = await postEvent(u, v.id, { type: "kill", robots: [tv.guard!] });
    expect(k.outcome.killed![0].points).toBe(killPoints(m.band as never, "titan"));
    expect(k.view.progress.unlocked).toContain(tv.id);
    travel(tv.terminal, tv.core);
    expect((await postEvent(u, v.id, { type: "pickup", vault: tv.id })).view.progress.picked).toContain(tv.id);
  });

  it("Data truck: its core needs the truck destroyed nearby, and the upload needs that core too", async () => {
    const { u, v, m } = await missionWhere((x) => !!x.courier);
    const c = m.courier!;
    await expect(postEvent(u, v.id, { type: "pickup", vault: c.id })).rejects.toThrowError(/Truck/);
    // Reporting a kill from the far side of the city is refused.
    // (Only when the truck really is far away: if it happens to start near the safehouse the kill would count.)
    const d0 = Math.hypot(courierPos(c, 0.1).x - m.start.x, courierPos(c, 0.1).z - m.start.z);
    if (d0 > 60 + 52 * 2.6) {
      const far = await postEvent(u, v.id, { type: "kill", robots: [c.id] });
      expect(far.outcome.rejected![0].reason).toMatch(/too far/);
    }
    // Do everything else first: the upload still refuses without the truck's core.
    const done = await playStarted(u.id, v.id, { ...m, courier: null }, { skipUplink: true }, v.startedAt!);
    expect(done.progress.picked).toHaveLength(m.vaults.length);
    travel(m.vaults[m.vaults.length - 1].core, m.uplink);
    await expect(postEvent(u, v.id, { type: "uplink_start" })).rejects.toThrowError(/1 core baaki/);
    // Chase it down, destroy it, grab the core where it fell.
    const at = chaseTruck(m, m.uplink, v.startedAt!);
    const k = await postEvent(u, v.id, { type: "kill", robots: [c.id] });
    expect(k.outcome.killed![0]).toEqual({ id: c.id, points: killPoints(m.band as never, "courier") });
    const drop = k.view.progress.courierDrop!;
    expect(Math.hypot(drop.x - at.x, drop.z - at.z)).toBeLessThan(2);
    travel(at, drop);
    expect((await postEvent(u, v.id, { type: "pickup", vault: c.id })).view.progress.picked).toContain(c.id);
    travel(drop, m.uplink);
    await postEvent(u, v.id, { type: "uplink_start" });
    __advanceClockForTests(m.uploadSec * 1000 + 100);
    const fin = await postEvent(u, v.id, { type: "uplink_done" });
    expect(fin.view.result?.breakdown).toMatchObject({ cores: coreIds(m).length, coresTotal: coreIds(m).length, truckDown: true });
  });

  it("data shards are optional, counted once, travel-checked, with a bonus for the full set", async () => {
    const { u, v, m } = await missionWhere((x) => (x.shards ?? []).length >= 2);
    const sh = m.shards!;
    const far = sh.reduce((a, b) => (Math.hypot(b.x - m.start.x, b.z - m.start.z) > Math.hypot(a.x - m.start.x, a.z - m.start.z) ? b : a));
    if (Math.hypot(far.x - m.start.x, far.z - m.start.z) > 140) await expect(postEvent(u, v.id, { type: "shard", id: far.id })).rejects.toThrowError(/mumkin nahi/);
    let at: { x: number; z: number } = m.start;
    let total = 0;
    for (const [i, s] of sh.entries()) {
      travel(at, s);
      at = s;
      const r = await postEvent(u, v.id, { type: "shard", id: s.id });
      const last = i === sh.length - 1;
      expect(r.outcome.points).toBe(shardPoints(m.band as never, last));
      expect(!!r.outcome.allShards).toBe(last);
      total += r.outcome.points!;
      expect((await postEvent(u, v.id, { type: "shard", id: s.id })).outcome.duplicate).toBe(true);
    }
    expect((await getMission(u, v.id)).progress.points.shards).toBe(total);
    await expect(postEvent(u, v.id, { type: "shard", id: "s99" })).rejects.toThrowError(/shard/);
  });

  it("missions saved before these features (no op, truck or shards) still load and finish", async () => {
    const u = await makeUser();
    const s = await startMission(u, { mode: "personal" });
    const old = { ...s.mission } as Partial<MissionPublic>;
    delete old.op; delete old.courier; delete old.shards;
    const hvOld = hackVault(s.mission);
    old.vaults = old.vaults!.map((q) => { const { lock: _l, guard: _g, ...rest } = q; return q.lock === "titan" ? { ...rest, hackType: hvOld.hackType, hackTimeMs: hvOld.hackTimeMs } : rest; });
    const k = JSON.parse((await row(s.id)).mission_key);
    for (const q of s.mission.vaults) if (q.lock === "titan") k.hacks[q.id] = k.hacks[hackVault(s.mission).id];
    const st = JSON.parse((await row(s.id)).state);
    delete st.shards; delete st.courierDrop; delete st.points.shards;
    await getDb().prepare(`UPDATE mission_instances SET mission_public = ?, mission_key = ?, state = ? WHERE id = ?`).run(JSON.stringify(old), JSON.stringify(k), JSON.stringify(st), s.id);
    const v = await beginMission(await reloadUser(u.id), s.id);
    __advanceClockForTests(COUNTDOWN_MS + 100);
    const done = await playStarted(u.id, v.id, v.mission, {}, v.startedAt!);
    expect(done.result?.cleared).toBe(true);
    expect(done.result?.breakdown).toMatchObject({ coresTotal: old.vaults!.length, shards: 0, shardsTotal: 0 });
  });
});
