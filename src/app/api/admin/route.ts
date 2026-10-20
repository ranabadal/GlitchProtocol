import { timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { heldLockKey } from "@/lib/dblock";
import { HttpError, json, route } from "@/lib/http";
import { AdminError, runAdmin, type AdminAction } from "@/lib/services/admin";

export const dynamic = "force-dynamic";

/*
 * Operator commands from `npm run event / reset-password / db:backup` on this same computer,
 * used only when the built-in database is open in this server. The key comes from
 * data/pglite.lock, which only someone with access to this computer's files can read.
 * Never available on hosted deployments or with DATABASE_URL (scripts connect directly then).
 */
export const POST = route(async (req) => {
  if (process.env.VERCEL || config.databaseUrl) throw new HttpError(404, "NOT_FOUND", "Not found.");
  await getDb().ready;
  const expected = heldLockKey();
  const given = req.headers.get("x-admin-key") ?? "";
  if (!expected || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    throw new HttpError(403, "FORBIDDEN", "Not allowed.");
  }
  const body = (await req.json().catch(() => null)) as { action?: AdminAction; args?: Record<string, unknown> } | null;
  if (!body?.action) throw new HttpError(400, "BAD_REQUEST", "Missing action.");
  try {
    return json({ result: await runAdmin(body.action, body.args ?? {}) });
  } catch (e) {
    if (e instanceof AdminError) throw new HttpError(400, "ADMIN_ERROR", e.message);
    throw e;
  }
});
