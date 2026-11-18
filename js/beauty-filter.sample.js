/**
 * Mẫu JS — filter TikTok (da mịn trắng hồng, má đỏ, môi hồng)
 * trước khi save. Không morph mắt/mũi/miệng: cạnh mạnh giữ pixel gốc.
 *
 * Dùng trong browser (Canvas). Node cần package `canvas` + polyfill ImageData.
 *
 * Cách dùng:
 *   const blob = await beautifyBeforeSave(fileOrBlob, { strength: 0.7 });
 *   // upload / download blob
 */

/**
 * @param {Blob|File|HTMLImageElement|ImageBitmap} input
 * @param {object} [opts]
 * @param {number} [opts.strength=0.70]
 * @param {number} [opts.smooth=0.75]
 * @param {number} [opts.pink=0.65]
 * @param {number} [opts.blush=0.55]
 * @param {number} [opts.lips=0.70]
 * @param {'image/png'|'image/jpeg'} [opts.type='image/png']
 * @param {number} [opts.quality=0.92]  // chỉ jpeg
 * @returns {Promise<Blob>}
 */
export async function beautifyBeforeSave(input, opts = {}) {
  const {
    strength = 0.7,
    smooth = 0.75,
    pink = 0.65,
    blush = 0.55,
    lips = 0.7,
    type = "image/png",
    quality = 0.92,
  } = opts;

  const bitmap = await toImageBitmap(input);
  const w = bitmap.width;
  const h = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  if (typeof bitmap.close === "function") bitmap.close();

  const imageData = ctx.getImageData(0, 0, w, h);
  applyBeautyInPlace(imageData.data, w, h, {
    strength,
    smooth,
    pink,
    blush,
    lips,
  });
  ctx.putImageData(imageData, 0, 0);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      type,
      quality
    );
  });
}

/** Ví dụ gắn vào <input type="file"> rồi download */
export async function exampleFileInput(file) {
  const out = await beautifyBeforeSave(file, {
    strength: 0.7,
    smooth: 0.75,
    pink: 0.65,
    blush: 0.55,
    lips: 0.7,
    type: "image/png",
  });
  const url = URL.createObjectURL(out);
  const a = document.createElement("a");
  a.href = url;
  a.download = "print-beauty.png";
  a.click();
  URL.revokeObjectURL(url);
  return out;
}

// --- core (RGBA ImageData) -------------------------------------------------

/**
 * @param {Uint8ClampedArray} data  RGBA
 * @param {number} w
 * @param {number} h
 * @param {{strength:number,smooth:number,pink:number,blush:number,lips:number}} p
 */
