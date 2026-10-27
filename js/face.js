// Ghép Mặt AI — InsightFace (det_10g + ArcFace w600k_r50 + inswapper_128) + GFPGAN 1.4 + BiSeNet (khóa vùng mặt).
import * as S from './store.js';
import { canvas, ctx2d, similarity, invert, apply, translate, warp, toTensor, blur, rectMask } from './img.js';

const ARC = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
const FFHQ = [[0.37691676, 0.46864664], [0.62285697, 0.46912813], [0.50123859, 0.61331904], [0.39308822, 0.72541100], [0.61150205, 0.72490465]].map(([x, y]) => [x * 512, y * 512]);
export const FACE_MODELS = ['det', 'arcface', 'inswapper', 'gfpgan', 'bisenet', 'nsfw'];
const FACE_CLASSES = [1, 2, 3, 4, 5, 10, 11, 12, 13];
const tick = () => new Promise(r => setTimeout(r, 0));

async function run(id, feeds, onP) {
  const ort = await S.getOrt(); const s = await S.session('face', id, onP);
  const f = {}; const names = s.inputNames;
  feeds.forEach(([data, dims], i) => { f[names[i]] = new ort.Tensor(data instanceof BigInt64Array ? 'int64' : 'float32', data, dims); });
  const out = await s.run(f); const r = s.outputNames.map(n => out[n]);
  if (S.lowMem) S.release('face', id);
  return r;
}
const arr = (t) => t.data instanceof Float32Array ? t.data : Float32Array.from(t.data);

// ---------- phát hiện khuôn mặt ----------
export async function detect(img, onP) {
  const W = img.width, H = img.height, sc = Math.min(640 / W, 640 / H);
  const c = canvas(640, 640); const g = ctx2d(c); g.fillStyle = '#000'; g.fillRect(0, 0, 640, 640);
  g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, Math.round(W * sc), Math.round(H * sc));
  const out = await run('det', [[toTensor(c, [127.5, 127.5, 127.5], [128, 128, 128]), [1, 3, 640, 640]]], onP);
  const faces = [];
  [8, 16, 32].forEach((st, k) => {
    const sc_ = arr(out[k]), bb = arr(out[k + 3]), kp = arr(out[k + 6]); const fw = 640 / st;
    for (let i = 0; i < sc_.length; i++) {
      if (sc_[i] < 0.5) continue;
      const p = i >> 1, cx = (p % fw) * st, cy = Math.floor(p / fw) * st;
      const box = [cx - bb[i * 4] * st, cy - bb[i * 4 + 1] * st, cx + bb[i * 4 + 2] * st, cy + bb[i * 4 + 3] * st].map(v => v / sc);
      const kps = []; for (let j = 0; j < 5; j++) kps.push([(cx + kp[i * 10 + j * 2] * st) / sc, (cy + kp[i * 10 + j * 2 + 1] * st) / sc]);
      faces.push({ score: sc_[i], box, kps });
    }
  });
  faces.sort((a, b) => b.score - a.score);
  const keep = [];
  const iou = (a, b) => { const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]); const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i); };
  for (const f of faces) if (!keep.some(k => iou(k.box, f.box) > 0.4)) keep.push(f);
  const area = f => (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]);
  keep.sort((a, b) => area(b) - area(a));          // mặt to nhất trước
  keep.forEach((f, i) => { f.index = i; f.area = area(f); });
  return keep;
}
// chọn mặt theo lệnh: {index} | 'left' | 'right' | 'largest'
export function pickFace(faces, sel) {
  if (!faces.length) return null;
  if (sel == null || sel === 'largest') return faces[0];
  if (sel === 'left' || sel === 'right') { const s = [...faces].sort((a, b) => (a.box[0] + a.box[2]) - (b.box[0] + b.box[2])); return sel === 'left' ? s[0] : s[s.length - 1]; }
  if (typeof sel === 'number') { // thứ tự trái → phải (1-based) khi người dùng nói "mặt thứ 2"
    const s = [...faces].sort((a, b) => (a.box[0] + a.box[2]) - (b.box[0] + b.box[2])); return s[Math.min(s.length, Math.max(1, sel)) - 1];
  }
  return faces[0];
}
export function faceThumb(img, f, size = 96) {
  const [x1, y1, x2, y2] = f.box; const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, s = Math.max(x2 - x1, y2 - y1) * 1.3;
  const c = canvas(size, size); ctx2d(c).drawImage(img, cx - s / 2, cy - s / 2, s, s, 0, 0, size, size); return c;
}

