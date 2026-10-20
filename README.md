# GLITCH PROTOCOL — Neon City

**NULL ne Neon City hack kar li hai.** A rogue AI has locked the city's data inside vaults guarded by robots. Players drive through a 3D neon city, fight NULL's robot army, break into vault lobbies, crack a 10–16 second hologram hack at each terminal, grab the data cores and hold an uplink tower while the upload runs. A mission takes 3–5 minutes.

Built for a school science fair (classes 5–12): Hinglish text, keyboard + mouse. Two ways to run it:

- **On your own computer (default, works offline).** Other laptops on the same Wi-Fi join by opening this computer's address. Nothing to sign up for.
- **Online for free** with a Supabase database + Vercel hosting, so anyone with the link can play (section 3).

| What players do | How |
|---|---|
| Explore a whole city | 7 × 7 blocks of towers, roads, parks, plazas, traffic and pedestrians |
| Drive any car | Walk up to a car and press **F**. Shift = nitro, Space = handbrake drift |
| Fight robots | Walkers, drones, brutes and street-corner turrets. Blaster (heats up), **Q** EMP blast, or run them over |
| Get past hurdles | Barricaded roads (find another way), laser fences (shoot a pylon to drop them), alarm squads, robot patrols |
| Hack vaults | The three original challenge types as quick hologram hacks: **Data Stream Breach** (Pattern Breaker), **Firewall Bypass** (System Override), **Identity Scan** (Spot the Contradiction) |
| Finish the mission | Carry every core to the uplink tower and stay in the ring while the upload completes |

---

## 1. Setup (one time)

You need **Node.js 22.13 or newer** (Node 22 LTS or 24). `npm install` doesn't compile anything — no Visual Studio or build tools needed. The database is real PostgreSQL: on your computer it's a built-in copy (PGlite) stored in the `data/` folder, nothing to install; online it's your Supabase project.

```bash
# in the glitch-protocol folder
npm install
cp .env.example .env.local      # Windows: copy .env.example .env.local
```

Open `.env.local` and paste your Azure OpenAI values:

```
AZURE_OPENAI_API_KEY=...your key...
AZURE_OPENAI_ENDPOINT=https://your-resource-name.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini
AZURE_OPENAI_VERSION=2025-01-01-preview
```

`.env.local` is git-ignored and only ever read by the server. The key is never sent to the browser (checked: a production build contains no trace of the key or endpoint). **The AI is optional** — leave the key blank or set `GP_DISABLE_AI=1` and every mission still works with the built-in story text.

## 2. Run it

| Use | Command | Open |
|---|---|---|
| Practice / development | `npm run dev` | http://localhost:3000 |
| **Event day (fast, stable)** | `npm run event-day` | http://localhost:3000 |

`npm run event-day` builds the optimised version and starts it on port 3000 for the whole local network. Other laptops can play at `http://<this-computer's-IP>:3000` (on Windows click **Allow** when the firewall asks).

**Graphics:** the game picks Low / Medium / High from the graphics chip and steps down automatically if the frame rate drops. Players can change it in the pause menu (Esc). Normal school laptops with built-in graphics run Medium. Use Chrome or Edge.

## 3. Put it online for free (Supabase + Vercel)