export function applyBeautyInPlace(data, w, h, p) {
  const strength = clamp01(p.strength);
  if (strength < 0.05) return;

  const kSmooth = strength * clamp01(p.smooth);
  const kPink = strength * clamp01(p.pink);
  const kBlush = strength * clamp01(p.blush);
  const kLips = strength * clamp01(p.lips);

  const n = w * h;
  const Y = new Float32Array(n);
  const skin = new Float32Array(n);
  const edge = new Float32Array(n);

  let minX = w,
    minY = h,
    maxX = 0,
    maxY = 0,
    skinCount = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      const yv = 0.299 * r + 0.587 * g + 0.114 * b;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      const pidx = y * w + x;
      Y[pidx] = yv;

      let s = 0;
      if (yv > 45 && yv < 240 && cb > 75 && cb < 130 && cr > 132 && cr < 178) {
        s = softRange(cb, 80, 125, 6) * softRange(cr, 136, 172, 6);
      }
      skin[pidx] = s;
      if (s > 0.35) {
        skinCount++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Sobel trên luma — bảo vệ mắt/mũi/miệng
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const pidx = y * w + x;
      const gx =
        -Y[pidx - w - 1] -
        2 * Y[pidx - 1] -
        Y[pidx + w - 1] +
        Y[pidx - w + 1] +
        2 * Y[pidx + 1] +
        Y[pidx + w + 1];
      const gy =
        -Y[pidx - w - 1] -
        2 * Y[pidx - w] -
        Y[pidx - w + 1] +
        Y[pidx + w - 1] +
        2 * Y[pidx + w] +
        Y[pidx + w + 1];
      edge[pidx] = Math.min(1, Math.sqrt(gx * gx + gy * gy) / 90);
    }
  }

  const radius = Math.max(3, Math.min(10, Math.max(w, h) / 280 | 0));
  const blur = boxBlurRgba(data, w, h, radius);

  const haveFace = skinCount > (w * h) / 80 && maxX > minX + 20 && maxY > minY + 20;
  const faceL = haveFace ? minX : w * 0.2;
  const faceT = haveFace ? minY : h * 0.15;
  const faceW = haveFace ? maxX - minX + 1 : w * 0.6;
  const faceH = haveFace ? maxY - minY + 1 : h * 0.55;
  const cheekY = faceT + faceH * 0.45;
  const cheekRx = faceW * 0.14;
  const cheekRy = faceH * 0.1;
  const cheekLX = faceL + faceW * 0.28;
  const cheekRX = faceL + faceW * 0.72;
  const lipTop = faceT + faceH * 0.58;
  const lipBot = faceT + faceH * 0.82;
  const lipL = faceL + faceW * 0.3;
  const lipR = faceL + faceW * 0.7;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pidx = y * w + x;
      const s = skin[pidx];
      if (s < 0.02 && kLips < 0.05) continue;

      const i = pidx * 4;
      const flat = Math.max(0, 1 - edge[pidx]);
      let r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      const rr = blur[i],
        gg = blur[i + 1],
        bb = blur[i + 2];

      // 1) mịn da phẳng
      const sm = s * flat * kSmooth * 0.9;
      r += (rr - r) * sm;
      g += (gg - g) * sm;
      b += (bb - b) * sm;

      // 2) da trắng hồng
      const pk = s * (0.35 + 0.65 * flat) * kPink;
      if (pk > 0.001) {
        r += pk * 10;
        g += pk * 4.5;
        b += pk * 7.5;
        const yv = 0.299 * r + 0.587 * g + 0.114 * b;
        const lift = pk * 6 * (1 - Math.abs(yv - 150) / 150);
        if (lift > 0) {
          r += lift;
          g += lift;
          b += lift;
        }
      }

      // 3) má đỏ
      if (kBlush > 0.02 && s > 0.15) {
        let bl =
          blushWeight(x, y, cheekLX, cheekY, cheekRx, cheekRy) +
          blushWeight(x, y, cheekRX, cheekY, cheekRx, cheekRy);
        if (bl > 1) bl = 1;
        const bm = bl * s * flat * kBlush;
        r += bm * 22;
        g += bm * 4;
        b += bm * 10;
      }

      // 4) môi hồng
      if (
        kLips > 0.02 &&
        x >= lipL &&
        x <= lipR &&
        y >= lipTop &&
        y <= lipBot
      ) {
        const r0 = data[i],
          g0 = data[i + 1],
          b0 = data[i + 2];
        const cr = 128 + 0.5 * r0 - 0.418688 * g0 - 0.081312 * b0;
        const cb = 128 - 0.168736 * r0 - 0.331264 * g0 + 0.5 * b0;
        if (cr > 148 && cr - cb > 20 && Y[pidx] > 40 && Y[pidx] < 210) {
          let lipM =
            softRange(cr, 150, 185, 8) *
            softRange(cr - cb, 22, 70, 6) *
            (0.55 + 0.45 * flat);
          const lm = lipM * kLips;
          r += lm * 26;
          g -= lm * 5;
          b += lm * 8;
        }
      }

      data[i] = clamp255(r);
      data[i + 1] = clamp255(g);
      data[i + 2] = clamp255(b);
      // alpha giữ nguyên
    }
  }
}

// --- helpers ---------------------------------------------------------------

