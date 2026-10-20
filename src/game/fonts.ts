/** Canvas text (signs, billboards, speech bubbles) needs the web fonts loaded first. */
export async function ensureFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const want = ['700 30px "Oxanium Variable"', '800 30px "Oxanium Variable"', '700 30px "Rajdhani"', '400 30px "Share Tech Mono"'];
  try {
    await Promise.race([Promise.all(want.map((f) => document.fonts.load(f))), new Promise((r) => setTimeout(r, 2500))]);
  } catch {
    /* fall back to system fonts */
  }
}
