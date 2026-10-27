// Ghép Mặt AI — InsightFace (det_10g + ArcFace w600k_r50 + inswapper_128) + GFPGAN 1.4 + BiSeNet (khóa vùng mặt).
import * as S from './store.js';
import { canvas, ctx2d, similarity, invert, apply, translate, warp, toTensor, blur, rectMask } from './img.js';

const ARC = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
// mẫu căn mặt (chuẩn hoá 0..1) giống FaceFusion
export const TEMPLATES = {
  arcface_128: [[0.36167656, 0.40387734], [0.63696719, 0.40235469], [0.50019687, 0.56044219], [0.38710391, 0.72160547], [0.61507734, 0.72034453]],
  arcface_112_v1: [[0.35473214, 0.45658929], [0.64526786, 0.45658929], [0.5, 0.61154464], [0.37913393, 0.776875], [0.62086607, 0.776875]],
  arcface_112_v2: [[0.34191607, 0.46157411], [0.65653393, 0.45983393], [0.500225, 0.64050536], [0.37097589, 0.82469196], [0.63151696, 0.82325089]],
  ffhq_512: [[0.37691676, 0.46864664], [0.62285697, 0.46912813], [0.50123859, 0.61331904], [0.39308822, 0.72541100], [0.61150205, 0.72490465]],
};
const tpl = (name, s) => TEMPLATES[name].map(([x, y]) => [x * s, y * s]);
const FFHQ = tpl('ffhq_512', 512);
export const FACE_MODELS = ['det', 'arcface', 'bisenet', 'nsfw'];   // luôn cần; model ghép/làm nét chọn riêng
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
  const raw = Float32Array.from(o.data); const e = norm(Float32Array.from(raw)); e.raw = raw;
  return e;
}
function norm(e) { let n = 0; for (const v of e) n += v * v; n = Math.sqrt(n) || 1; for (let i = 0; i < e.length; i++) e[i] /= n; return e; }
const EMAPS = new Map();
function latent(emb, EMAP) {
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

// ---------- hồ sơ model (preset) ----------
// emb: 'emap' (inswapper) | 'norm' | 'conv:<id>' | 'convraw:<id>' | 'img:<template>:<size>'
export const SWAP_PRESETS = {
  inswapper: { label: 'inswapper (128)', size: 128, template: 'arcface_128', mean: [0, 0, 0], std: [1, 1, 1], emb: 'emap', cm: 0.6 },
  hyperswap: { label: 'HyperSwap (256)', size: 256, template: 'arcface_128', mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], emb: 'norm', denorm: true },
  simswap_256: { label: 'SimSwap 256', size: 256, template: 'arcface_112_v1', mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], emb: 'conv:crossface_simswap' },
  simswap_512: { label: 'SimSwap 512 (unofficial)', size: 512, template: 'arcface_112_v1', mean: [0, 0, 0], std: [1, 1, 1], emb: 'conv:crossface_simswap' },
  ghost: { label: 'GHOST (256)', size: 256, template: 'arcface_112_v1', mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], emb: 'convraw:crossface_ghost', denorm: true },
  uniface: { label: 'UniFace (256)', size: 256, template: 'ffhq_512', mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], emb: 'img:ffhq_512:256', denorm: true },
  blendswap: { label: 'BlendSwap (256)', size: 256, template: 'ffhq_512', mean: [0, 0, 0], std: [1, 1, 1], emb: 'img:arcface_112_v2:112' },
  simswap_arcface: { label: 'SimSwap/HyperSwap-like 256 (ArcFace chuẩn hoá)', size: 256, template: 'arcface_112_v1', mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], emb: 'norm' },
};
export const RESTORE_PRESETS = {
  gfpgan: { label: 'GFPGAN / GPEN / RestoreFormer (512)', size: 512, template: 'ffhq_512' },
  codeformer: { label: 'CodeFormer (512, có weight)', size: 512, template: 'ffhq_512', weight: 0.7 },
};
// đổi model.json của người dùng → hồ sơ
export function profileFromSidecar(j) {
  if (!j) return null; const t = (j.type || '').toLowerCase();
  if (['gfpgan', 'gpen', 'restoreformer', 'codeformer', 'restore'].some(k => t.includes(k))) return { kind: 'restore', ...RESTORE_PRESETS[t.includes('codeformer') ? 'codeformer' : 'gfpgan'], ...(j.input_size ? { size: j.input_size } : {}) };
  const base = SWAP_PRESETS[t] || Object.entries(SWAP_PRESETS).find(([k]) => t.startsWith(k.split('_')[0]))?.[1] || SWAP_PRESETS.simswap_arcface;
  const p = { kind: 'swap', ...base };
  if (j.input_size) p.size = +j.input_size;
  if (j.mean) p.mean = j.mean; if (j.std) p.std = j.std;
  if (j.template) p.template = j.template;
  if (j.embedding === 'arcface_emap') p.emb = 'emap'; else if (j.embedding === 'arcface') p.emb = 'norm'; else if (j.embedding) p.emb = j.embedding;
  if (j.denorm != null) p.denorm = !!j.denorm;
  if (j.emap_url) p.emap_url = j.emap_url;
  return p;
}
const dimsOf = (meta) => (meta?.shape || meta?.dims || []).map(d => typeof d === 'number' ? d : -1);
/** Đoán loại model từ tên/kích thước đầu vào–ra. Trả {kind, preset, profile} hoặc null. */
export function detectProfile(sess, hasEmap) {
  const ins = sess.inputNames.map((n, i) => ({ n, d: dimsOf(sess.inputMetadata?.[i]), t: sess.inputMetadata?.[i]?.type }));
  const nOut = sess.outputNames.length;
  const img4 = ins.filter(x => x.d.length === 4 && x.d[1] === 3);
  const vec = ins.filter(x => x.d.length === 2 && x.d[x.d.length - 1] === 512);
  const weight = ins.find(x => /weight|fidelity|^w$/i.test(x.n));
  if (img4.length === 1 && !vec.length && ins.length <= 2) {
    const s = img4[0].d[2] > 0 ? img4[0].d[2] : 512; return { kind: 'restore', preset: weight ? 'codeformer' : 'gfpgan', profile: { kind: 'restore', ...RESTORE_PRESETS[weight ? 'codeformer' : 'gfpgan'], size: s } };
  }
  const tgt = img4.find(x => /target/i.test(x.n)) || img4[0];
  const s = tgt?.d[2];
  if (tgt && vec.length) {
    let preset = s === 128 ? 'inswapper' : s === 512 ? 'simswap_512' : nOut === 2 ? 'hyperswap' : nOut >= 9 ? 'ghost' : 'simswap_256';
    const p = { kind: 'swap', ...SWAP_PRESETS[preset] };
    if (preset === 'inswapper' && !hasEmap) p.emb = 'norm';
    return { kind: 'swap', preset, profile: p };
  }
  if (img4.length === 2) {
    const src = img4.find(x => x !== tgt); const ss = src.d[2];
    if (ss === 112) return { kind: 'swap', preset: 'blendswap', profile: { kind: 'swap', ...SWAP_PRESETS.blendswap } };
    if (ss === 256) return { kind: 'swap', preset: 'uniface', profile: { kind: 'swap', ...SWAP_PRESETS.uniface } };
  }
  return null;
}
export function describeIO(sess) {
  const f = (names, meta) => names.map((n, i) => `${n} ${meta?.[i]?.type || ''} [${dimsOf(meta?.[i]).map(d => d < 0 ? '?' : d).join(',')}]`).join('; ');
  return { inputs: f(sess.inputNames, sess.inputMetadata), outputs: f(sess.outputNames, sess.outputMetadata) };
}

