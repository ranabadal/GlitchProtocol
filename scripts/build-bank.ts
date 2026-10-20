/*
 * Regenerates the verified mission bank: for each band, finds fixed seeds whose
 * candidates validate, and prints entries to paste into src/lib/engine/bank.ts.
 *
 *   npm run build-bank
 */
import { TEMPLATES, generateFromSeed } from "../src/lib/engine/generator";
import { BANDS } from "../src/lib/engine/types";

const PER_BAND = 4;
const lines: string[] = [];
for (const t of Object.values(TEMPLATES)) {
  for (const band of BANDS) {
    let found = 0;
    for (let i = 0; found < PER_BAND && i < 500; i++) {
      const seed = `bank-${t.id}-b${band}-${i}`;
      for (let attempt = 0; attempt < 10; attempt++) {
        if (generateFromSeed(t, seed, attempt, { band, focusTags: [] }).ok) {
          lines.push(`  { templateId: "${t.id}", band: ${band}, seed: "${seed}", attempt: ${attempt} },`);
          found++;
          break;
        }
      }
    }
  }
}
console.log(lines.join("\n"));
