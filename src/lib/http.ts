import { randomUUID } from "node:crypto";
import { SESSION_COOKIE, sessionUser } from "./auth";
import { getDb } from "./db";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response> | Response;

/** Wraps a route handler: same-origin check on writes, and errors as JSON. */
export function route<C = unknown>(handler: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req);
      return await handler(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: { code: err.code, message: err.message, ...err.extra } }, { status: err.status });
      }
      const ref = randomUUID().slice(0, 8);
      console.error(`[glitch] ${req.method} ${new URL(req.url).pathname} failed (ref ${ref})`, err);
      return json({ error: { code: "SERVER_ERROR", message: `Server mein gadbad hui. Reference ${ref}.` } }, { status: 500 });
    }
  };
}

/**
 * Browsers always send Origin on cross-site POSTs, so a mismatch means another site
 * is trying to act with the player's cookie. Requests without Origin (scripts, tests)
 * are allowed; the SameSite=Lax cookie already blocks cross-site form posts.
 */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, "BAD_ORIGIN", "Request origin not allowed.");
  }
  if (!host || originHost !== host) throw new HttpError(403, "BAD_ORIGIN", "Request origin not allowed.");
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function isSecure(req: Request): boolean {
  const proto = req.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim() === "https";
  return new URL(req.url).protocol === "https:";
}

export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : req.headers.get("x-real-ip")) || "local";
}

export async function readJson(req: Request, maxBytes = 16_000): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new HttpError(413, "TOO_LARGE", "Request body is too large.");
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "TOO_LARGE", "Request body is too large.");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "BAD_JSON", "Request body must be valid JSON.");
  }
}

export interface UserRow {
  id: string;
  participant_id: string;
  nickname: string;
  nickname_key: string;
  password_hash: string;
  avatar_id: string;
  photo_file: string | null;
  show_photo: number;
  difficulty_pref: string;
  xp: number;
  level: number;
  created_at: number;
  last_login_at: number | null;
}

/** Every user column except the photo bytes (those are only read by the photo route). */
export const USER_COLS = "id, participant_id, nickname, nickname_key, password_hash, avatar_id, photo_file, show_photo, difficulty_pref, xp, level, created_at, last_login_at";

export function sessionToken(req: Request): string | null {
  return readCookie(req, SESSION_COOKIE);
}

export async function optionalUser(req: Request): Promise<UserRow | null> {
  return sessionUser<UserRow>(sessionToken(req), USER_COLS);
}

export async function loadUser(id: string): Promise<UserRow> {
  const u = await getDb().prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get<UserRow>(id);
  if (!u) throw new HttpError(401, "NOT_SIGNED_IN", "Aage badhne ke liye login karo.");
  return u;
}

export async function requireUser(req: Request): Promise<UserRow> {
  const user = await optionalUser(req);
  if (!user) throw new HttpError(401, "NOT_SIGNED_IN", "Aage badhne ke liye login karo.");
  return user;
}
