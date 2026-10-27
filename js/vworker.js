// Ghép Mặt Video — worker giữ phiên det_10g / ArcFace / inswapper_128 / BiSeNet (+ GFPGAN tuỳ chọn) suốt cả clip.
// Mỗi khung: dò mặt (vùng quanh mặt đang bám, 320 px) → bám theo IoU + ArcFace → lọc One Euro 5 điểm mốc →
// inswapper trên khung căn chuẩn → mặt nạ BiSeNet (làm mượt theo thời gian, viền mềm, giữ trong miệng gốc) → ghép lại.
// Khung không thấy mặt / độ tin thấp → trả nguyên khung gốc.
let S = null, ort = null;
const ARC = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
const T128 = [[0.36167656, 0.40387734], [0.63696719, 0.40235469], [0.50019687, 0.56044219], [0.38710391, 0.72160547], [0.61507734, 0.72034453]].map(([x, y]) => [x * 128, y * 128]);
const FFHQ = [[0.37691676, 0.46864664], [0.62285697, 0.46912813], [0.50123859, 0.61331904], [0.39308822, 0.72541100], [0.61150205, 0.72490465]].map(([x, y]) => [x * 512, y * 512]);
const FACE_CLASSES = [1, 2, 3, 4, 5, 10, 11, 12, 13];   // da, mày, mắt, mũi, trong miệng, môi
const NSFW_BLOCK = 0.75;                                 // ngưỡng riêng của tính năng video (không phụ thuộc safety.js)
const MS = 256;                                          // độ phân giải mặt nạ (không gian mặt đã căn)

// ---------- tiện ích ảnh (OffscreenCanvas) ----------
const cv = (w, h) => new OffscreenCanvas(w, h);
const cx = (c) => c.getContext('2d', { willReadFrequently: true });
function similarity(src, dst) {
  const n = src.length; let mx = 0, my = 0, ux = 0, uy = 0;
  for (let i = 0; i < n; i++) { mx += src[i][0]; my += src[i][1]; ux += dst[i][0]; uy += dst[i][1]; }
  mx /= n; my /= n; ux /= n; uy /= n; let sxx = 0, a = 0, b = 0;
  for (let i = 0; i < n; i++) { const x = src[i][0] - mx, y = src[i][1] - my, u = dst[i][0] - ux, v = dst[i][1] - uy; sxx += x * x + y * y; a += x * u + y * v; b += x * v - y * u; }
  a /= sxx; b /= sxx; return [a, -b, ux - (a * mx - b * my), b, a, uy - (b * mx + a * my)];
}
function invert(M) { const [a, b, c, d, e, f] = M; const det = a * e - b * d; const ia = e / det, ib = -b / det, id = -d / det, ie = a / det; return [ia, ib, -(ia * c + ib * f), id, ie, -(id * c + ie * f)]; }
const apply = (M, x, y) => [M[0] * x + M[1] * y + M[2], M[3] * x + M[4] * y + M[5]];
const setT = (g, M) => g.setTransform(M[0], M[3], M[1], M[4], M[2], M[5]);
function warp(src, M, w, h) { const c = cv(w, h); const g = cx(c); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; setT(g, M); g.drawImage(src, 0, 0); return c; }
function tensor(c, mean, std, bgr = false, chw = true) {
  const { width: w, height: h } = c; const d = cx(c).getImageData(0, 0, w, h).data; const n = w * h; const o = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { const v = (d[i * 4 + (bgr ? 2 - k : k)] - mean[k]) / std[k]; if (chw) o[k * n + i] = v; else o[i * 3 + k] = v; }
  return o;
}
function blur(a, w, h, r) {
  r = Math.max(1, Math.round(r)); let src = a; const tmp = new Float32Array(a.length); const k = 2 * r + 1;
  for (let p = 0; p < 3; p++) {
    const dst = new Float32Array(a.length);
    for (let y = 0; y < h; y++) { const o = y * w; let s = 0; for (let x = -r; x <= r; x++) s += src[o + Math.min(w - 1, Math.max(0, x))]; for (let x = 0; x < w; x++) { tmp[o + x] = s / k; s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)]; } }
    for (let x = 0; x < w; x++) { let s = 0; for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]; for (let y = 0; y < h; y++) { dst[y * w + x] = s / k; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; } }
    src = dst;
  }
  return src;
}
function rectMask(size, inset, feather) { const m = new Float32Array(size * size); const i0 = Math.round(size * inset), i1 = size - i0; for (let y = i0; y < i1; y++) for (let x = i0; x < i1; x++) m[y * size + x] = 1; return blur(m, size, size, size * feather); }
const RECT128 = rectMask(128, 0.05, 0.05);
const iou = (a, b) => { const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]); const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i + 1e-9); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
function norm(e) { let n = 0; for (const v of e) n += v * v; n = Math.sqrt(n) || 1; for (let i = 0; i < e.length; i++) e[i] /= n; return e; }

