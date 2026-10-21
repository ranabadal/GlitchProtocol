import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as logoutRoute } from "@/app/api/auth/logout/route";
import { POST as registerRoute } from "@/app/api/auth/register/route";
import { DELETE as deleteAccountRoute } from "@/app/api/account/route";
import { GET as leaderboardRoute } from "@/app/api/leaderboard/route";
import { GET as meRoute } from "@/app/api/me/route";
import { GET as missionRoute } from "@/app/api/missions/[id]/route";
import { POST as eventRoute } from "@/app/api/missions/[id]/event/route";
import { POST as startRoute } from "@/app/api/missions/start/route";
import { GET as photoRoute } from "@/app/api/photos/[userId]/route";
import { DELETE as photoDeleteRoute, POST as photoUploadRoute } from "@/app/api/profile/photo/route";
import { PATCH as profileRoute } from "@/app/api/profile/route";
import { __advanceClockForTests } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { corePoints, hackPoints, killPoints, SCORING } from "@/lib/engine/scoring";
import type { Band } from "@/lib/engine/types";
import { coreIds } from "@/lib/shared/mission";
import { createEvent } from "@/lib/services/events";
import { overallBoard, eventBoard } from "@/lib/services/leaderboard";
import { startMission } from "@/lib/services/missions";
import { cookieFrom, freshDb, makeUser, params, playMission, playStarted, reloadUser, req, SITE } from "./helpers";

/*
 * Platform checks: accounts and sessions, request origin, privacy of photos and
 * personal data, what the browser can see of a mission, the documented scoring, and
 * the separate leaderboards.
 */

beforeEach(async () => { await freshDb(); });

async function signUp(nickname: string, password = "secret-pass-1") {
  const res = await registerRoute(req("POST", "/api/auth/register", { nickname, password, avatarId: "nova" }), {});
  return { res, cookie: cookieFrom(res), body: await res.json() };
}

describe("accounts and sessions", () => {
  it("registers with a participant ID, hashes the password and sets a safe session cookie", async () => {
    const { res, body } = await signUp("NeonRider");
    expect(res.status).toBe(201);
    expect(body.user.participantId).toMatch(/^GP-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    const row = (await getDb().prepare(`SELECT password_hash FROM users WHERE nickname = ?`).get<{ password_hash: string }>("NeonRider"))!;
    expect(row.password_hash.startsWith("scrypt$")).toBe(true);
    expect(row.password_hash).not.toContain("secret-pass-1");
    // Sessions are stored hashed, never as the raw token.
    const token = cookieFrom(res).split("=")[1];
    expect(await getDb().prepare(`SELECT 1 FROM sessions WHERE token_hash = ?`).get(token)).toBeUndefined();
  });

  it("nicknames are unique regardless of case, and bad input gets a friendly message", async () => {
    await signUp("Pixel");
    const dup = await signUp("pixel");
    expect(dup.res.status).toBe(409);
    expect(dup.body.error.code).toBe("NICKNAME_TAKEN");
    const short = await signUp("ab");
    expect(short.res.status).toBe(400);
    expect(typeof short.body.error.message).toBe("string");
  });

  it("logs in by nickname or participant ID, rejects wrong passwords, and logout ends the session", async () => {
    const { body } = await signUp("Volt7");
    const bad = await loginRoute(req("POST", "/api/auth/login", { identifier: "volt7", password: "nope-nope" }), {});
    expect(bad.status).toBe(401);
    const byPid = await loginRoute(req("POST", "/api/auth/login", { identifier: body.user.participantId.toLowerCase(), password: "secret-pass-1" }), {});
    expect(byPid.status).toBe(200);
    const cookie = cookieFrom(byPid);
    expect((await meRoute(req("GET", "/api/me", undefined, cookie), {})).status).toBe(200);
    await logoutRoute(req("POST", "/api/auth/logout", {}, cookie), {});
    expect((await meRoute(req("GET", "/api/me", undefined, cookie), {})).status).toBe(401);
  });

  it("locks a name after repeated wrong passwords", async () => {
    await signUp("Cipher");
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await loginRoute(req("POST", "/api/auth/login", { identifier: "cipher", password: "wrong-pass-x" }), {})).status;
    expect(last).toBe(429);
  });

  it("sessions expire", async () => {
    const { cookie } = await signUp("Echo1");
    __advanceClockForTests(13 * 3600_000);
    expect((await meRoute(req("GET", "/api/me", undefined, cookie), {})).status).toBe(401);
  });

  it("rejects writes from another website (cross-origin POST)", async () => {
    const { cookie } = await signUp("Rook9");
    const res = await startRoute(req("POST", "/api/missions/start", { mode: "personal" }, cookie, { origin: "https://evil.example" }), {});
    expect(res.status).toBe(403);
    const ok = await startRoute(req("POST", "/api/missions/start", { mode: "personal" }, cookie, { origin: SITE }), {});
    expect(ok.status).toBe(200);
  });

  it("deleting an account needs the password and removes the player's data", async () => {
    const { cookie, body } = await signUp("Ember2");
    expect((await deleteAccountRoute(req("DELETE", "/api/account", { password: "wrong" }, cookie), {})).status).toBe(401);
    expect((await deleteAccountRoute(req("DELETE", "/api/account", { password: "secret-pass-1" }, cookie), {})).status).toBe(200);
    expect(await getDb().prepare(`SELECT 1 FROM users WHERE id = ?`).get(body.user.id)).toBeUndefined();
    expect(await getDb().prepare(`SELECT 1 FROM sessions WHERE user_id = ?`).get(body.user.id)).toBeUndefined();
  });
});