On your computer nothing changes. For hosting, the game keeps its data in your **Supabase** project (Vercel's servers have no lasting disk), and **Vercel** runs the website. Both have free plans.

> **Your Supabase connection string contains your database password.** Put it only in `.env.local` on your computer and in Vercel's *Environment Variables*. Never paste it into chats, screenshots, GitHub or code.

**A. Get the database address from Supabase**
1. Open your project on supabase.com → click **Connect** (top of the page) → pick **Transaction pooler** (port **6543**) → copy the URI. It looks like
   `postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-<n>-<region>.pooler.supabase.com:6543/postgres`
2. Replace `[YOUR-PASSWORD]` with your database password. Forgot it, or it has symbols like `@ # / ? % &`? Reset it (Project Settings → Database → *Reset database password*) to one with only letters and numbers.
3. Try it from your computer first: in `.env.local` set `DATABASE_URL=<that URI>`, run `npm run dev` and open http://localhost:3000/api/health. It should show `"ok":true,"database":"postgres"`. The game creates its tables by itself the first time. (Empty the line again to go back to the offline database — the two keep separate data.)

**B. Put the code on GitHub** — create a **private** repository and upload the project folder. `.env.local`, `data/` and `node_modules/` are listed in `.gitignore`, so your keys and local data stay on your computer. (Check on GitHub that `.env.local` is *not* there.)

**C. Deploy on Vercel**
1. vercel.com → sign up with GitHub (Hobby plan, free) → **Add New → Project** → import the repository. It detects Next.js; leave the build settings as they are.
2. Before clicking Deploy, open **Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the Supabase transaction-pooler URI with your password |
   | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_VERSION` | same as in `.env.local` (optional — or set `GP_DISABLE_AI` = `1`) |
   | `AI_DAILY_BUDGET` | e.g. `200` — caps AI calls per day now that anyone with the link can play |

3. **Deploy.** Then open `https://<your-project>.vercel.app/api/health`. `"ok":true,"database":"postgres"` means it's live. If it says `"database":"not connected: …"`, the message tells you what's wrong (wrong password, `[YOUR-PASSWORD]` still in the URL, …): fix the variable under **Settings → Environment Variables**, then **Deployments → ⋯ → Redeploy**.
4. **Speed:** every hack, pickup and kill talks to the database, so run the server next to it. Under **Settings → Functions → Function Regions** choose the region of your Supabase project (Mumbai `bom1` if Supabase is in `ap-south-1`, Mumbai), then redeploy. Vercel's default is Washington D.C.

If you add Supabase through Vercel's Supabase integration instead, it sets `POSTGRES_URL` for you; the game uses that automatically when `DATABASE_URL` isn't set.

**Running the online version:** keep the same `DATABASE_URL` in `.env.local` on your laptop and `npm run event …`, `npm run reset-password …` and `npm run db:backup` work on the online database directly.

**Free-plan notes:** Supabase may pause a free project after about a week with no use — open the dashboard and restore it, and play a round a day before the fair. Vercel's Hobby plan is for personal, non-commercial projects (a school fair is fine). If the school's internet is unreliable, the offline mode (section 2) is still the safest choice on the day.

## 4. Event-day checklist

1. **Before the fair:** `npm run event-day`, then in a second terminal run `npm run journey -- --rounds 3`. It plays complete missions over the network like a real player — register, profile, briefing, resume, robots, a deliberately wrong hack (alarm squad), resent events, early-upload refusals, upload, result + debrief, leaderboards, logout/login, an abandoned mission — and must end with `ALL GOOD: ... checks passed`. Its test accounts delete themselves.
2. **Play one mission yourself** on the event laptop to warm up the graphics driver.
3. **Shared event (everyone plays the identical mission, own leaderboard):**
   ```bash
   npm run event -- create --name "Science Fair Finale" --band 2 --minutes 90
   npm run event -- list
   npm run event -- close CODE
   ```
   Players type the code in the Hub under “Event check karo”. Each player gets one attempt.
4. **A player forgot their password:** `npm run reset-password -- NeonRider newpass123` (nickname or participant ID).
5. **Backup during the day:** `npm run db:backup` (writes one JSON file to `data/backups/`).

These commands work while the game is running — run them in a second terminal. (The built-in database can only be open in one program, so they pass the command to the running game server automatically.)
6. **If the internet/AI goes down:** nothing to do. Missions, scoring and leaderboards never wait on the AI.

## 5. How a mission is made (and why it's fair)

- **Fixed city, unique missions.** Neon City's layout is generated from a constant seed, so the browser and the server agree on every road and building. Each mission is generated on the server from a fresh seed: which safehouse you start at, which buildings are vaults, the uplink tower, barricaded roads, laser fences, turrets, robot squads and every hack puzzle.
- **Validated before you see it.** A validator checks that every vault and the uplink can be reached around the barricades, that the best route fits the timer with room to spare, that no robot spawns inside a wall, and that every hack puzzle has **exactly one** correct answer. Invalid candidates are regenerated; if generation ever fails, a verified bank of known-good missions is used.
- **Stored and repeat-free.** Each mission instance is saved in the database with its seed, template version, band, inputs, ruleset version, answer key and timestamps; refreshing the page brings back the exact same mission and progress. Fingerprints of each player's past missions keep new ones from repeating.
- **Adaptive, transparently.** Threat level 1–5 (Rookie → Legend) moves up after winning streaks and down after losing streaks. The rules are shown on the Profile page (Steady / Balanced / Bold pace). Hacks you failed recently show up more often, for practice.
- **The server is the referee.** The browser only reports events (hack started/answered, core picked up, robot destroyed, life lost, upload started/finished). The server checks order (hack before core, all cores before upload), judges every hack answer itself, rejects robots that weren't deployed yet, caps kills per second, refuses impossible travel times (nobody can cross the city faster than a car), and enforces the mission clock. Resent events never count twice.

**Scoring** (all × band multiplier ×1.0 / 1.25 / 1.5 / 1.75 / 2.0): data core 400 · hack 1st try 150 + up to 150 speed bonus · 2nd try 75 + up to 75 · 3rd try 40 · robot: walker 40, drone 30, brute 120, turret 80 · mission clear 1000 + 4 per second left · flawless (no lives lost) 400. A failed mission keeps what you earned but gets no clear/time/flawless bonus. Three failed hacks open the vault by brute force after 10 seconds (no hack points).

**Leaderboards** are kept separate so like is compared with like: Overall (personal missions), Threat level (best clear per band), and Event (the shared mission).

## 6. What the AI does (and doesn't)

The AI (Azure OpenAI, `gpt-4o-mini`) writes:
- the mission briefing and NULL's taunts (one pack per threat level + theme, cached and reused, so a whole fair needs only a few dozen calls);
- the personal debrief after each mission (what went well, one failed hack explained simply, one tip).

It **never** decides puzzles, answers, robots, routes, scores, XP or difficulty, and never sees passwords or photos. Every request has a timeout, a daily budget, a per-player hourly cap and a circuit breaker, and must return strict JSON that passes validation — anything else falls back to the built-in Hinglish text instantly.

## 7. Accounts and privacy

- Players choose a nickname, password and emblem; they get a **Participant ID** (like `GP-7KQ2-M9XA`) for logging in. No email, phone or real name is asked.
- Passwords are hashed with scrypt; sessions are random tokens stored hashed, in an HttpOnly SameSite cookie; repeated wrong passwords lock the name for 10 minutes; requests from other websites are rejected.
- **Photos are optional.** Uploads are re-encoded to a 256 × 256 WebP, which removes EXIF/GPS/camera data, stored inside the database (never in a public folder), and shown only to the owner unless they switch “show photo” on. Players can remove their photo or delete their whole account (with password) at any time.

## 8. Tests

```bash
npm test             # 54 automated tests (mission engine, platform, client engine)
npm run typecheck
npm run journey      # full HTTP journey against a running server
```

Tests use an in-memory Postgres, so they never touch your data. To run them against a real Postgres server instead: `TEST_DATABASE_URL=postgres://… npx vitest run --no-file-parallelism` (use an empty database — tests wipe it).

The mission-engine tests cover the required checks: different valid missions for different players; a stored seed recreating the same mission; an active mission unchanged after refresh and database restart; invalid missions rejected; no duplicate rewards (including concurrent reports); repetition minimised; adaptive rules followed; shared events identical for everyone; everything working with the AI unavailable, hanging or returning junk — plus anti-teleport, objective order, alarms/brute force, timeouts and kill-rate caps. Platform tests cover accounts, sessions, cross-site requests, photo privacy and metadata stripping, what the browser can see, documented scoring and separate leaderboards. Client tests check that the merged robot model animates exactly like the original and the ray/collision maths used for shooting and line of sight.

## 9. Controls

| Key | Action |
|---|---|
| W A S D / arrows | Move / drive |
| Mouse | Look and aim (click the game once to capture the mouse) |
| Left click | Fire blaster (it overheats — let it cool) |
| Right click | Aim / zoom |
| Shift | Sprint / nitro |
| Space | Jump / handbrake |
| F | Get in or out of any car |
| E | Hack a vault terminal |
| Q | EMP blast (stuns robots, drops drones) |
| M or Tab | City map |
| H | Horn |
| Esc | Pause (the mission clock keeps running on the server) |

In a hack: click (or use number keys / arrows + Enter). Firewall Bypass: click tiles to rotate them; it submits by itself when power reaches the lock.

## 10. Project layout

```
src/app/                 pages (welcome, register, login, hub, play, leaderboard, profile, rules) and API routes
src/components/          shared UI, HUD, minimap/map, hack overlays, results
src/game/                the 3D engine (three.js)
  Game.ts                renderer, frame loop, quality, attract-mode flyover
  world/                 city (instanced towers, shader windows, signs, code rain), sky, mission props
  actors/                player, cars + traffic, crowd, robots (+ model merge)
  mission/Director.ts    objectives, hacks, alarms, uplink, lives — talks to the server through a bridge
  fx/, audio/            particles, post-processing (bloom, glitch), synthesised sound and music
src/lib/shared/          code shared by browser and server: city layout, mission types, circuit logic
src/lib/engine/          mission generator, validation, hacks, adaptive difficulty, scoring, verified bank
src/lib/services/        missions (event state machine), users, leaderboards, events, achievements
src/lib/ai/              Azure OpenAI client with budgets, caching, breaker, strict schemas
src/lib/db.ts            Postgres access: Supabase via `pg`, or the built-in PGlite; migrations
scripts/                 journey, event, reset-password, db-backup, build-bank
tests/                   vitest suites
```

Offline mode keeps everything (players, missions, photos) in `data/pglite/`, which is git-ignored.

## 11. Troubleshooting

- **Black screen or very slow:** update Chrome/Edge, make sure hardware acceleration is on (chrome://settings → System), choose Low in the pause menu.
- **Mouse doesn't turn the camera:** click inside the game once. After Esc, wait a second before clicking Resume (browsers block re-capturing the mouse instantly).
- **Port 3000 is busy:** `npx next start -p 3001` (after `npm run build`).
- **`npm install` shows `EPERM ... operation not permitted` (Windows):** something is holding files in `node_modules` — stop any running `npm run dev`/`event-day`, close VS Code/other terminals in the folder, delete the `node_modules` folder, and run `npm install` again (if it still happens, pause antivirus for the folder or move the project out of Downloads, e.g. `C:\glitch-protocol`).
- **"The game database is already open in another running game server":** only one game server can use the offline database. Close the other `npm run dev` / `npm run event-day` window. If none is running (e.g. after a crash), delete `data/pglite.lock`.
- **Online version shows errors:** open `/api/health` on your site — it says whether the database is connected and why not. Vercel → your project → **Logs** shows details.
- **Players from an older version are missing:** this version uses a new database (Postgres instead of SQLite), so it starts empty. The old `data/glitch.db` file isn't used any more and can be deleted.
- **Photo upload says unavailable:** the optional image library (sharp) didn't install; the game still works with emblems. Run `npm install` again to retry.
- **Start fresh (offline mode):** stop the server and delete the `data/` folder. Online: Supabase → Table Editor, or create a new project.

## Credits

- Robot model “RobotExpressive” by Tomás Laulhé (Quaternius), modified by Don McCurdy — CC0 1.0. See `public/models/CREDITS.txt`.
- Fonts: Oxanium, Rajdhani, Share Tech Mono (SIL Open Font License) via Fontsource.
- Everything else — city, cars, people, drones, turrets, signs, effects, music and sound — is generated in code.
