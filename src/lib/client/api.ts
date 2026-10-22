"use client";

import type { MePayload } from "@/lib/services/users";
import type { MissionView, EventOutcome } from "@/lib/services/missions";
import type { Pose, RemotePose, RoomView } from "@/lib/services/rooms";

/*
 * Browser-side API helper. Every call goes to this app's own server (same origin);
 * no secret ever reaches the browser. Errors come back as ApiError with the server's
 * Hinglish message, ready to show.
 */

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const { json, timeoutMs = 15000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      signal: ctrl.signal,
      credentials: "same-origin",
      headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Server se connection nahi ho paaya. Wi-Fi / server check karo.");
  } finally {
    clearTimeout(timer);
  }
  let data: unknown = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string } & Record<string, unknown> } | null)?.error;
    throw new ApiError(res.status, e?.code ?? "HTTP_" + res.status, e?.message ?? "Kuch gadbad ho gayi. Dobara try karo.", e ?? {});
  }
  return data as T;
}

export type Me = MePayload;
export type Mission = MissionView & { outcome?: EventOutcome };
export type { EventOutcome, MissionView };
export type Room = RoomView;
export type { Pose, RemotePose };

export const getMe = () => api<Me>("/api/me");
export const logout = () => api<{ ok: true }>("/api/auth/logout", { method: "POST", json: {} });
