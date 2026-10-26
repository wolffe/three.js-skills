# Card atlas recipe

One 2048 x 2048 webp with alpha, 4 x 4 cells of 512 px, row 0 at the top. Each cell holds one cutout clump with
its base on the bottom edge (the quad's root is v = 0) and clear alpha around it. Tools: ffmpeg (with libwebp)
and node; no other dependency.

## Sources

- Your own cutouts: photograph or render clumps against a flat background, key it out, keep a soft alpha edge.
- CC0 plant-card packs, for example Nobiax's plant/grass card sets (free for any use; check the readme of the
  pack you download). They ship as 7z archives of TGA/PNG with alpha; any 7z extractor works.
- Pick by role, not by beauty: 6-8 green meadow cards, 4-6 dry/autumn cards, 1-2 accents (flowers, plumes).
  Accents are picked at 2-5 %; more reads as a pattern.
- No winter cards are needed: the material draws snow-covered grass from the card's luminance (`palette`).

## Why normalise

Packs differ by a factor of 5 in brightness: measured mean opaque luminance ran 27-140 / 255 over one set, and
the dark dry cards read as holes in a hillside. A shader gain cannot fix one card without brightening the
others. Gain each card toward a mean of ~112 / 255 before packing (gain clamped 0.8-3.2), then keep the
material's `gain` at 1.0.

## Steps

1. Put exactly 16 cutouts in one folder, named so that sorting gives the cell order (`00-meadow.png` ...
   `15-plume.png`). Write the cell table (which index is which set) next to the atlas; `pickCard` uses it.
2. Run the script below: `node build-atlas.mjs path/to/cards path/to/atlas.webp`. It fits each card into a
   512 cell (bottom-aligned, centred), measures the mean sRGB luminance (Rec. 709 weights) over the pixels with
   alpha >= 128, gains RGB toward 112 with ffmpeg `lutrgb` (which clips to 0-255; alpha untouched), then stacks
   four `hstack` rows into one `vstack` and encodes webp quality 88 with alpha. It prints each card's mean and
   gain; a card that hits a clamp (mean under 35 or over 140) is worth replacing.
3. Load it as one texture for the session: `colorSpace = SRGBColorSpace`, `ClampToEdgeWrapping`,
   `LinearMipmapLinearFilter`, `anisotropy` 8. A 1 x 1 clear canvas texture can stand in until the image lands
   (swap `texture.image`, set `needsUpdate`): the material and pipelines never change.

Result: about 1.9 MB for 16 cells. The material's 0.5 % `inset` keeps mip taps inside a cell; at the smallest
mips neighbours still bleed slightly, which the alpha test hides.

```js
// build-atlas.mjs — node build-atlas.mjs cards/ atlas.webp   (16 images with alpha, sorted name = cell order)
import { spawnSync } from 'node:child_process';
import { readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [srcDir, outFile = 'atlas.webp'] = process.argv.slice(2);
const CELL = 512, GRID = 4, TARGET = 112, GAIN_MIN = 0.8, GAIN_MAX = 3.2;
const tmp = join(srcDir, '_cells');
mkdirSync(tmp, { recursive: true });
const ff = (args, opts) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 28, ...opts });
  if (r.status) throw new Error(String(r.stderr));
  return r.stdout;
};

const files = readdirSync(srcDir).filter((f) => /\.(png|webp|tga)$/i.test(f)).sort();
if (files.length !== GRID * GRID) throw new Error(`need ${GRID * GRID} cards, found ${files.length}`);
const cells = files.map((f, i) => {
  const src = join(srcDir, f), cell = join(tmp, `c${String(i).padStart(2, '0')}.png`);
  // Fit inside the cell, centred, BASE ON THE BOTTOM EDGE (the quad's root is v = 0).
  const fit = `scale=${CELL}:${CELL}:force_original_aspect_ratio=decrease,format=rgba,`
    + `pad=${CELL}:${CELL}:(ow-iw)/2:oh-ih:color=black@0`;
  ff(['-i', src, '-vf', fit, cell]);
  // Mean sRGB luminance (Rec. 709 weights, 0-255) over pixels with alpha >= 128.
  const px = ff(['-i', cell, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  let sum = 0, n = 0;
  for (let p = 0; p < px.length; p += 4) {
    if (px[p + 3] < 128) continue;
    sum += 0.2126 * px[p] + 0.7152 * px[p + 1] + 0.0722 * px[p + 2]; n++;
  }
  const mean = n ? sum / n : TARGET;
  const gain = Math.min(GAIN_MAX, Math.max(GAIN_MIN, TARGET / mean));
  const out = join(tmp, `n${String(i).padStart(2, '0')}.png`);
  // lutrgb clips to 0-255 itself; alpha is untouched.
  const g = gain.toFixed(3);
  ff(['-i', cell, '-vf', `format=rgba,lutrgb=r=val*${g}:g=val*${g}:b=val*${g}`, out]);
  console.log(`${i.toString().padStart(2)} ${f}: mean ${mean.toFixed(0)} gain ${g}`);
  return out;
});

// 4 hstacks (rows, top first) -> one vstack -> webp with alpha.
const inputs = cells.flatMap((c) => ['-i', c]);
let graph = '';
for (let r = 0; r < GRID; r++) {
  graph += Array.from({ length: GRID }, (_, c) => `[${r * GRID + c}:v]`).join('') + `hstack=inputs=${GRID}[r${r}];`;
}
graph += Array.from({ length: GRID }, (_, r) => `[r${r}]`).join('') + `vstack=inputs=${GRID},format=yuva420p[out]`;
ff([...inputs, '-filter_complex', graph, '-map', '[out]', '-c:v', 'libwebp', '-quality', '88', '-frames:v', '1', outFile]);
console.log('wrote', outFile);
```

Tested with ffmpeg 9.0 and node 24 on synthetic cards: a card at mean 34 comes out at 107 (gain clamped at
3.2), alpha coverage unchanged, output 2048 x 2048 yuva420p webp.

The one-off shell version of the same steps, per card and then the stack:

```sh
ffmpeg -i in.png -vf "scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:oh-ih:color=black@0" cell.png
ffmpeg -i cell.png -vf "format=rgba,lutrgb=r=val*1.6:g=val*1.6:b=val*1.6" cell-n.png
ffmpeg -i c00.png -i c01.png ... -i c15.png -filter_complex \
  "[0:v][1:v][2:v][3:v]hstack=inputs=4[r0];[4:v][5:v][6:v][7:v]hstack=inputs=4[r1];\
   [8:v][9:v][10:v][11:v]hstack=inputs=4[r2];[12:v][13:v][14:v][15:v]hstack=inputs=4[r3];\
   [r0][r1][r2][r3]vstack=inputs=4,format=yuva420p[out]" \
  -map "[out]" -c:v libwebp -quality 88 -frames:v 1 atlas.webp
```