describe("profile photos are private and cleaned", () => {
  async function jpegWithExif(): Promise<Buffer> {
    return sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 40, b: 90 } } })
      .jpeg()
      .withExif({ IFD0: { Make: "SecretCam", Model: "Spy-9000", Artist: "Real Name Here" } })
      .toBuffer();
  }

  function upload(buf: Buffer, cookie: string, type = "image/jpeg") {
    const fd = new FormData();
    fd.append("photo", new Blob([new Uint8Array(buf)], { type }), "me.jpg");
    return photoUploadRoute(new Request(SITE + "/api/profile/photo", { method: "POST", body: fd, headers: { cookie, host: "localhost:3000" } }), {});
  }

  const storedPhoto = async (userId: string) =>
    (await getDb().prepare(`SELECT photo_file, photo_data FROM users WHERE id = ?`).get<{ photo_file: string | null; photo_data: Uint8Array | null }>(userId))!;

  it("re-encodes uploads to a small WebP with no camera metadata, kept in the database (not a public folder)", async () => {
    const { cookie, body } = await signUp("Shutter");
    const original = await jpegWithExif();
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const res = await upload(original, cookie);
    expect(res.status).toBe(200);
    const row = await storedPhoto(body.user.id);
    expect(row.photo_data).toBeTruthy();
    const bytes = Buffer.from(row.photo_data!);
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(256);
    expect(meta.exif).toBeUndefined();
    expect(bytes.includes(Buffer.from("SecretCam"))).toBe(false);
    // What the photo route serves is that same cleaned image.
    const served = Buffer.from(await (await photoRoute(req("GET", `/api/photos/${body.user.id}`, undefined, cookie), params({ userId: body.user.id }))).arrayBuffer());
    expect(served.equals(bytes)).toBe(true);
  });

  it("only the owner sees a photo until they opt in; non-images are refused; removing deletes it", async () => {
    const owner = await signUp("Lens");
    const other = await signUp("Viewer");
    await upload(await jpegWithExif(), owner.cookie);
    const url = `/api/photos/${owner.body.user.id}`;
    expect((await photoRoute(req("GET", url, undefined, owner.cookie), params({ userId: owner.body.user.id }))).status).toBe(200);
    expect((await photoRoute(req("GET", url, undefined, other.cookie), params({ userId: owner.body.user.id }))).status).toBe(404);
    expect((await photoRoute(req("GET", url), params({ userId: owner.body.user.id }))).status).toBe(401);
    await profileRoute(req("PATCH", "/api/profile", { showPhoto: true }, owner.cookie), {});
    expect((await photoRoute(req("GET", url, undefined, other.cookie), params({ userId: owner.body.user.id }))).status).toBe(200);
    const notImage = await upload(Buffer.from("<script>alert(1)</script>"), owner.cookie, "image/png");
    expect(notImage.status).toBe(415);
    expect((await storedPhoto(owner.body.user.id)).photo_data).toBeTruthy();
    await photoDeleteRoute(new Request(SITE + "/api/profile/photo", { method: "DELETE", headers: { cookie: owner.cookie, host: "localhost:3000" } }), {});
    expect(await storedPhoto(owner.body.user.id)).toEqual({ photo_file: null, photo_data: null });
    expect((await photoRoute(req("GET", url, undefined, other.cookie), params({ userId: owner.body.user.id }))).status).toBe(404);
  });

  it("the leaderboard never exposes passwords, participant IDs or hidden photos", async () => {
    const u = await makeUser("Quiet1");
    await playMission(u.id);
    const { cookie } = await signUp("Looker");
    const res = await leaderboardRoute(req("GET", "/api/leaderboard", undefined, cookie), {});
    const text = JSON.stringify(await res.json());
    expect(text).toContain("Quiet1");
    expect(text).not.toContain(u.participant_id);
    expect(text).not.toContain("scrypt$");
    expect(text).not.toContain("/api/photos/");
  });
});

