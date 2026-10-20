import type { MissionPublic, Pt } from "@/lib/shared/mission";

/*
 * Contracts between the 3D engine and the React page. The engine never calls the
 * network directly: it asks the page (MissionBridge), which talks to the server and
 * returns the server's verdict. The page reads HudState snapshots to draw the HUD.
 */

export interface HackRequest {
  vault: string;
  attempt: number;
  type: "glitch" | "power" | "imposter";
  round: unknown;
  timeLimitMs: number;
  startedAt: number;
}

export interface HackVerdict {
  correct: boolean;
  timeout: boolean;
  points: number;
  explain: string;
  reveal: unknown;
  attemptsLeft: number;
  bruteUntil: number | null;
}

/** Server totals returned with every gameplay event. */
export interface Sync {
  score: number;
  lives: number;
  status: string;
}

export interface ServerProgress {
  lives: number;
  downs: number;
  unlocked: string[];
  picked: string[];
  released: string[];
  killed: string[];
  hacks: Record<string, { attempt: number; bruteUntil: number | null; active: { attempt: number; startedAt: number; round: unknown; type: string; timeLimitMs: number } | null }>;
  uplink: { startedAt: number | null; doneAt: number | null };
  score: number;
}

/** Errors from the bridge carry the server's code and a Hinglish message. */
export class BridgeError extends Error {
  constructor(public code: string, message: string, public retryable = false) {
    super(message);
  }
}

export interface MissionBridge {
  /** Server time minus local time, for timers. */
  clockOffset(): number;
  hackStart(vault: string): Promise<HackRequest>;
  /** Engine asks the page to show the hack overlay; resolves with the server's verdict. */
  runHack(req: HackRequest): Promise<HackVerdict & { sync: Sync }>;
  pickup(vault: string): Promise<Sync & { points: number }>;
  kills(ids: string[]): Promise<{ killed: { id: string; points: number }[]; sync: Sync }>;
  down(n: number): Promise<Sync>;
  uplinkStart(): Promise<Sync>;
  uplinkDone(): Promise<Sync>;
}

export type QualityLevel = "low" | "medium" | "high";

export interface Notice {
  id: number;
  text: string;
  tone: "good" | "bad" | "info" | "null";
  at: number;
}

export interface MapMarker {
  kind: "vault" | "vault-done" | "uplink" | "start" | "car" | "robot" | "barricade" | "fence" | "turret";
  x: number;
  z: number;
  label?: string;
}

export interface HudState {
  mode: "intro" | "foot" | "car" | "hack" | "dead" | "uplink" | "won" | "lost" | "paused";
  health: number;
  lives: number;
  heat: number;
  overheated: boolean;
  empReady: number;
  carHealth: number;
  speedKmh: number;
  objective: string;
  objectiveDist: number | null;
  cores: number;
  coresTotal: number;
  vaults: { id: string; name: string; state: "locked" | "open" | "taken" | "brute"; hackType: string }[];
  prompt: string | null;
  uplinkProgress: number | null;
  inUplinkZone: boolean;
  bruteProgress: number | null;
  score: number;
  hitMarker: number;
  damageDir: number | null;
  damageAt: number;
  notices: Notice[];
  nullLine: { text: string; at: number } | null;
  fps: number;
  quality: QualityLevel;
  player: Pt & { heading: number };
  route: Pt[];
  markers: MapMarker[];
  /** Seconds left on the mission clock. */
  timeLeft: number | null;
  timeLimit: number;
  carName: string | null;
  inLobby: boolean;
  firstTime: boolean;
  slowmo: boolean;
}

export interface GameCallbacks {
  onHud(state: HudState): void;
  onFinished?(outcome: "won" | "lost"): void;
  onPointerLockChange?(locked: boolean): void;
  /** Something went wrong that the player should know about. */
  onError?(message: string): void;
}

export interface GameOptions {
  canvas: HTMLCanvasElement;
  mission: MissionPublic | null;
  /** Attract mode: no player, a cinematic camera flies over the city (welcome screen). */
  attract?: boolean;
  quality?: QualityLevel | "auto";
  bridge?: MissionBridge;
  callbacks?: GameCallbacks;
  progress?: ServerProgress;
  voice?: { onKill: string[]; onDown: string[]; onAlarm: string[]; onCore: string[]; onWin: string; onLose: string };
  /** Avatar hue: tints the operator's visor, coat trim and blaster. */
  hue?: number;
  deadline?: number | null;
  /** Server time the mission clock starts (end of the 3-2-1 countdown). */
  startAt?: number | null;
  /** Mission time limit in seconds (for the HUD bar). */
  timeLimit?: number;
  firstTime?: boolean;
}
