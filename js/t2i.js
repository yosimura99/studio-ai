// Tạo ảnh từ chữ / từ ảnh. Nhanh = SDXS-512 (1 bước, chạy cả WASM). Chất lượng cao = SD-Turbo (WebGPU, nhiều bước + img2img).
import * as S from './store.js';
import { loadTok, encode } from './clip_tok.js';
import { canvas, ctx2d } from './img.js';

export const TIERS = {
  fast: { label: 'Nhanh (SDXS-512)', group: 't2i', ids: ['text_encoder', 'unet', 'vae_decoder', 'vae_encoder'], license: 'openrail++ (IDKiro/sdxs-512-dreamshaper)' },
  hq: { label: 'Chất lượng cao (SD-Turbo)', group: 'hq', ids: ['hq_text_encoder', 'hq_unet', 'hq_vae_decoder', 'hq_vae_encoder'], license: 'Stability AI Community License (stabilityai/sd-turbo)' },
};
const ACP = (() => { const a = new Float64Array(1000); let c = 1; for (let i = 0; i < 1000; i++) { const b = (Math.sqrt(0.00085) + (Math.sqrt(0.012) - Math.sqrt(0.00085)) * i / 999) ** 2; c *= 1 - b; a[i] = c; } return a; })();
function rng(seed) { let s = seed >>> 0; const u = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return () => { let a = u(); while (a <= 1e-12) a = u(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u()); }; }
function f32to16(v) { const f = new Float32Array(1), i = new Uint32Array(f.buffer); const o = new Uint16Array(v.length);
  for (let k = 0; k < v.length; k++) { f[0] = v[k]; const x = i[0]; const s = (x >>> 16) & 0x8000; let e = ((x >>> 23) & 0xff) - 112; let m = x & 0x7fffff;
    if (e <= 0) { o[k] = s; continue; } if (e >= 31) { o[k] = s | 0x7c00; continue; } o[k] = s | (e << 10) | ((m + 0x1000) >> 13); } return o; }
function f16to32(u) { const o = new Float32Array(u.length); for (let k = 0; k < u.length; k++) { const h = u[k], s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023; o[k] = e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15); } return o; }
const tick = () => new Promise(r => setTimeout(r, 0));

export async function tierReady(tier) { const T = TIERS[tier]; return S.isCached(T.group, T.ids); }
export async function tierBytes(tier) { const T = TIERS[tier]; return S.totalBytes(T.group, T.ids); }
export function tierSupported(tier) {
  if (tier === 'fast') return { ok: true };
  if (!navigator.gpu) return { ok: false, why: 'Thiết bị/trình duyệt này không có WebGPU. Dùng chế độ "Nhanh", hoặc mở bằng Chrome/Edge trên máy tính.' };
  if (S.lowMem) return { ok: true, warn: 'iPhone/iPad: model Chất lượng cao ~2,6 GB, rất dễ bị Safari đóng tab do thiếu RAM. Khuyên dùng máy tính.' };
  return { ok: true };
}

