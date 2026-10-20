/*
 * Shared-event missions: every participant who types the code plays the identical
 * mission, and it has its own leaderboard.
 *
 *   npm run event -- create --name "Science Fair Finale" --band 2 --minutes 90
 *   npm run event -- list
 *   npm run event -- close CODE
 *
 * Works while the game server is running, and against Supabase when DATABASE_URL is set.
 */
import "./env";
import { BAND_LABELS, type Band } from "../src/lib/engine/types";
import type { EventRow } from "../src/lib/services/missions";
import { admin } from "./admin-client";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};
const fmt = (t: number) => new Date(t).toLocaleString();

async function main(): Promise<void> {
  if (cmd === "create") {
    const ev = await admin<EventRow>("event.create", {
      name: flag("name", "GLITCH PROTOCOL Event"),
      band: Number(flag("band", "2")),
      minutes: Number(flag("minutes", "120")),
      startsInMin: Number(flag("starts-in", "0")),
    });
    console.log(`\n  EVENT CODE:  ${ev.code}\n`);
    console.log(`  ${ev.name} · threat ${ev.band} (${BAND_LABELS[ev.band as Band]}) · open ${fmt(ev.starts_at)} → ${fmt(ev.ends_at)}`);
    console.log(`  Players type this code in the Hub under "Event check karo". Everyone gets the same mission.\n`);
  } else if (cmd === "list") {
    const list = await admin<EventRow[]>("event.list");
    if (!list.length) console.log('No events yet. Create one with: npm run event -- create --name "My Event" --band 2 --minutes 90');
    for (const e of list) {
      const live = e.active === 1 && Date.now() >= e.starts_at && Date.now() <= e.ends_at;
      console.log(`${e.code}  ${live ? "LIVE  " : e.active ? "ready " : "closed"}  band ${e.band}  ${e.name}  (${fmt(e.starts_at)} → ${fmt(e.ends_at)})`);
    }
  } else if (cmd === "close") {
    const code = rest[0];
    if (!code) throw new Error("Usage: npm run event -- close CODE");
    console.log((await admin<boolean>("event.close", { code })) ? `Closed ${code.toUpperCase()}.` : `No event with code ${code}.`);
  } else {
    console.log('Usage:\n  npm run event -- create --name "Name" --band 1-5 --minutes 90 [--starts-in 10]\n  npm run event -- list\n  npm run event -- close CODE');
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