// ref = {src:'reg', id} | {src:'custom', id}
async function refSession(group, ref, onP) { return ref.src === 'custom' ? S.customSession(ref.id) : S.session(group, ref.id, onP); }
async function refProfile(group, ref) {
  if (ref.src === 'custom') { const m = S.customList().find(x => x.id === ref.id); if (!m?.profile) throw new Error('Model tự tải chưa có cấu hình — hãy chọn kiểu model.'); return m.profile; }
  return (await S.modelInfo(group, ref.id)).profile;
}
async function getEmap(ref) {
  const k = ref.src + '/' + ref.id; if (EMAPS.has(k)) return EMAPS.get(k);
  let b;
  if (ref.src === 'custom') { b = await S.customBytes(ref.id, '__emap.bin'); if (!b) throw new Error('Model inswapper tự tải không có emap.'); }
  else b = await S.extra('swap', ref.id, 'emap.bin');
  const E = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); EMAPS.set(k, E); return E;
}
function feedsFor(sess, ort, tin, size, srcData, srcDims) {
  const ins = sess.inputNames.map((n, i) => ({ n, d: dimsOf(sess.inputMetadata?.[i]) }));
  let tgt = ins.find(x => /target/i.test(x.n)), src = ins.find(x => /source/i.test(x.n));
  if (!tgt || !src) { // tên lạ: đoán theo hình dạng
    const four = ins.filter(x => x.d.length === 4);
    tgt = four.find(x => x.d[2] === size) || four[0]; src = ins.find(x => x !== tgt);
  }
  return { [tgt.n]: new ort.Tensor('float32', tin, [1, 3, size, size]), [src.n]: new ort.Tensor('float32', srcData, srcDims) };
}
function pickOut(sess, out, size) {
  for (const n of sess.outputNames) { const t = out[n]; if (t.dims.length === 4 && t.dims[1] === 3 && t.dims[2] === size) return t; }
  return out[sess.outputNames[0]];
}
async function sourceInput(P, srcImg, srcFace, emb, ref) {
  const e = P.emb || 'norm';
  if (e === 'emap') return [latent(emb, await getEmap(ref)), [1, 512]];
  if (e === 'norm') return [emb, [1, 512]];
  if (e.startsWith('conv')) {
    const id = e.split(':')[1]; const ort = await S.getOrt(); const s = await S.session('conv', id);
    const o = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', emb.raw, [1, 512]) });
    const v = Float32Array.from(o[s.outputNames[0]].data); if (S.lowMem) S.release('conv', id);
    return [e.startsWith('convraw') ? v : norm(v), [1, 512]];
  }
  if (e.startsWith('img')) {
    const [, t, sz] = e.split(':'); const z = +sz; const c = warp(srcImg, similarity(srcFace.kps, tpl(t, z)), z, z);
    return [toTensor(c, [0, 0, 0], [255, 255, 255]), [1, 3, z, z]];
  }
  throw new Error('Kiểu embedding lạ: ' + e);
}
async function restoreFace(ref, fc, onP) {
  const ort = await S.getOrt(); const P = await refProfile('restore', ref); const s = await refSession('restore', ref, onP);
  const f = {};
  for (let i = 0; i < s.inputNames.length; i++) {
    const n = s.inputNames[i], meta = s.inputMetadata?.[i];
    if (dimsOf(meta).length === 4 || i === 0 && !/weight/i.test(n)) f[n] = new ort.Tensor('float32', toTensor(fc, [127.5, 127.5, 127.5], [127.5, 127.5, 127.5]), [1, 3, fc.width, fc.height]);
    else { const w = P.weight ?? 0.7; f[n] = /double|float64/.test(meta?.type || 'float64') ? new ort.Tensor('float64', Float64Array.from([w]), []) : new ort.Tensor('float32', Float32Array.from([w]), []); }
  }
  const out = await s.run(f); const t = pickOut(s, out, P.size); const d = Float32Array.from(t.data);
  if (S.lowMem && ref.src !== 'custom') S.release('restore', ref.id);
  return d;
}