async function toImageBitmap(input) {
  if (input instanceof ImageBitmap) return input;
  if (typeof ImageBitmap !== "undefined" && input instanceof Blob) {
    return createImageBitmap(input);
  }
  if (input && input.tagName === "IMG") {
    if (input.decode) await input.decode();
    return createImageBitmap(input);
  }
  throw new Error("unsupported input — dùng Blob/File/Image/ImageBitmap");
}

function clamp01(v) {
  v = +v || 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
}

function softRange(v, lo, hi, soft) {
  if (v < lo - soft || v > hi + soft) return 0;
  if (v < lo) return (v - (lo - soft)) / soft;
  if (v > hi) return (hi + soft - v) / soft;
  return 1;
}

function blushWeight(x, y, cx, cy, rx, ry) {
  if (rx < 1 || ry < 1) return 0;
  const nx = (x - cx) / rx;
  const ny = (y - cy) / ry;
  const d2 = nx * nx + ny * ny;
  if (d2 >= 1) return 0;
  const t = 1 - d2;
  return t * t;
}

/** Box blur RGBA — trả mảng mới cùng kích thước */
function boxBlurRgba(src, w, h, radius) {
  const tmp = new Uint8ClampedArray(src.length);
  const dst = new Uint8ClampedArray(src.length);
  const diam = radius * 2 + 1;

  for (let y = 0; y < h; y++) {
    let sumR = 0,
      sumG = 0,
      sumB = 0,
      sumA = 0;
    for (let k = -radius; k <= radius; k++) {
      const xx = k < 0 ? 0 : k >= w ? w - 1 : k;
      const i = (y * w + xx) * 4;
      sumR += src[i];
      sumG += src[i + 1];
      sumB += src[i + 2];
      sumA += src[i + 3];
    }
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      tmp[i] = sumR / diam;
      tmp[i + 1] = sumG / diam;
      tmp[i + 2] = sumB / diam;
      tmp[i + 3] = sumA / diam;
      const xOut = Math.max(0, x - radius);
      const xIn = Math.min(w - 1, x + radius + 1);
      const iOut = (y * w + xOut) * 4;
      const iIn = (y * w + xIn) * 4;
      sumR += src[iIn] - src[iOut];
      sumG += src[iIn + 1] - src[iOut + 1];
      sumB += src[iIn + 2] - src[iOut + 2];
      sumA += src[iIn + 3] - src[iOut + 3];
    }
  }

  for (let x = 0; x < w; x++) {
    let sumR = 0,
      sumG = 0,
      sumB = 0,
      sumA = 0;
    for (let k = -radius; k <= radius; k++) {
      const yy = k < 0 ? 0 : k >= h ? h - 1 : k;
      const i = (yy * w + x) * 4;
      sumR += tmp[i];
      sumG += tmp[i + 1];
      sumB += tmp[i + 2];
      sumA += tmp[i + 3];
    }
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      dst[i] = sumR / diam;
      dst[i + 1] = sumG / diam;
      dst[i + 2] = sumB / diam;
      dst[i + 3] = sumA / diam;
      const yOut = Math.max(0, y - radius);
      const yIn = Math.min(h - 1, y + radius + 1);
      const iOut = (yOut * w + x) * 4;
      const iIn = (yIn * w + x) * 4;
      sumR += tmp[iIn] - tmp[iOut];
      sumG += tmp[iIn + 1] - tmp[iOut + 1];
      sumB += tmp[iIn + 2] - tmp[iOut + 2];
      sumA += tmp[iIn + 3] - tmp[iOut + 3];
    }
  }
  return dst;
}

/* --- HTML tối giản (không module) -----------------------------------------
<script type="module">
  import { beautifyBeforeSave } from './beauty-filter.sample.js';

  document.getElementById('file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const blob = await beautifyBeforeSave(file, { strength: 0.7 });
    // save / upload
    const fd = new FormData();
    fd.append('print', blob, 'print.png');
    await fetch('/upload', { method: 'POST', body: fd });
  });
</script>
<input id="file" type="file" accept="image/*" />
--------------------------------------------------------------------------- */
