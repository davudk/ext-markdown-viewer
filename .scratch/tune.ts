import { THEME_PRESETS } from '../lib/config.ts';
import {
  CONTRAST_REQUIREMENTS,
  contrastRatio,
  relativeLuminance,
} from '../lib/theme-presets.ts';

function hex([r, g, b]: number[]): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function rgb(h: string): number[] {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
/** Move a colour toward black or white until it clears `min` on `bg`. */
function fix(fg: string, bg: string, min: number): string {
  const bgLum = relativeLuminance(bg);
  const toward = bgLum > 0.18 ? [0, 0, 0] : [255, 255, 255];
  const base = rgb(fg);
  let best = fg;
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const c = hex(base.map((v, i) => v + (toward[i] - v) * t));
    best = c;
    if (contrastRatio(c, bg) >= min) return c;
  }
  return best;
}

const args = process.argv.slice(2);
const emit = args.includes('--emit');

for (const preset of THEME_PRESETS) {
  const min = preset.id === 'high-contrast' ? 7 : 4.5;
  for (const polarity of ['light', 'dark'] as const) {
    const palette: Record<string, string> = { ...preset[polarity] };
    const changes: string[] = [];
    for (const { fg, bg, what } of CONTRAST_REQUIREMENTS) {
      const ratio = contrastRatio(palette[fg], palette[bg]);
      if (Math.round(ratio * 100) / 100 < min) {
        const fixed = fix(palette[fg], palette[bg], min);
        changes.push(
          `${preset.id}.${polarity}: ${fg} on ${bg} (${what}) ${ratio.toFixed(2)} -> ${palette[fg]} becomes ${fixed} @ ${contrastRatio(fixed, palette[bg]).toFixed(2)}`,
        );
        palette[fg] = fixed;
      }
    }
    if (changes.length) {
      console.log(changes.join('\n'));
      if (emit) {
        console.log(`--- ${preset.id}.${polarity} corrected ---`);
        for (const [k, v] of Object.entries(palette)) {
          console.log(`      ${/-/.test(k) ? `'${k}'` : k}: '${v}',`);
        }
      }
    }
    // Report the final table.
    if (args.includes('--report')) {
      console.log(`\n== ${preset.id} / ${polarity} (min ${min}) ==`);
      for (const { fg, bg, what } of CONTRAST_REQUIREMENTS) {
        console.log(
          `  ${contrastRatio(palette[fg], palette[bg]).toFixed(2).padStart(6)}  ${fg} on ${bg}  — ${what}`,
        );
      }
    }
  }
}