// ---------- lọc One Euro (ít trễ khi đầu chuyển động nhanh, khử rung khi đứng yên) ----------
const lpA = (cut, dt) => { const tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / dt); };
class OneEuro {
  constructor(minC, beta, dC = 1) { this.minC = minC; this.beta = beta; this.dC = dC; this.reset(); }
  reset() { this.x = null; this.dx = 0; this.t = null; }
  f(x, t, scale) {
    if (this.x == null) { this.x = x; this.t = t; this.dx = 0; return x; }
    const dt = Math.max(1e-3, t - this.t); this.t = t;
    const d = (x - this.x) / dt; this.dx += lpA(this.dC, dt) * (d - this.dx);
    const c = this.minC + this.beta * Math.abs(this.dx) / scale;   // tốc độ tính theo cỡ mặt (không phụ thuộc độ phân giải)
    this.x += lpA(c, dt) * (x - this.x); return this.x;
  }
}

// ---------- model ----------
const sess = {};
let opts = { gpu: false, restore: false, keepMouth: true, color: true, restoreAmt: 0.6 };
const prog = (label) => (d, t) => self.postMessage({ prog: [d, t, label] });
async function get(group, id, label) { const k = group + '/' + id; if (!sess[k]) sess[k] = await S.session(group, id, prog(label)); return sess[k]; }
async function run(group, id, feeds) {
  const s = await get(group, id); const f = {};
  feeds.forEach(([data, dims], i) => { f[s.inputNames[i]] = new ort.Tensor('float32', data, dims); });
  const out = await s.run(f); return s.outputNames.map(n => out[n]);
}
const arr = (t) => t.data instanceof Float32Array ? t.data : Float32Array.from(t.data);