describe("what the browser can see of a mission", () => {
  it("the mission view carries no hack answers, and a puzzle appears only once its hack starts", async () => {
    const { cookie } = await signUp("Peeker");
    const start = await startRoute(req("POST", "/api/missions/start", { mode: "personal" }, cookie), {});
    const view = await start.json();
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/"(answerKey|mission_key|solution|imposter|glitch)":/);
    expect(text).not.toContain('"key"');
    expect(text).not.toContain('"round"');
    expect(view.mission.vaults[0].hackType).toBeTruthy();
    const got = await missionRoute(req("GET", `/api/missions/${view.id}`, undefined, cookie), params({ id: view.id }));
    expect(JSON.stringify(await got.json())).not.toContain('"solution"');
  });

  it("garbage, oversized or unknown events are rejected without changing the mission", async () => {
    const u = await makeUser();
    const v = await startMission(u, { mode: "personal" });
    const { cookie } = await (async () => { const r = await loginRoute(req("POST", "/api/auth/login", { identifier: u.nickname, password: "correct horse battery" }), {}); return { cookie: cookieFrom(r) }; })();
    const bad = [{ type: "teleport" }, { type: "kill", robots: [] }, { type: "kill", robots: Array(50).fill("r1") }, "not json object", { type: "pickup", vault: "v99" }];
    for (const b of bad) {
      const res = await eventRoute(req("POST", `/api/missions/${v.id}/event`, b, cookie), params({ id: v.id }));
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    const huge = await eventRoute(req("POST", `/api/missions/${v.id}/event`, { type: "kill", robots: ["x".repeat(20000)] }, cookie), params({ id: v.id }));
    expect(huge.status).toBe(413);
  });

  it("another player cannot read or act on your mission", async () => {
    const a = await signUp("Owner1");
    const b = await signUp("Intruder");
    const view = await (await startRoute(req("POST", "/api/missions/start", { mode: "personal" }, a.cookie), {})).json();
    expect((await missionRoute(req("GET", `/api/missions/${view.id}`, undefined, b.cookie), params({ id: view.id }))).status).toBe(404);
    expect((await eventRoute(req("POST", `/api/missions/${view.id}/event`, { type: "uplink_start" }, b.cookie), params({ id: view.id }))).status).toBe(404);
  });
});

describe("scoring follows the documented rules", () => {
  it("a clean clear scores cores + hacks + robots + clear + time + flawless, times the band multiplier", async () => {
    const u = await makeUser();
    const view = await playMission(u.id);
    expect(view.result?.outcome).toBe("success");
    const b = view.result!.breakdown as Record<string, number>;
    const m = { ...view.mission, band: view.mission.band as Band };
    expect(b.corePoints).toBe(coreIds(m).length * corePoints(m.band));
    const startRobots = m.groups.filter((g) => g.release === "start").flatMap((g) => g.spawns).map((s) => killPoints(m.band, s.kind)).reduce((a, x) => a + x, 0);
    expect(b.killPoints).toBe(startRobots + (m.courier ? killPoints(m.band, "courier") : 0));
    const hackVaults = m.vaults.filter((v) => v.lock !== "titan");
    expect(b.hackPoints).toBeGreaterThanOrEqual(hackVaults.reduce((n, v) => n + hackPoints(m.band, 0, v.hackTimeMs, v.hackTimeMs), 0));
    expect(b.clear).toBe(Math.round(SCORING.clear * SCORING.bandMultiplier[m.band]));
    expect(b.flawless).toBe(Math.round(SCORING.flawless * SCORING.bandMultiplier[m.band]));
    expect(b.time).toBe(Math.round(b.secondsLeft * SCORING.perSecondLeft * SCORING.bandMultiplier[m.band]));
    expect(view.result!.score).toBe(b.corePoints + b.hackPoints + b.killPoints + b.shardPoints + b.clear + b.time + b.flawless);
    expect((await reloadUser(u.id)).xp).toBe(view.result!.score);
  });

  it("a failed mission keeps earned points but gets no clear, time or flawless bonus", async () => {
    const u = await makeUser();
    const view = await playMission(u.id, { downs: 3 });
    expect(view.result?.outcome).toBe("fail");
    const b = view.result!.breakdown as Record<string, number>;
    expect(b.clear + b.time + b.flawless).toBe(0);
    expect(view.result!.score).toBe(b.killPoints + b.corePoints + b.hackPoints);
  });
});

describe("leaderboards stay separate", () => {
  it("event attempts count only on the event board; personal attempts only on the overall board", async () => {
    const ev = await createEvent({ name: "Science Fair", band: 2, minutes: 60 });
    const a = await makeUser("Alpha1");
    const b = await makeUser("Bravo2");
    await playMission(a.id);
    const evView = await startMission(b, { mode: "event", eventCode: ev.code });
    const { beginMission } = await import("@/lib/services/missions");
    await beginMission(await reloadUser(b.id), evView.id);
    __advanceClockForTests(3100);
    await playStarted(b.id, evView.id, evView.mission);
    const overall = (await overallBoard(a.id)).map((r) => r.nickname);
    expect(overall).toContain("Alpha1");
    expect(overall).not.toContain("Bravo2");
    const eventRows = (await eventBoard(a.id, ev.id)).map((r) => r.nickname);
    expect(eventRows).toEqual(["Bravo2"]);
  });
});
