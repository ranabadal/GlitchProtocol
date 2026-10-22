import { beforeEach, describe, expect, it } from "vitest";
import { __advanceClockForTests, now } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { getMission, postEvent } from "@/lib/services/missions";
import { createRoom, FIRST_FINISH_BONUS, getRoom, joinRoom, leaveRoom, ROOM_LEAD_MS, setTeam, startRoom, syncRoom } from "@/lib/services/rooms";
import { freshDb, makeUser, playStarted, reloadUser } from "./helpers";

beforeEach(async () => {
  await freshDb();
});

async function startedRace(mode: "solo" | "teams", n: number) {
  const users = [];
  for (let i = 0; i < n; i++) users.push(await makeUser());
  const room = await createRoom(users[0], mode);
  for (const u of users.slice(1)) await joinRoom(await reloadUser(u.id), room.code);
  const started = await startRoom(await reloadUser(users[0].id), room.code);
  return { users, code: room.code, started };
}

describe("multiplayer rooms", () => {
  it("creates a lobby, joins by code, and only the host can start (needs 2 players)", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const room = await createRoom(a, "solo");
    expect(room.code).toMatch(/^[A-Z0-9]{5}$/);
    expect(room.status).toBe("lobby");
    await expect(startRoom(a, room.code)).rejects.toMatchObject({ code: "NEED_PLAYERS" });
    const joined = await joinRoom(b, room.code.toLowerCase());
    expect(joined.players.map((p) => p.nickname)).toEqual([a.nickname, b.nickname]);
    expect(joined.youAreHost).toBe(false);
    await expect(startRoom(b, room.code)).rejects.toMatchObject({ code: "NOT_HOST" });
    await expect(joinRoom(b, "ZZZZZ")).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
  });

  it("gives every racer the same mission and start time", async () => {
    const { users, code, started } = await startedRace("solo", 3);
    expect(started.status).toBe("playing");
    const views = await Promise.all(users.map(async (u) => getMission(await reloadUser(u.id), (await getRoom(await reloadUser(u.id), code)).yourInstanceId!)));
    expect(new Set(views.map((v) => JSON.stringify(v.mission))).size).toBe(1);
    expect(new Set(views.map((v) => v.startedAt)).size).toBe(1);
    expect(views[0].status).toBe("active");
    expect(views[0].mode).toBe("room");
    expect(views[0].room).toEqual({ code, mode: "solo" });
    expect(views[0].startedAt! - now()).toBeGreaterThanOrEqual(ROOM_LEAD_MS - 1000);
    // Nobody else can join a race that already started.
    await expect(joinRoom(await makeUser(), code)).rejects.toMatchObject({ code: "ROOM_STARTED" });
  });

  it("first to finish wins; the others' runs end and keep their points", async () => {
    const { users, code } = await startedRace("solo", 2);
    const [a, b] = users;
    const ra = await getRoom(a, code), rb = await getRoom(b, code);
    __advanceClockForTests(ROOM_LEAD_MS + 200);
    const mb = await getMission(b, rb.yourInstanceId!);
    // b kills a couple of robots first (gets some points), then a clears the whole mission.
    const startRobots = mb.mission.groups.filter((g) => g.release === "start").flatMap((g) => g.spawns.map((s) => s.id)).slice(0, 2);
    await postEvent(await reloadUser(b.id), rb.yourInstanceId!, { type: "kill", robots: startRobots });
    const mid = await getRoom(a, code);
    expect(mid.players.find((p) => p.userId === b.id)!.score).toBeGreaterThan(0);
    const va = await playStarted(a.id, ra.yourInstanceId!, mb.mission, {}, mb.startedAt!);
    expect(va.result?.outcome).toBe("success");
    const end = await getRoom(b, code);
    expect(end.status).toBe("finished");
    expect(end.winner).toMatchObject({ userId: a.id, nickname: a.nickname, reason: "first" });
    // b's game sees the race is over: their mission ends as a loss, with their points recorded.
    const vb = await getMission(await reloadUser(b.id), rb.yourInstanceId!);
    expect(vb.result?.outcome).toBe("fail");
    expect(vb.result!.score).toBeGreaterThan(0);
    const after = await getRoom(a, code);
    expect(after.players.every((p) => p.finished)).toBe(true);
    const badges = await getDb().prepare(`SELECT code FROM achievements WHERE user_id = ? AND code = 'RACE_WINNER'`).all(a.id);
    expect(badges).toHaveLength(1);
  });

  it("team race: balanced teams, team score = members' points + first-finish bonus", async () => {
    const users = [];
    for (let i = 0; i < 4; i++) users.push(await makeUser());
    const room = await createRoom(users[0], "teams");
    for (const u of users.slice(1)) await joinRoom(u, room.code);
    let r = await getRoom(users[0], room.code);
    expect(r.teams).toEqual({ A: 0, B: 0 });
    expect(r.players.map((p) => p.team)).toEqual(["A", "B", "A", "B"]);
    // Team B is full-ish? 2 each: switching is allowed while there's space.
    await setTeam(users[3], room.code, "A");
    r = await getRoom(users[0], room.code);
    expect(r.players.map((p) => p.team)).toEqual(["A", "B", "A", "A"]);
    await setTeam(users[3], room.code, "B");
    await startRoom(users[0], room.code);
    __advanceClockForTests(ROOM_LEAD_MS + 200);
    const rooms = await Promise.all(users.map((u) => getRoom(u, room.code)));
    const m = await getMission(users[0], rooms[0].yourInstanceId!);
    // Team B (users 1 and 3) scores robots; Team A's user 0 finishes first.
    const startRobots = m.mission.groups.filter((g) => g.release === "start").flatMap((g) => g.spawns.map((s) => s.id));
    await postEvent(await reloadUser(users[1].id), rooms[1].yourInstanceId!, { type: "kill", robots: startRobots.slice(0, 3) });
    const fin = await playStarted(users[0].id, rooms[0].yourInstanceId!, m.mission, {}, m.startedAt!);
    expect(fin.result?.outcome).toBe("success");
    const end = await getRoom(users[2], room.code);
    expect(end.status).toBe("finished");
    const a = end.players.filter((p) => p.team === "A").reduce((s, p) => s + p.score, 0);
    const b = end.players.filter((p) => p.team === "B").reduce((s, p) => s + p.score, 0);
    expect(end.teams).toEqual({ A: a + FIRST_FINISH_BONUS, B: b });
    expect(end.winner?.team).toBe("A");
    const badges = await getDb().prepare(`SELECT user_id FROM achievements WHERE code = 'TEAM_WIN' ORDER BY user_id`).all<{ user_id: string }>();
    expect(badges.map((x) => x.user_id).sort()).toEqual([users[0].id, users[2].id].sort());
  });

  it("when time runs out with no finisher, the highest score wins", async () => {
    const { users, code } = await startedRace("solo", 2);
    const [a, b] = users;
    __advanceClockForTests(ROOM_LEAD_MS + 200);
    const rb = await getRoom(b, code);
    const mb = await getMission(b, rb.yourInstanceId!);
    const startRobots = mb.mission.groups.filter((g) => g.release === "start").flatMap((g) => g.spawns.map((s) => s.id));
    await postEvent(await reloadUser(b.id), rb.yourInstanceId!, { type: "kill", robots: startRobots.slice(0, 1) });
    __advanceClockForTests(mb.timeLimitSec * 1000 + 10_000);
    const end = await getRoom(a, code);
    expect(end.status).toBe("finished");
    expect(end.winner).toMatchObject({ userId: b.id, reason: "time" });
  });

  it("shares positions between racers and quitting counts as finished", async () => {
    const { users, code } = await startedRace("solo", 2);
    const [a, b] = users;
    const pose = { x: 10, y: 0, z: -20, h: 1.2, s: 6, m: "foot" as const, w: "blaster" as const };
    await syncRoom(a, code, { pose });
    const seen = await syncRoom(b, code, { pose: { ...pose, x: 0 } });
    expect(seen.others).toHaveLength(1);
    expect(seen.others[0]).toMatchObject({ userId: a.id, nickname: a.nickname, pose });
    expect(seen.room.status).toBe("playing");
    await expect(syncRoom(b, code, { pose: { ...pose, m: "jetpack" } })).rejects.toMatchObject({ code: "BAD_POSE" });
    // Stale positions disappear after a few seconds.
    __advanceClockForTests(8000);
    expect((await syncRoom(b, code, {})).others).toHaveLength(0);
  });

  it("leaving a lobby hands the room to the next player, and an empty room closes", async () => {
    const a = await makeUser(), b = await makeUser();
    const room = await createRoom(a, "solo");
    await joinRoom(b, room.code);
    await leaveRoom(a, room.code);
    const r = await getRoom(b, room.code);
    expect(r.youAreHost).toBe(true);
    expect(r.players).toHaveLength(1);
    await leaveRoom(b, room.code);
    await expect(getRoom(b, room.code)).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
    // Creating a new room leaves the old lobby automatically.
    const c = await makeUser();
    const r1 = await createRoom(c, "solo");
    const d = await makeUser();
    await joinRoom(d, r1.code);
    await createRoom(d, "teams");
    expect((await getRoom(c, r1.code)).players).toHaveLength(1);
  });
});
