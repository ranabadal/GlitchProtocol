/*
 * Backup of every table to one JSON file (built-in database or Supabase; safe while the game runs).
 *   npm run db:backup            -> data/backups/glitch-YYYYMMDD-HHMMSS.json
 * Supabase also keeps its own daily backups (Project -> Database -> Backups).
 */
import "./env";
import fs from "node:fs";
import path from "node:path";
import { admin } from "./admin-client";

async function main(): Promise<void> {
  const data = await admin<{ tables: Record<string, unknown[]> }>("backup");
  const dir = path.join(process.cwd(), "data", "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const file = path.join(dir, `glitch-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(data));
  console.log(`Backup written: ${file} (${data.tables.users.length} players, ${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
