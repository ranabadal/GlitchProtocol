import { config } from "../src/lib/config";
import { __setDbForTests, getDb } from "../src/lib/db";
import { liveLock } from "../src/lib/dblock";
import { AdminError, runAdmin, type AdminAction } from "../src/lib/services/admin";

/**
 * Runs an operator command. With Supabase (DATABASE_URL) it talks to the database directly.
 * With the built-in database, if the game server is running it sends the command to the
 * server (only one program may open that database); otherwise it opens it directly.
 */
export async function admin<T>(action: AdminAction, args: Record<string, unknown> = {}): Promise<T> {
  if (!config.databaseUrl) {
    const lock = liveLock(config.databasePath);
    if (lock?.role === "server") {
      const ports = [...new Set([process.env.GP_PORT, lock.port, "3000"].filter(Boolean))] as string[];
      let lastErr: unknown = null;
      for (const port of ports) for (const host of ["127.0.0.1", "localhost"]) {
        let res: Response;
        try {
          res = await fetch(`http://${host}:${port}/api/admin`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-admin-key": lock.key },
            body: JSON.stringify({ action, args }),
          });
        } catch (e) {
          lastErr = e;
          continue;
        }
        const body = (await res.json().catch(() => ({}))) as { result?: T; error?: { message?: string } };
        if (!res.ok) throw new AdminError(body.error?.message ?? `Game server answered HTTP ${res.status}`);
        return body.result as T;
      }
      throw new AdminError(
        `The game server (process ${lock.pid}) has the database open but could not be reached on port ${ports.join("/")}. ` +
          `If it runs on another port, add GP_PORT=<port> before the command. (${lastErr instanceof Error ? lastErr.message : lastErr})`,
      );
    }
  }
  try {
    return (await runAdmin(action, args)) as T;
  } finally {
    // Close cleanly so the built-in database is saved and unlocked for the game server.
    await getDb().close().catch(() => {});
    __setDbForTests(undefined as never);
  }
}
