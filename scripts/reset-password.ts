/*
 * A player forgot their password:   npm run reset-password -- <nickname or participant ID> <new password>
 * Signs them out everywhere and sets the new password. Works while the game server is running.
 */
import "./env";
import { admin } from "./admin-client";

async function main(): Promise<void> {
  const [ident, password] = process.argv.slice(2);
  if (!ident || !password) throw new Error("Usage: npm run reset-password -- <nickname or participant ID> <new password>");
  const r = await admin<{ nickname: string; participantId: string }>("password.reset", { ident, password });
  console.log(`Password reset for ${r.nickname} (${r.participantId}). They can log in now.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
