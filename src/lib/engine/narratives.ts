import { Rng } from "./rng";
import type { Band } from "./types";

/*
 * Built-in Hinglish story text and NULL's voice lines. Used whenever the AI is off,
 * slow, over budget or returns something that fails validation. None of it mentions
 * mission data, so swapping in AI text never changes what the player has to do.
 */

export interface VoicePack {
  /** NULL reacts when the player destroys one of his robots. */
  onKill: string[];
  /** NULL gloats when the player loses a life. */
  onDown: string[];
  /** NULL reacts to a failed hack (alarm). */
  onAlarm: string[];
  /** NULL reacts to a stolen core. */
  onCore: string[];
  onWin: string;
  onLose: string;
}

export interface Narrative {
  title: string;
  briefing: string;
  threat: string;
  /** Deterministic note tailored to the player's history. */
  personal: string;
  theme: number;
  voice: VoicePack;
}

interface Theme { title: string; briefing: string; threat: string }

export const THEMES: Theme[] = [
  { title: "Operation Blackout", briefing: "{{callsign}}, NULL ne Neon City ka poora data apne vaults mein lock kar diya hai. Har vault mein ek data core hai. Core uthao, uplink tower tak le jao aur city ko wapas online karo!", threat: "Mere robots har gali mein hain. Bach ke dikhao!" },
  { title: "Midnight Extraction", briefing: "Aadhi raat hai aur city ki lights NULL ke control mein hain. {{callsign}}, vaults hack karo, cores nikaalo aur uplink se city ko azaad karo.", threat: "Andhera mera dost hai, operator." },
  { title: "Core Runner", briefing: "{{callsign}}, hamare scanners ne NULL ke secret vaults dhoondh liye hain. Gaadi uthao, robots se bachke cores collect karo aur uplink tak pahuncho.", threat: "Tumhari gaadi meri sadkon pe zyada door nahi jayegi." },
  { title: "Firewall City", briefing: "NULL ne har building pe firewall laga diya hai. {{callsign}}, tumhe har vault ka firewall todna hai. Har core city ke ek hisse ko wapas laayega.", threat: "Mera firewall koi insaan nahi tod sakta." },
  { title: "Signal Lost", briefing: "City ka signal gayab hai! {{callsign}}, NULL ke vaults se data cores chura ke uplink tower pe upload karo, tabhi signal wapas aayega.", threat: "Upload? Main tumhe tower tak pahunchne hi nahi dunga." },
  { title: "Robot Rush", briefing: "{{callsign}}, NULL ki robot army sadkon pe utar aayi hai. Laser fences aur barricades se bachte hue vaults tak pahuncho. Har second keemti hai!", threat: "Meri army tumse sau guna badi hai." },
];

export const DEFAULT_VOICE: VoicePack = {
  onKill: ["Arre! Mera robot!", "Ye scrap metal tha bas!", "Grrr... aur bhejta hoon!", "Lucky shot!", "Ek gaya, sau aur hain!"],
  onDown: ["Hahaha! System down!", "Itni jaldi haar maan li?", "Ek life gayi, operator!", "Mere robots jeet gaye!"],
  onAlarm: ["ALARM! Pakdo isse!", "Galat code! Robots, attack!", "Hack fail! Hahaha!"],
  onCore: ["Mera core wapas karo!", "Chor! Data chor!", "Ye core tumhe mehenga padega!"],
  onWin: "Nahiii! Mera system crash ho raha hai...",
  onLose: "Neon City mera hai! Phir try karna, operator.",
};

const TAG_NOTES: Record<string, string> = {
  "hack:glitch": "Data Stream hacks",
  "hack:power": "Firewall circuits",
  "hack:imposter": "Identity Scans",
  survival: "robots se bachna",
  speed: "time management",
};

export function describeTag(tag: string): string {
  const base = tag.split(":").slice(0, 2).join(":");
  return TAG_NOTES[tag] ?? TAG_NOTES[base] ?? tag;
}

export function personalNote(level: number, band: Band, focusTags: string[], firstTime: boolean): string {
  if (firstTime) return "Pehla mission! Gaadi chalane ke liye F dabao, aur minimap pe peeli line follow karo.";
  if (focusTags.length) return `Practice: is mission mein ${focusTags.map(describeTag).join(" aur ")} pe dhyan do.`;
  if (band >= 4) return "Threat level high! Robots zyada hain, EMP (Q) sambhal ke use karo.";
  return `Level ${level} operator. Streak banaye rakho!`;
}

export function themeIndex(seed: string): number {
  return new Rng(`${seed}:theme`).int(0, THEMES.length - 1);
}

export function fillCallsign(text: string, callsign: string): string {
  return text.replaceAll("{{callsign}}", callsign);
}

export function fallbackNarrative(opts: { seed: string; callsign: string; level: number; band: Band; focusTags: string[]; firstTime: boolean }): Narrative {
  const theme = themeIndex(opts.seed);
  const t = THEMES[theme];
  return {
    title: t.title,
    briefing: fillCallsign(t.briefing, opts.callsign),
    threat: t.threat,
    personal: personalNote(opts.level, opts.band, opts.focusTags, opts.firstTime),
    theme,
    voice: DEFAULT_VOICE,
  };
}

export const NEXT_TIP = "Vault ke bahar wale robots ko pehle gaadi se udao, phir andar jaake hack karo. Fail hua to bahar robots aate hain.";

export function fallbackFeedback(outcome: string, cores: number, totalCores: number, kills: number): { headline: string; feedback: string; next_tip: string } {
  if (outcome === "abandoned") return { headline: "Mission chhoda", feedback: "Tumne mission beech mein chhod diya. Koi baat nahi, agli baar poora khelna!", next_tip: NEXT_TIP };
  if (outcome === "success") return { headline: "City online!", feedback: `Saare ${totalCores} cores upload ho gaye aur ${kills} robots scrap hue. NULL ka system hil gaya!`, next_tip: "Jaldi khatam karo to time bonus milta hai: vaults ke beech hamesha gaadi use karo." };
  if (outcome === "timeout") return { headline: "Time khatam", feedback: `${totalCores} mein se ${cores} cores mile. Timer khatam ho gaya, par agli baar route pehle se plan karo.`, next_tip: "Minimap pe peeli line sabse chhota rasta dikhati hai. Barricade wale raste laal hote hain." };
  return { headline: "System down", feedback: `${totalCores} mein se ${cores} cores aur ${kills} robots. Lives khatam ho gayi, par har mission ke saath tum tez ho rahe ho.`, next_tip: "Health kam ho to gaadi mein baith jao: gaadi tumhe goliyon se bachati hai." };
}
