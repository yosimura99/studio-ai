// Tiện ích ảnh: nạp ảnh, ma trận tương tự (Umeyama), warp bằng canvas, làm mờ, tensor.
export function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
export const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });
export async function loadImage(src) {
  if (src instanceof HTMLCanvasElement) return src;
  let blob = src;
  if (typeof src === 'string') { const r = await fetch(src); if (!r.ok) throw new Error('Không tải được ảnh'); blob = await r.blob(); }
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch { const u = URL.createObjectURL(blob); const im = new Image(); im.src = u; await im.decode(); bmp = im; }
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  const c = canvas(w, h); ctx2d(c).drawImage(bmp, 0, 0); bmp.close?.(); return c;
}
// least-squares similarity transform src->dst; returns [a,b,tx,c,d,ty] (2x3 row-major)
export function similarity(src, dst) {
  const n = src.length; let mx = 0, my = 0, ux = 0, uy = 0;
  for (let i = 0; i < n; i++) { mx += src[i][0]; my += src[i][1]; ux += dst[i][0]; uy += dst[i][1]; }
  mx /= n; my /= n; ux /= n; uy /= n;
  let sxx = 0, a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - mx, y = src[i][1] - my, u = dst[i][0] - ux, v = dst[i][1] - uy;
    sxx += x * x + y * y; a += x * u + y * v; b += x * v - y * u;
  }
  a /= sxx; b /= sxx;
  return [a, -b, ux - (a * mx - b * my), b, a, uy - (b * mx + a * my)];
}
export function invert(M) {
  const [a, b, c, d, e, f] = M; const det = a * e - b * d;
  const ia = e / det, ib = -b / det, id = -d / det, ie = a / det;
  return [ia, ib, -(ia * c + ib * f), id, ie, -(id * c + ie * f)];
}
export function apply(M, x, y) { return [M[0] * x + M[1] * y + M[2], M[3] * x + M[4] * y + M[5]]; }
export function translate(M, dx, dy) { return [M[0], M[1], M[2] + M[0] * dx + M[1] * dy, M[3], M[4], M[5] + M[3] * dx + M[4] * dy]; } // M∘T(dx,dy)
export function warp(src, M, w, h) {
  const c = canvas(w, h); const g = ctx2d(c); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.setTransform(M[0], M[3], M[1], M[4], M[2], M[5]); g.drawImage(src, 0, 0); return c;
}
export function toTensor(c, mean, std, bgr = false, chw = true) {
  const { width: w, height: h } = c; const d = ctx2d(c).getImageData(0, 0, w, h).data; const n = w * h; const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const ch = bgr ? 2 - k : k; const v = (d[i * 4 + ch] - mean[k]) / std[k];
    if (chw) out[k * n + i] = v; else out[i * 3 + k] = v;
  }
  return out;
}
export function fromCHW(t, w, h, f, alpha) { // f: value -> 0..255
  const c = canvas(w, h); const g = ctx2d(c); const im = g.createImageData(w, h); const n = w * h; const d = im.data;
  for (let i = 0; i < n; i++) { d[i * 4] = f(t[i]); d[i * 4 + 1] = f(t[n + i]); d[i * 4 + 2] = f(t[2 * n + i]); d[i * 4 + 3] = alpha ? Math.round(alpha[i] * 255) : 255; }
  g.putImageData(im, 0, 0); return c;
}
// separable box blur (3 passes ≈ gaussian) on Float32Array
export function blur(a, w, h, r) {
  r = Math.max(1, Math.round(r)); let src = a; const tmp = new Float32Array(a.length); const k = 2 * r + 1;
  for (let pass = 0; pass < 3; pass++) {
    const dst = new Float32Array(a.length);
    for (let y = 0; y < h; y++) {
      const o = y * w; let s = 0;
      for (let x = -r; x <= r; x++) s += src[o + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) { tmp[o + x] = s / k; s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)]; }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) { dst[y * w + x] = s / k; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
    }
    src = dst;
  }
  return src;
}
export function rectMask(size, inset, feather) { // feathered rectangle mask (Float32 size*size)
  const m = new Float32Array(size * size); const i0 = Math.round(size * inset), i1 = size - i0;
  for (let y = i0; y < i1; y++) for (let x = i0; x < i1; x++) m[y * size + x] = 1;
  return blur(m, size, size, size * feather);
}