// ---------- nhận dạng (ArcFace) ----------
export async function embed(img, face, onP) {
  const M = similarity(face.kps, ARC); const crop = warp(img, M, 112, 112);
  const [o] = await run('arcface', [[toTensor(crop, [127.5, 127.5, 127.5], [127.5, 127.5, 127.5]), [1, 3, 112, 112]]], onP);
  const e = Float32Array.from(o.data); let n = 0; for (const v of e) n += v * v; n = Math.sqrt(n); for (let i = 0; i < e.length; i++) e[i] /= n;
  return e;
}
let EMAP = null;
async function latent(emb) {
  if (!EMAP) { const b = await S.extra('face', 'inswapper', 'emap.bin'); EMAP = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
  const L = new Float32Array(512);
  for (let i = 0; i < 512; i++) { const e = emb[i]; if (!e) continue; const o = i * 512; for (let j = 0; j < 512; j++) L[j] += e * EMAP[o + j]; }
  let n = 0; for (const v of L) n += v * v; n = Math.sqrt(n); for (let j = 0; j < 512; j++) L[j] /= n; return L;
}

// ---------- an toàn: open_nsfw ----------
export async function nsfwScore(img) {
  const c = canvas(224, 224); const g = ctx2d(c); g.imageSmoothingQuality = 'high';
  const s = Math.min(img.width, img.height); g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 224, 224);
  const t = toTensor(c, [104, 117, 123], [1, 1, 1], true, false);
  const [o] = await run('nsfw', [[t, [1, 224, 224, 3]]]); return o.data[1];
}

// ---------- ghép ----------
function colorMatch(out, ref, n, strength) { // khớp màu trung bình/độ lệch trong elip trung tâm (128x128)
  const sel = []; for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) { const dx = (x - 64) / 40, dy = (y - 72) / 48; if (dx * dx + dy * dy < 1) sel.push(y * 128 + x); }
  for (let k = 0; k < 3; k++) {
    let ms = 0, mt = 0, vs = 0, vt = 0;
    for (const i of sel) { ms += out[k * n + i]; mt += ref[k * n + i]; } ms /= sel.length; mt /= sel.length;
    for (const i of sel) { vs += (out[k * n + i] - ms) ** 2; vt += (ref[k * n + i] - mt) ** 2; }
    const r = Math.min(1.4, Math.max(0.7, Math.sqrt(vt / Math.max(vs, 1e-8))));
    for (let i = 0; i < n; i++) { const v = (out[k * n + i] - ms) * r + mt; out[k * n + i] = out[k * n + i] + (v - out[k * n + i]) * strength; }
  }
}
function tensorToCanvas(t, size, f, alpha) {
  const c = canvas(size, size); const g = ctx2d(c); const im = g.createImageData(size, size); const n = size * size; const d = im.data;
  for (let i = 0; i < n; i++) { d[i * 4] = f(t[i]); d[i * 4 + 1] = f(t[n + i]); d[i * 4 + 2] = f(t[2 * n + i]); d[i * 4 + 3] = alpha ? Math.round(alpha[i] * 255) : 255; }
  g.putImageData(im, 0, 0); return c;
}
const clamp255 = v => v < 0 ? 0 : v > 255 ? 255 : Math.round(v);

/**
 * Ghép mặt nguồn (srcImg/srcFace) vào ảnh đích (dstImg/dstFace).
 * opts: {restore:true, restoreAmt:0.8, colorMatch:true, lock:true, keepMouth:false, onStep}
 * Trả về job (giữ ảnh trung gian để vẽ lại mặt nạ không cần chạy lại model).
 */