/** opts: {tier, prompt, negative, seed, steps, size, init (canvas), strength, onStep} → canvas */
export async function generate(o) {
  const tier = o.tier || 'fast'; const T = TIERS[tier]; const step = (m, p) => o.onStep?.(m, p);
  const chk = () => { if (o.signal?.aborted) throw new DOMException('Đã huỷ', 'AbortError'); };
  // RAM: chỉ 1 model sống tại một thời điểm → giải phóng mọi phiên khác (ghép mặt, dịch…) trước khi vẽ
  await S.releaseAll(); if (!S.isolate() || tier === 'hq') await S.getOrt();
  if (tier === 'hq' && S.backend !== 'webgpu') throw new Error('Chất lượng cao cần WebGPU. Hãy chọn "Nhanh".');
  const size = Math.max(256, Math.min(768, Math.round((o.size || 512) / 64) * 64)); const L = size / 8;
  const seed = o.seed ?? Math.floor(Math.random() * 2 ** 31); const randn = rng(seed);
  const noise = () => { const n = new Float32Array(4 * L * L); for (let i = 0; i < n.length; i++) n[i] = randn(); return n; };
  const iso = tier === 'fast'; // HQ (WebGPU, nhiều bước) giữ phiên; Nhanh: mỗi model chạy 1 lần rồi giải phóng (iPhone: trong worker riêng)
  const run1 = async (id, inputs, label, p, keep = false) => { chk(); if (label) step(label, p);
    const r = await S.runOnce(T.group, id, inputs, { onProgress: o.onProgress, signal: o.signal, noIso: !iso, keep: S.lowMem ? (!iso && keep) : true }); chk(); await tick(); return r; };
  const times = {}; const t0 = performance.now(); const tm = (k, a) => times[k] = Math.round(performance.now() - a);
  // 1) mã hoá chữ
  const tok = await loadTok(S.APP_BASE + 'models/tok/');
  const ids = encode(tok, o.prompt || '', tier === 'hq' ? 0 : 49407);
  let a = performance.now();
  const teIn = tier === 'hq' ? { type: 'int32', data: Int32Array.from(ids), dims: [1, 77] } : { type: 'int64', data: BigInt64Array.from(ids.map(BigInt)), dims: [1, 77] };
  const h = await run1(T.ids[0], [teIn], 'Nạp model 1/3…', 0.05); const hidden = { type: h.type, data: h.data, dims: h.dims }; tm('text', a);
  // 2) latent khởi đầu
  let x0 = null, ts;
  const steps = tier === 'hq' ? Math.max(1, Math.min(8, o.steps || 2)) : 1;
  if (o.init) {
    const c = canvas(size, size); const g = ctx2d(c); g.imageSmoothingQuality = 'high';
    const s = Math.min(o.init.width, o.init.height); g.drawImage(o.init, (o.init.width - s) / 2, (o.init.height - s) / 2, s, s, 0, 0, size, size);
    const d = g.getImageData(0, 0, size, size).data; const n = size * size; const im = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) im[k * n + i] = d[i * 4 + k] / 127.5 - 1;
    a = performance.now();
    if (tier === 'hq') { const lt = await run1(T.ids[3], [{ type: 'float16', data: f32to16(im), dims: [1, 3, size, size] }], 'Mã hoá ảnh gốc…', 0.25); x0 = (lt.data instanceof Uint16Array ? f16to32(lt.data) : Float32Array.from(lt.data)).map(v => v * 0.18215); }
    else { const lt = await run1(T.ids[3], [{ type: 'float32', data: im, dims: [1, 3, size, size] }], 'Mã hoá ảnh gốc…', 0.25); x0 = Float32Array.from(lt.data); }
    tm('encode', a);
  }
  const strength = Math.max(0.1, Math.min(1, o.strength ?? 0.55));
  const runUnet = async (xt, t, label, p, keep) => Float32Array.from((await run1(T.ids[1], [{ type: 'float32', data: xt, dims: [1, 4, L, L] }, { type: 'int64', data: BigInt64Array.from([BigInt(t)]), dims: [1] }, hidden], label, p, keep)).data);
  a = performance.now();
  if (tier === 'fast') {
    // SDXS: một bước ở t=999.
    const nz = noise(); let xt;
    // img2img: nhiễu hoá ảnh gốc đến bước t = strength·999 rồi khử nhiễu 1 bước tại t đó.
    const t1 = x0 ? Math.min(999, Math.round(450 + strength * 549)) : 999; const aa = ACP[t1]; // SDXS chỉ được chưng cất ở t cao: t thấp cho ảnh mờ
    if (x0) { const x = x0; xt = nz.map((q, i) => Math.sqrt(aa) * x[i] + Math.sqrt(1 - aa) * q); }
    else { const k = Math.sqrt(1 - aa); xt = nz.map(q => q * k); }
    const eps = await runUnet(xt, t1, 'Nạp model 2/3 · đang vẽ (1 bước)…', 0.4); ts = [t1];
    x0 = xt.map((q, i) => (q - Math.sqrt(1 - aa) * eps[i]) / Math.sqrt(aa));
  } else {
    const tStart = x0 ? Math.round(strength * 1000) - 1 : 999;
    ts = Array.from({ length: steps }, (_, k) => Math.round(tStart - k * tStart / steps));
    for (let k = 0; k < ts.length; k++) {
      const t = ts[k], aa = ACP[t]; const nz = noise();
      const xt = x0 ? x0.map((q, i) => Math.sqrt(aa) * q + Math.sqrt(1 - aa) * nz[i]) : nz;
      const eps = await runUnet(xt, t, `Đang vẽ bước ${k + 1}/${ts.length}…`, 0.3 + 0.5 * k / ts.length, k < ts.length - 1); x0 = xt.map((q, i) => (q - Math.sqrt(1 - aa) * eps[i]) / Math.sqrt(aa));
    }
  }
  tm('unet', a);
  // 3) giải mã
  a = performance.now();
  const lat = tier === 'hq' ? x0.map(v => v / 0.18215) : x0;
  const out = await run1(T.ids[2], [{ type: 'float32', data: lat, dims: [1, 4, L, L] }], 'Nạp model 3/3 · giải mã ảnh…', 0.85); const y = out.data; tm('decode', a);
  const W = out.dims[3], H = out.dims[2];
  const c = canvas(W, H); const g = ctx2d(c); const im = g.createImageData(W, H); const n = W * H;
  for (let i = 0; i < n; i++) { for (let k = 0; k < 3; k++) im.data[i * 4 + k] = Math.max(0, Math.min(255, Math.round((y[k * n + i] + 1) * 127.5))); im.data[i * 4 + 3] = 255; }
  g.putImageData(im, 0, 0); times.total = Math.round(performance.now() - t0);
  c.meta = { seed, steps: tier === 'hq' ? steps : 1, size, tier, times, timesteps: ts };
  step('Xong', 1); return c;
}