// ---------- ghép ----------
function colorMatch(out, ref, size, strength) { // khớp màu trung bình/độ lệch trong elip trung tâm
  const n = size * size, k_ = size / 128; const sel = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const dx = (x - 64 * k_) / (40 * k_), dy = (y - 72 * k_) / (48 * k_); if (dx * dx + dy * dy < 1) sel.push(y * size + x); }
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
 * opts: {swapper:{src:'reg'|'custom',id}, restorer:null|{src,id}, restoreAmt:0.8, colorMatch:true, lock:true, keepMouth:false, onStep}
 * Trả về job (giữ ảnh trung gian để vẽ lại mặt nạ không cần chạy lại model).
 */
export async function swap(srcImg, srcFace, dstImg, dstFace, opts = {}) {
  const o = { swapper: { src: 'reg', id: 'inswapper_128' }, restorer: S.lowMem ? null : { src: 'reg', id: 'gfpgan_1.4' }, restoreAmt: 0.8, colorMatch: true, lock: true, keepMouth: false, ...opts };
  if (o.restore === false) o.restorer = null;
  const step = (m, p) => o.onStep?.(m, p); const T0 = performance.now(); const times = {};
  const t = async (name, f) => { const a = performance.now(); const r = await f(); times[name] = Math.round(performance.now() - a); await tick(); return r; };
  const P = await refProfile('swap', o.swapper); const size = P.size;
  const keyOf = (g, r) => r ? (r.src === 'custom' ? 'custom/' + r.id : g + '/' + r.id) : '';
  await S.releaseExcept(['swap', 'restore', 'custom', 'conv'], [keyOf('swap', o.swapper), keyOf('restore', o.restorer), ...(P.emb || '').split(':').slice(1, 2).map(id => 'conv/' + id)]);
  const tplS = tpl(P.template || 'arcface_128', size);
  step('Đọc nhận dạng mặt nguồn…', 0.1);
  const emb = await t('arcface', () => embed(srcImg, srcFace));
  const [sd, sdims] = await t('source', () => sourceInput(P, srcImg, srcFace, emb, o.swapper));
  // vùng làm việc (region) quanh mặt đích
  const Mfull = similarity(dstFace.kps, tplS);
  const inv = invert(Mfull);
  const cs = [[0, 0], [size, 0], [0, size], [size, size]].map(([x, y]) => apply(inv, x, y));
  const Mf0 = invert(similarity(dstFace.kps, FFHQ)); [[0, 0], [512, 0], [0, 512], [512, 512]].forEach(([x, y]) => cs.push(apply(Mf0, x, y)));
  let rx0 = Math.min(...cs.map(p => p[0])), ry0 = Math.min(...cs.map(p => p[1])), rx1 = Math.max(...cs.map(p => p[0])), ry1 = Math.max(...cs.map(p => p[1]));
  const pad = (rx1 - rx0) * 0.03; rx0 = Math.max(0, Math.floor(rx0 - pad)); ry0 = Math.max(0, Math.floor(ry0 - pad)); rx1 = Math.min(dstImg.width, Math.ceil(rx1 + pad)); ry1 = Math.min(dstImg.height, Math.ceil(ry1 + pad));
  const rw = rx1 - rx0, rh = ry1 - ry0;
  const region = { x: rx0, y: ry0, w: rw, h: rh };
  const orig = canvas(rw, rh); ctx2d(orig).drawImage(dstImg, rx0, ry0, rw, rh, 0, 0, rw, rh);
  const kps = dstFace.kps.map(([x, y]) => [x - rx0, y - ry0]);
  step(`Ghép mặt (${P.label || o.swapper.id})…`, 0.3);
  const M = similarity(kps, tplS);
  const crop = warp(orig, M, size, size);
  const tin = toTensor(crop, P.mean.map(v => v * 255), P.std.map(v => v * 255));
  const ort = await S.getOrt(); const sess = await t('load', () => refSession('swap', o.swapper, o.onProgress));
  const so = await t('swap', async () => pickOut(sess, await sess.run(feedsFor(sess, ort, tin, size, sd, sdims)), size));
  if (S.lowMem && o.swapper.src !== 'custom') S.release('swap', o.swapper.id);
  const sw = Float32Array.from(so.data); const n = size * size;
  for (let k = 0; k < 3; k++) for (let i = 0; i < n; i++) { let v = sw[k * n + i]; if (P.denorm) v = v * P.std[k] + P.mean[k]; sw[k * n + i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  if (o.colorMatch && (P.cm ?? 0.35) > 0) colorMatch(sw, toTensor(crop, [0, 0, 0], [255, 255, 255]), size, P.cm ?? 0.35);
  const am = rectMask(size, 0.06, 0.06);
  const swc = tensorToCanvas(sw, size, v => clamp255(v * 255), am);
  const swapped = canvas(rw, rh); const g = ctx2d(swapped); g.drawImage(orig, 0, 0);
  const IM = invert(M); g.imageSmoothingQuality = 'high'; g.setTransform(IM[0], IM[3], IM[1], IM[4], IM[2], IM[5]); g.drawImage(swc, 0, 0); g.setTransform(1, 0, 0, 1, 0, 0);
  const Mf = similarity(kps, FFHQ); const IMf = invert(Mf);
  if (o.restorer) {
    step('Làm nét mặt…', 0.55);
    const RP = await refProfile('restore', o.restorer); const rs = RP.size || 512;
    const Mr = similarity(kps, tpl(RP.template || 'ffhq_512', rs)); const IMr = invert(Mr);
    const fc = warp(swapped, Mr, rs, rs);
    const ro = await t('restore', () => restoreFace(o.restorer, fc));
    const rm = rectMask(rs, 0.04, 0.05); for (let i = 0; i < rm.length; i++) rm[i] *= o.restoreAmt;
    const rc = tensorToCanvas(ro, rs, v => clamp255((v + 1) * 127.5), rm);
    g.setTransform(IMr[0], IMr[3], IMr[1], IMr[4], IMr[2], IMr[5]); g.drawImage(rc, 0, 0); g.setTransform(1, 0, 0, 1, 0, 0);
  }
  // mặt nạ phân vùng (BiSeNet) trên ảnh đích GỐC → loại tóc, tai, cổ, kính, vật che
  step('Khóa vùng mặt (BiSeNet)…', 0.8);
  const fo = warp(orig, Mf, 512, 512);
  const [po] = await t('bisenet', () => run('bisenet', [[toTensor(fo, [0.485 * 255, 0.456 * 255, 0.406 * 255], [0.229 * 255, 0.224 * 255, 0.225 * 255]), [1, 3, 512, 512]]]));
  const lg = po.data, N = 512 * 512; const cls = new Uint8Array(N);
  for (let i = 0; i < N; i++) { let b = 0, bv = -1e9; for (let k = 0; k < 19; k++) { const v = lg[k * N + i]; if (v > bv) { bv = v; b = k; } } cls[i] = b; }
  // ô vuông của model ghép (vùng có dữ liệu ghép) trong toạ độ region
  const sq = canvas(rw, rh); { const q = ctx2d(sq); q.setTransform(IM[0], IM[3], IM[1], IM[4], IM[2], IM[5]); q.fillStyle = '#fff'; q.fillRect(size * 0.1, size * 0.1, size * 0.8, size * 0.8); }
  const sqA = ctx2d(sq).getImageData(0, 0, rw, rh).data;
  const job = { dstImg, region, orig, swapped, cls, IMf, sqA, opts: o, edits: null, times, srcFace, dstFace, profile: P };
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