export async function swap(srcImg, srcFace, dstImg, dstFace, opts = {}) {
  const o = { restore: true, restoreAmt: 0.8, colorMatch: true, lock: true, keepMouth: false, ...opts };
  const step = (m, p) => o.onStep?.(m, p); const T0 = performance.now(); const times = {};
  const t = async (name, f) => { const a = performance.now(); const r = await f(); times[name] = Math.round(performance.now() - a); await tick(); return r; };
  step('Đọc nhận dạng mặt nguồn…', 0.1);
  const emb = await t('arcface', () => embed(srcImg, srcFace));
  const L = await latent(emb);
  // vùng làm việc (region) quanh mặt đích
  const M128 = similarity(dstFace.kps, ARC.map(([x, y]) => [x * 128 / 112, y * 128 / 112]));
  const inv = invert(M128);
  const cs = [[0, 0], [128, 0], [0, 128], [128, 128]].map(([x, y]) => apply(inv, x, y));
  let rx0 = Math.min(...cs.map(p => p[0])), ry0 = Math.min(...cs.map(p => p[1])), rx1 = Math.max(...cs.map(p => p[0])), ry1 = Math.max(...cs.map(p => p[1]));
  const pad = (rx1 - rx0) * 0.05; rx0 = Math.max(0, Math.floor(rx0 - pad)); ry0 = Math.max(0, Math.floor(ry0 - pad)); rx1 = Math.min(dstImg.width, Math.ceil(rx1 + pad)); ry1 = Math.min(dstImg.height, Math.ceil(ry1 + pad));
  const rw = rx1 - rx0, rh = ry1 - ry0;
  const region = { x: rx0, y: ry0, w: rw, h: rh };
  const orig = canvas(rw, rh); ctx2d(orig).drawImage(dstImg, rx0, ry0, rw, rh, 0, 0, rw, rh);
  const kps = dstFace.kps.map(([x, y]) => [x - rx0, y - ry0]);
  step('Ghép mặt (inswapper)…', 0.3);
  const M = similarity(kps, ARC.map(([x, y]) => [x * 128 / 112, y * 128 / 112]));
  const crop = warp(orig, M, 128, 128);
  const tin = toTensor(crop, [0, 0, 0], [255, 255, 255]);
  const [so] = await t('inswapper', () => run('inswapper', [[tin, [1, 3, 128, 128]], [L, [1, 512]]]));
  const sw = Float32Array.from(so.data);
  if (o.colorMatch) colorMatch(sw, tin, 128 * 128, 0.6);
  const am = rectMask(128, 0.06, 0.06);
  const swc = tensorToCanvas(sw, 128, v => clamp255(v * 255), am);
  const swapped = canvas(rw, rh); const g = ctx2d(swapped); g.drawImage(orig, 0, 0);
  const IM = invert(M); g.imageSmoothingQuality = 'high'; g.setTransform(IM[0], IM[3], IM[1], IM[4], IM[2], IM[5]); g.drawImage(swc, 0, 0); g.setTransform(1, 0, 0, 1, 0, 0);
  const Mf = similarity(kps, FFHQ); const IMf = invert(Mf);
  if (o.restore) {
    step('Làm nét mặt (GFPGAN)…', 0.55);
    const fc = warp(swapped, Mf, 512, 512);
    const [ro] = await t('gfpgan', () => run('gfpgan', [[toTensor(fc, [127.5, 127.5, 127.5], [127.5, 127.5, 127.5]), [1, 3, 512, 512]]]));
    const rm = rectMask(512, 0.04, 0.05); for (let i = 0; i < rm.length; i++) rm[i] *= o.restoreAmt;
    const rc = tensorToCanvas(ro.data, 512, v => clamp255((v + 1) * 127.5), rm);
    g.setTransform(IMf[0], IMf[3], IMf[1], IMf[4], IMf[2], IMf[5]); g.drawImage(rc, 0, 0); g.setTransform(1, 0, 0, 1, 0, 0);
  }
  // mặt nạ phân vùng (BiSeNet) trên ảnh đích GỐC → loại tóc, tai, cổ, kính, vật che
  step('Khóa vùng mặt (BiSeNet)…', 0.8);
  const fo = warp(orig, Mf, 512, 512);
  const [po] = await t('bisenet', () => run('bisenet', [[toTensor(fo, [0.485 * 255, 0.456 * 255, 0.406 * 255], [0.229 * 255, 0.224 * 255, 0.225 * 255]), [1, 3, 512, 512]]]));
  const lg = po.data, N = 512 * 512; const cls = new Uint8Array(N);
  for (let i = 0; i < N; i++) { let b = 0, bv = -1e9; for (let k = 0; k < 19; k++) { const v = lg[k * N + i]; if (v > bv) { bv = v; b = k; } } cls[i] = b; }
  // ô vuông inswapper (vùng có dữ liệu ghép) trong toạ độ region
  const sq = canvas(rw, rh); { const q = ctx2d(sq); q.setTransform(IM[0], IM[3], IM[1], IM[4], IM[2], IM[5]); q.fillStyle = '#fff'; q.fillRect(128 * 0.1, 128 * 0.1, 128 * 0.8, 128 * 0.8); }
  const sqA = ctx2d(sq).getImageData(0, 0, rw, rh).data;
  const job = { dstImg, region, orig, swapped, cls, IMf, sqA, opts: o, edits: null, times, srcFace, dstFace };
  job.edits = new Int8Array(rw * rh); // +1 thêm, -1 xóa (cọ vẽ)
  step('Ghép lại toàn ảnh…', 0.92);
  await t('compose', async () => compose(job));
  times.total = Math.round(performance.now() - T0);
  step('Xong', 1);
  return job;
}

