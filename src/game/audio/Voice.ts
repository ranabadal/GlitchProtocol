/*
 * Spoken lines through the browser's built-in speech voice (Web Speech API): the player's
 * quips when robots go down ("Aahh, easy for me!") and NULL's taunts in a deep robot voice.
 * Works offline with the voices installed on Windows/Chrome/Edge; silently does nothing
 * where speech isn't available. Lines are throttled so they never pile up.
 */

export type QuipKind = "gun" | "scatter" | "blade" | "bomb" | "slap" | "car" | "multi" | "titan" | "truck" | "shard" | "heli" | "train";

const QUIPS: Record<QuipKind, string[]> = {
  gun: ["Aahh, easy for me!", "Too easy!", "Ek aur gaya!", "Bas itna hi, NULL?", "Next!", "Scrap ho gaya!", "Aur bhejo!"],
  scatter: ["Boom! Close range king!", "Seedha udd gaya!", "Shotgun says hello!"],
  blade: ["Slice!", "Kaat diya!", "Ninja style!", "Too slow, robot!"],
  bomb: ["Dhamaka!", "Boom! Sab saaf!", "Fire in the hole!"],
  slap: ["Chataak!", "Ek thappad mein khatam!", "Slap ka jawab nahi!", "Tameez se, robot!"],
  car: ["Road pe mat aao!", "Beep beep!", "Side do bhai!"],
  multi: ["Double kill! Easy for me!", "Triple kill! Kya baat hai!", "Combo! Rok sako to rok lo!"],
  titan: ["Titan gira! Ab kaun boss hai?", "Itna bada, itna kamzor!", "Big robot, big boom!"],
  truck: ["Truck rok diya! Core mera hai!", "Data truck khatam!"],
  shard: ["Shard mil gaya!", "Bonus data!"],
  heli: ["Chalo, upar se dekhte hain!", "Helicopter time!"],
  train: ["Metro se chalte hain!", "Next station, victory!"],
};

export class Voice {
  enabled = true;
  private lastHero = -99;
  private lastNull = -99;
  private voices: SpeechSynthesisVoice[] = [];

  constructor(private muted: () => boolean) {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const load = () => { this.voices = window.speechSynthesis.getVoices(); };
    load();
    window.speechSynthesis.addEventListener?.("voiceschanged", load);
  }

  private get ok(): boolean {
    return this.enabled && !this.muted() && typeof window !== "undefined" && "speechSynthesis" in window;
  }

  private pick(prefer: RegExp[]): SpeechSynthesisVoice | null {
    for (const re of prefer) {
      const v = this.voices.find((x) => re.test(`${x.lang} ${x.name}`));
      if (v) return v;
    }
    return this.voices.find((x) => /^en/i.test(x.lang)) ?? null;
  }

  private speak(text: string, o: { pitch: number; rate: number; volume: number; prefer: RegExp[] }): void {
    const u = new SpeechSynthesisUtterance(text);
    const v = this.pick(o.prefer);
    if (v) u.voice = v;
    u.lang = v?.lang ?? "en-IN";
    u.pitch = o.pitch;
    u.rate = o.rate;
    u.volume = o.volume;
    window.speechSynthesis.speak(u);
  }

  /** The player's own line. Returns the text spoken (for the HUD), or null if skipped. */
  hero(kind: QuipKind, chance = 1, force = false): string | null {
    const now = performance.now();
    if (!force && (now - this.lastHero < 3500 || Math.random() > chance)) return null;
    const list = QUIPS[kind];
    const text = list[Math.floor(Math.random() * list.length)];
    this.lastHero = now;
    if (!this.ok) return text;
    // Never queue behind a long line: the moment matters more than the words.
    if (window.speechSynthesis.speaking && !force) return text;
    if (force) window.speechSynthesis.cancel();
    this.speak(text, { pitch: 1.05, rate: 1.08, volume: 1, prefer: [/en-IN/i, /hi-IN/i, /India/i, /en-GB/i] });
    return text;
  }

  /** NULL's taunt, in a slow deep voice. */
  nullSay(text: string): void {
    const now = performance.now();
    if (!this.ok || now - this.lastNull < 5000) return;
    this.lastNull = now;
    if (window.speechSynthesis.speaking) return;
    this.speak(text, { pitch: 0.1, rate: 0.88, volume: 0.85, prefer: [/en-IN.*(male|ravi|hemant)/i, /Microsoft (David|Mark|Ravi)/i, /en-IN/i, /en-US/i] });
  }

  stop(): void {
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }
}