// Dò mặt trên một ô vuông (sx,sy,side) của ảnh, thu về D×D. Trả toạ độ ảnh gốc.
async function detect(img, sx, sy, side, D, thr = 0.45) {
  const c = cv(D, D); const g = cx(c); g.fillStyle = '#000'; g.fillRect(0, 0, D, D); g.imageSmoothingQuality = 'high';
  const sc = D / side; g.drawImage(img, sx, sy, side, side, 0, 0, D, D);
  const out = await run('face', 'det', [[tensor(c, [127.5, 127.5, 127.5], [128, 128, 128]), [1, 3, D, D]]]);
  const faces = [];
  [8, 16, 32].forEach((st, k) => {
    const s_ = arr(out[k]), bb = arr(out[k + 3]), kp = arr(out[k + 6]); const fw = D / st;
    for (let i = 0; i < s_.length; i++) {
      if (s_[i] < thr) continue;
      const p = i >> 1, ax = (p % fw) * st, ay = Math.floor(p / fw) * st;
      const box = [ax - bb[i * 4] * st, ay - bb[i * 4 + 1] * st, ax + bb[i * 4 + 2] * st, ay + bb[i * 4 + 3] * st].map((v, j) => v / sc + (j % 2 ? sy : sx));
      const kps = []; for (let j = 0; j < 5; j++) kps.push([(ax + kp[i * 10 + j * 2] * st) / sc + sx, (ay + kp[i * 10 + j * 2 + 1] * st) / sc + sy]);
      faces.push({ score: s_[i], box, kps });
    }
  });
  faces.sort((a, b) => b.score - a.score); const keep = [];
  for (const f of faces) if (!keep.some(k => iou(k.box, f.box) > 0.4)) keep.push(f);
  return keep;
}
const fullDetect = (img) => { const side = Math.max(img.width, img.height); return detect(img, 0, 0, side, 640); };
async function embed(img, kps) {
  const crop = warp(img, similarity(kps, ARC), 112, 112);
  const [o] = await run('face', 'arcface', [[tensor(crop, [127.5, 127.5, 127.5], [127.5, 127.5, 127.5]), [1, 3, 112, 112]]]);
  return norm(Float32Array.from(o.data));
}
let EMAP = null;
async function latent(emb) {
  if (!EMAP) { const b = await S.extra('swap', 'inswapper_128', 'emap.bin'); EMAP = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
  const L = new Float32Array(512);
  for (let i = 0; i < 512; i++) { const e = emb[i]; if (!e) continue; const o = i * 512; for (let j = 0; j < 512; j++) L[j] += e * EMAP[o + j]; }
  return norm(L);
}

// ---------- trạng thái bám mặt ----------
const T = { src: null, ref: null, ref0: null, first: null, track: null, filt: [], prevSig: null, mask: null, mouth: null, cstat: null, gain: 0, lastId: -99, idx: 0 };
function resetTrack(face) {
  T.track = face ? { box: face.box, kps: face.kps } : null; T.filt = Array.from({ length: 10 }, () => new OneEuro(opts.minCutoff ?? 1.0, opts.beta ?? 1.5, 1.0));
  T.mask = null; T.mouth = null; T.cstat = null; T.gain = 1; T.lastId = -99; T.prevSig = null;
}
function frameSig(img) { const c = cv(32, 18); const g = cx(c); g.drawImage(img, 0, 0, 32, 18); const d = g.getImageData(0, 0, 32, 18).data; const s = new Float32Array(32 * 18); for (let i = 0; i < s.length; i++) s[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11; return s; }
function isCut(sig) { if (!T.prevSig) return false; let m = 0; for (let i = 0; i < sig.length; i++) m += Math.abs(sig[i] - T.prevSig[i]); return m / sig.length > 38; }
const scaleOf = (kps) => Math.hypot((kps[0][0] + kps[1][0]) / 2 - (kps[3][0] + kps[4][0]) / 2, (kps[0][1] + kps[1][1]) / 2 - (kps[3][1] + kps[4][1]) / 2) || 1;
function yawOf(k) { // 0 = nhìn thẳng; ~1 = nghiêng hẳn sang ngang
  const ex = (k[0][0] + k[1][0]) / 2, ey = (k[0][1] + k[1][1]) / 2; const vx = k[1][0] - k[0][0], vy = k[1][1] - k[0][1]; const L = Math.hypot(vx, vy) || 1;
  const px = ((k[2][0] - ex) * vx + (k[2][1] - ey) * vy) / L; return Math.abs(px) / (L * 0.5);
}

async function locate(img, info) {
  const sig = frameSig(img); const cut = isCut(sig); T.prevSig = sig; info.cut = cut;
  if (cut) { const r = T.ref; resetTrack(null); T.prevSig = sig; T.ref = r; }
  let cands = [], tb = T.track?.box;
  if (tb && !cut) {
    const w = tb[2] - tb[0], h = tb[3] - tb[1]; const side = Math.max(w, h) * 2.2; const mx = (tb[0] + tb[2]) / 2, my = (tb[1] + tb[3]) / 2;
    cands = await detect(img, mx - side / 2, my - side / 2, side, 320, 0.4);
  }
  let full = false;
  if (!cands.length) { cands = await fullDetect(img); full = true; }
  if (!cands.length) return null;
  let best = null, bi = 0;
  if (tb) for (const c of cands) { const v = iou(c.box, tb); if (v > bi) { bi = v; best = c; } }
  const crowd = tb ? cands.filter(c => iou(c.box, tb) > 0.1).length : cands.length;
  const needId = !T.track || !best || bi < 0.3 || crowd > 1 || full || T.idx - T.lastId >= 15;
  if (needId) {
    let top = null, ts = -1; const list = (best && bi >= 0.3 ? [best, ...cands.filter(c => c !== best)] : cands).slice(0, 4);
    for (const c of list) { if (c.score < 0.5 && !(c === best && bi > 0.5)) continue; const e = await embed(img, c.kps); const s = Math.max(dot(e, T.ref), dot(e, T.ref0)); if (s > ts) { ts = s; top = c; top.e = e; } }
    info.sim = +ts.toFixed(3); T.lastId = T.idx;
    if (!top || ts < 0.28) return null;
    if (ts > 0.5) { for (let i = 0; i < 512; i++) T.ref[i] = 0.9 * T.ref[i] + 0.1 * top.e[i]; norm(T.ref); }
    best = top;
  }
  if (!best || best.score < (T.track ? 0.4 : 0.55)) return null;
  return best;
}

function colorStats(out, ref) { // thống kê màu trong elip trung tâm (128 px)
  const n = 128 * 128; const st = new Float32Array(12); let cnt = 0;
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const dx = (x - 64) / 40, dy = (y - 72) / 48; if (dx * dx + dy * dy >= 1) continue; const i = y * 128 + x; cnt++;
    for (let k = 0; k < 3; k++) { const a = out[k * n + i], b = ref[k * n + i]; st[k] += a; st[3 + k] += b; st[6 + k] += a * a; st[9 + k] += b * b; }
  }
  const r = new Float32Array(9);
  for (let k = 0; k < 3; k++) { const ms = st[k] / cnt, mt = st[3 + k] / cnt; const vs = st[6 + k] / cnt - ms * ms, vt = st[9 + k] / cnt - mt * mt; r[k] = ms; r[3 + k] = mt; r[6 + k] = Math.min(1.4, Math.max(0.7, Math.sqrt(Math.max(vt, 1e-8) / Math.max(vs, 1e-8)))); }
  return r;
}

async function swapFrame(img, t) {
  const t0 = performance.now(); const info = { found: false };
  const face = await locate(img, info); const tm = info.tm = { loc: Math.round(performance.now() - t0) }; let tq = performance.now(); const lap = (k) => { const n = performance.now(); tm[k] = Math.round(n - tq); tq = n; };
  T.idx++;
  if (!face) { T.track = null; T.gain = 0; for (const f of T.filt) f.reset(); T.mask = null; T.mouth = null; info.ms = Math.round(performance.now() - t0); return { canvas: null, info }; }
  info.found = true; info.score = +face.score.toFixed(3);
  // làm mượt 5 điểm mốc
  const s = scaleOf(face.kps); const k = face.kps.map(([x, y], j) => [T.filt[j * 2].f(x, t, s), T.filt[j * 2 + 1].f(y, t, s)]);
  T.track = { box: face.box, kps: k }; info.kps = k; info.raw = face.kps;
  const yaw = yawOf(k); info.yaw = +yaw.toFixed(2);
  const want = yaw > 0.95 ? 0 : yaw > 0.75 ? (0.95 - yaw) / 0.2 : 1;     // nghiêng quá ~60° → nhả dần về khung gốc
  T.gain = Math.min(want, T.gain + 0.34); if (T.gain <= 0.01) { info.ms = Math.round(performance.now() - t0); info.found = false; info.profile = true; return { canvas: null, info }; }
  // vùng làm việc
  const M = similarity(k, T128), Mf = similarity(k, FFHQ), IMf = invert(Mf), IM = invert(M);
  const cs = [[0, 0], [512, 0], [0, 512], [512, 512]].map(([x, y]) => apply(IMf, x, y));
  const W = img.width, H = img.height;
  const rx0 = Math.max(0, Math.floor(Math.min(...cs.map(p => p[0])))), ry0 = Math.max(0, Math.floor(Math.min(...cs.map(p => p[1]))));
  const rx1 = Math.min(W, Math.ceil(Math.max(...cs.map(p => p[0])))), ry1 = Math.min(H, Math.ceil(Math.max(...cs.map(p => p[1]))));
  const rw = rx1 - rx0, rh = ry1 - ry0; if (rw < 8 || rh < 8) return { canvas: null, info };
  // inswapper
  const crop = warp(img, M, 128, 128); const cin = tensor(crop, [0, 0, 0], [255, 255, 255]);
  const [so] = await run('swap', 'inswapper_128', [[cin, [1, 3, 128, 128]], [T.src, [1, 512]]]);
  lap('swap'); const sw = Float32Array.from(so.data); const n = 128 * 128;
  for (let i = 0; i < sw.length; i++) sw[i] = sw[i] < 0 ? 0 : sw[i] > 1 ? 1 : sw[i];
  if (opts.color) { // khớp màu theo cảnh, ổn định qua vài khung (EMA, đặt lại khi chuyển cảnh)
    const cs_ = colorStats(sw, cin); if (!T.cstat) T.cstat = cs_; else for (let i = 0; i < 9; i++) T.cstat[i] += 0.2 * (cs_[i] - T.cstat[i]);
    const c = T.cstat, str = 0.6;
    for (let kk = 0; kk < 3; kk++) for (let i = 0; i < n; i++) { const v0 = sw[kk * n + i]; const v = (v0 - c[kk]) * c[6 + kk] + c[3 + kk]; sw[kk * n + i] = Math.min(1, Math.max(0, v0 + (v - v0) * str)); }
  }
  const sc = cv(128, 128); { const g = cx(sc); const im = g.createImageData(128, 128); const d = im.data; for (let i = 0; i < n; i++) { d[i * 4] = sw[i] * 255; d[i * 4 + 1] = sw[n + i] * 255; d[i * 4 + 2] = sw[2 * n + i] * 255; d[i * 4 + 3] = RECT128[i] * 255; } g.putImageData(im, 0, 0); }
  const orig = cv(rw, rh); cx(orig).drawImage(img, rx0, ry0, rw, rh, 0, 0, rw, rh);
  const swr = cv(rw, rh); const gs = cx(swr); gs.drawImage(orig, 0, 0); gs.imageSmoothingQuality = 'high';
  const IMr = [IM[0], IM[1], IM[2] - rx0, IM[3], IM[4], IM[5] - ry0]; setT(gs, IMr); gs.drawImage(sc, 0, 0); gs.setTransform(1, 0, 0, 1, 0, 0);
  const Mfr = similarity(k.map(([x, y]) => [x - rx0, y - ry0]), FFHQ), IMfr = invert(Mfr);
  if (opts.restore) {
    const fc = warp(swr, Mfr, 512, 512);
    const [ro] = await run('restore', 'gfpgan_1.4', [[tensor(fc, [127.5, 127.5, 127.5], [127.5, 127.5, 127.5]), [1, 3, 512, 512]]]);
    const rd = ro.data, N = 512 * 512, rm = rectMask(512, 0.04, 0.05); const rc = cv(512, 512); const g = cx(rc); const im = g.createImageData(512, 512); const d = im.data;
    for (let i = 0; i < N; i++) { d[i * 4] = (rd[i] + 1) * 127.5; d[i * 4 + 1] = (rd[N + i] + 1) * 127.5; d[i * 4 + 2] = (rd[2 * N + i] + 1) * 127.5; d[i * 4 + 3] = rm[i] * opts.restoreAmt * 255; }
    g.putImageData(im, 0, 0); setT(gs, IMfr); gs.drawImage(rc, 0, 0); gs.setTransform(1, 0, 0, 1, 0, 0);
  }
  // mặt nạ BiSeNet trên khung GỐC (căn FFHQ 512) → hạ về 256, làm mượt theo thời gian
  const fo = warp(orig, Mfr, 512, 512);
  const [po] = await run('face', 'bisenet', [[tensor(fo, [0.485 * 255, 0.456 * 255, 0.406 * 255], [0.229 * 255, 0.224 * 255, 0.225 * 255]), [1, 3, 512, 512]]]);
  lap('parse'); const lg = po.data, N = 512 * 512; const keep = new Uint8Array(19); for (const c of FACE_CLASSES) keep[c] = 1;
  const mf = new Float32Array(MS * MS), mm = new Float32Array(MS * MS);
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    const i = y * 512 + x; let b = 0, bv = -1e9; for (let c = 0; c < 19; c++) { const v = lg[c * N + i]; if (v > bv) { bv = v; b = c; } }
    const j = (y >> 1) * MS + (x >> 1); if (keep[b]) mf[j] += 0.25; if (b === 11) mm[j] += 0.25;
  }
  if (!T.mask) { T.mask = mf; T.mouth = mm; } else { for (let i = 0; i < mf.length; i++) { T.mask[i] += 0.65 * (mf[i] - T.mask[i]); T.mouth[i] += 0.8 * (mm[i] - T.mouth[i]); } }
  const sf = blur(T.mask, MS, MS, 4), smth = opts.keepMouth ? blur(T.mouth, MS, MS, 2) : null;
  const mc = cv(MS, MS); { const g = cx(mc); const im = g.createImageData(MS, MS); const d = im.data;
    for (let i = 0; i < MS * MS; i++) { let a = Math.min(1, Math.max(0, (sf[i] - 0.4) * 2.4)); if (smth) a *= 1 - Math.min(1, Math.max(0, (smth[i] - 0.25) * 2.2)); d[i * 4 + 3] = a * 255; }
    g.putImageData(im, 0, 0); }
  const ar = cv(rw, rh); const ga = cx(ar); ga.imageSmoothingQuality = 'high'; const IMs = invert(similarity(k.map(([x, y]) => [x - rx0, y - ry0]), FFHQ.map(([x, y]) => [x / 2, y / 2]))); setT(ga, IMs); ga.drawImage(mc, 0, 0);
  const A = ga.getImageData(0, 0, rw, rh).data; const Sd = gs.getImageData(0, 0, rw, rh).data; const og = cx(orig); const O = og.getImageData(0, 0, rw, rh); const od = O.data;
  // vùng thực sự có dữ liệu ghép = ô 128 (đã có viền mềm ở alpha của sc)
  const sq = cv(rw, rh); const gq = cx(sq); setT(gq, IMr); gq.drawImage(sc, 0, 0); const Q = gq.getImageData(0, 0, rw, rh).data;
  const gain = T.gain; if (opts.debug) { let sa = 0, sq_ = 0, sd = 0; for (let i = 0; i < rw * rh; i++) { sa += A[i * 4 + 3]; sq_ += Q[i * 4 + 3]; sd += Math.abs(Sd[i * 4] - od[i * 4]); } info.st = [sa / rw / rh, sq_ / rw / rh, sd / rw / rh, gain]; }
  for (let i = 0; i < rw * rh; i++) { const a = (A[i * 4 + 3] / 255) * Math.min(1, Q[i * 4 + 3] / 200) * gain; if (a <= 0.004) continue; const j = i * 4; for (let c = 0; c < 3; c++) od[j + c] = od[j + c] + (Sd[j + c] - od[j + c]) * a; }
  const outc = cv(W, H); const g = cx(outc); g.drawImage(img, 0, 0); g.putImageData(O, rx0, ry0);
  lap('comp'); if (opts.debug) { info.dbg = { sc: sc.transferToImageBitmap(), mc: mc.transferToImageBitmap() }; }
  info.region = [rx0, ry0, rw, rh]; info.ms = Math.round(performance.now() - t0);
  return { canvas: outc, info };
}