/** Tạo mặt nạ nhị phân B (toạ độ region) từ cls + tùy chọn + nét cọ. */
export function baseMask(job) {
  const { region: { w, h }, cls, IMf, sqA, opts } = job;
  const keep = new Uint8Array(19); for (const c of FACE_CLASSES) keep[c] = 1; if (opts.keepMouth) keep[11] = keep[12] = keep[13] = 0;
  const mc = canvas(512, 512); const g = ctx2d(mc); const im = g.createImageData(512, 512);
  for (let i = 0; i < 512 * 512; i++) { im.data[i * 4 + 3] = keep[cls[i]] ? 255 : 0; }
  g.putImageData(im, 0, 0);
  const B = new Uint8Array(w * h);
  if (opts.lock) {
    const rc = canvas(w, h); const q = ctx2d(rc); q.setTransform(IMf[0], IMf[3], IMf[1], IMf[4], IMf[2], IMf[5]); q.drawImage(mc, 0, 0);
    const a = q.getImageData(0, 0, w, h).data; for (let i = 0; i < w * h; i++) B[i] = a[i * 4 + 3] > 127 && sqA[i * 4 + 3] > 127 ? 1 : 0;
  } else { for (let i = 0; i < w * h; i++) B[i] = sqA[i * 4 + 3] > 127 ? 1 : 0; }
  const E = job.edits; for (let i = 0; i < w * h; i++) { if (E[i] > 0) B[i] = 1; else if (E[i] < 0) B[i] = 0; }
  return B;
}
/** Ghép cuối: chỉ thay pixel trong mặt nạ; ngoài mặt nạ giữ nguyên từng byte. */
export function compose(job) {
  const { region: { x, y, w, h }, dstImg } = job;
  const B = baseMask(job); job.B = B;
  let cnt = 0; for (const v of B) cnt += v;
  const r = Math.max(2, Math.sqrt(cnt) * 0.04);
  const soft = blur(Float32Array.from(B), w, h, r);
  const m = new Float32Array(w * h); for (let i = 0; i < w * h; i++) m[i] = B[i] ? Math.min(1, Math.max(0, (soft[i] - 0.5) * 2.2)) : 0;
  job.alpha = m;
  const out = canvas(dstImg.width, dstImg.height); const g = ctx2d(out); g.drawImage(dstImg, 0, 0);
  const T = g.getImageData(x, y, w, h); const Sd = ctx2d(job.swapped).getImageData(0, 0, w, h).data; const d = T.data;
  for (let i = 0; i < w * h; i++) { const a = m[i]; if (a <= 0) continue; const j = i * 4; for (let k = 0; k < 3; k++) d[j + k] = Math.round(d[j + k] + (Sd[j + k] - d[j + k]) * a); }
  g.putImageData(T, x, y);
  job.result = out; return out;
}
/** Kiểm tra: số pixel khác nhau NGOÀI mặt nạ (phải = 0). */
export function diffOutsideMask(job) {
  const A = ctx2d(canvas2(job.dstImg)).getImageData(0, 0, job.dstImg.width, job.dstImg.height).data;
  const R = ctx2d(job.result).getImageData(0, 0, job.result.width, job.result.height).data;
  const { x, y, w, h } = job.region; let bad = 0, changed = 0;
  for (let py = 0; py < job.result.height; py++) for (let px = 0; px < job.result.width; px++) {
    const i = (py * job.result.width + px) * 4; const same = A[i] === R[i] && A[i + 1] === R[i + 1] && A[i + 2] === R[i + 2];
    if (same) continue; changed++;
    const lx = px - x, ly = py - y; const inside = lx >= 0 && ly >= 0 && lx < w && ly < h && job.B[ly * w + lx];
    if (!inside) bad++;
  }
  return { outside: bad, changed };
}
function canvas2(c) { const k = canvas(c.width, c.height); ctx2d(k).drawImage(c, 0, 0); return k; }
/** Vẽ cọ (toạ độ ảnh gốc). mode: 1 thêm, -1 xóa, 0 hoàn tác vùng. */
export function brush(job, px, py, radius, mode) {
  const { x, y, w, h } = job.region; const E = job.edits; const cx = px - x, cy = py - y, r2 = radius * radius;
  for (let yy = Math.max(0, Math.floor(cy - radius)); yy < Math.min(h, Math.ceil(cy + radius)); yy++)
    for (let xx = Math.max(0, Math.floor(cx - radius)); xx < Math.min(w, Math.ceil(cx + radius)); xx++)
      if ((xx - cx) ** 2 + (yy - cy) ** 2 <= r2) E[yy * w + xx] = mode;
}
export function upscaleTo(c, longEdge) {
  const s = longEdge / Math.max(c.width, c.height); if (s <= 1) return c;
  // phóng nhiều bước để mịn hơn
  let cur = c; while (Math.max(cur.width, cur.height) * 1.5 < longEdge) { const n = canvas(Math.round(cur.width * 1.5), Math.round(cur.height * 1.5)); const g = ctx2d(n); g.imageSmoothingQuality = 'high'; g.drawImage(cur, 0, 0, n.width, n.height); cur = n; }
  const n = canvas(Math.round(c.width * s), Math.round(c.height * s)); const g = ctx2d(n); g.imageSmoothingQuality = 'high'; g.drawImage(cur, 0, 0, n.width, n.height); return n;
}