// ---------- RPC ----------
const H = {
  async init(m) {
    opts = { ...opts, ...(m.opts || {}) }; if (m.lite) self.__lite = true; if (opts.gpu) self.__gpu = true; if (m.threads) self.__threads = m.threads;
    S = await import('./store.js'); ort = await S.getOrt(opts.gpu ? undefined : 'wasm');
    return { backend: S.backendLabel(), lowMem: S.lowMem };
  },
  setOpts(m) { const was = opts.restore; opts = { ...opts, ...m.opts }; if (was && !opts.restore && sess['restore/gfpgan_1.4']) { S.release('restore', 'gfpgan_1.4'); delete sess['restore/gfpgan_1.4']; } return {}; },
  async load(m) { for (const [g, id, label] of m.list) await get(g, id, label); return { backend: S.backendLabel() }; },
  async nsfw(m) {
    const img = m.bitmap; const c = cv(224, 224); const g = cx(c); g.imageSmoothingQuality = 'high'; const s = Math.min(img.width, img.height);
    g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 224, 224); img.close?.();
    const [o] = await run('face', 'nsfw', [[tensor(c, [104, 117, 123], [1, 1, 1], true, false), [1, 224, 224, 3]]]);
    const score = o.data[1]; return { score, block: score >= NSFW_BLOCK };
  },
  async nsfwDone() { if (sess['face/nsfw']) { await S.release('face', 'nsfw'); delete sess['face/nsfw']; } return {}; },
  async source(m) {
    const faces = await fullDetect(m.bitmap); if (!faces.length) { m.bitmap.close?.(); return { n: 0 }; }
    const area = f => (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]); faces.sort((a, b) => area(b) - area(a));
    const e = await embed(m.bitmap, faces[0].kps); m.bitmap.close?.(); T.src = await latent(e); T.srcEmb = e; return { n: faces.length, box: faces[0].box };
  },
  async faces(m) {
    const faces = await fullDetect(m.bitmap); const area = f => (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]); faces.sort((a, b) => area(b) - area(a));
    if (T.first) T.first.close?.(); T.first = m.bitmap; T.firstFaces = faces;
    return { faces: faces.map(f => ({ box: f.box, score: f.score })) };
  },
  async select(m) {
    const f = T.firstFaces[m.index]; if (!f) throw new Error('Không thấy khuôn mặt đã chọn.');
    T.ref0 = await embed(T.first, f.kps); T.ref = Float32Array.from(T.ref0); T.sel = f; resetTrack(f); T.idx = 0;
    return { sim: T.srcEmb ? +dot(T.srcEmb, T.ref0).toFixed(3) : null };
  },
  reset(m) { resetTrack(m.fromFirst === false ? null : T.sel); T.idx = 0; T.ref = Float32Array.from(T.ref0); return {}; },
  async frame(m) {
    if (m.fresh) { resetTrack(null); T.ref = Float32Array.from(T.ref0); }
    const r = await swapFrame(m.bitmap, m.t);
    let bmp; if (r.canvas) { bmp = r.canvas.transferToImageBitmap(); m.bitmap.close?.(); } else bmp = m.bitmap;   // không có mặt: trả nguyên khung gốc
    const tr = [bmp]; if (r.info.dbg) tr.push(r.info.dbg.sc, r.info.dbg.mc);
    return { bitmap: bmp, info: r.info, transfer: tr };
  },
  async release() { for (const k of Object.keys(sess)) { const [g, id] = [k.slice(0, k.indexOf('/')), k.slice(k.indexOf('/') + 1)]; await S.release(g, id); delete sess[k]; } return {}; },
};
self.onmessage = async ({ data: m }) => {
  try { const r = await H[m.kind](m); const tr = r.transfer || []; delete r.transfer; self.postMessage({ id: m.id, ok: true, ...r }, tr); }
  catch (e) { console.warn(e); self.postMessage({ id: m.id, ok: false, err: S ? S.friendlyError(e) : String(e?.message || e), name: e?.name }); }
};
