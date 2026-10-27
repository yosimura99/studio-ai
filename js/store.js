// Tải model theo từng mảnh (<100 MB, nằm trên GitHub Pages), lưu Cache Storage, ghép lại, tạo phiên ONNX.
const CACHE = 'studio-ai-models-v1';
const APP_BASE = new URL('../', import.meta.url).href;            // https://yosimura99.github.io/studio-ai/
export const ROOT = new URL('../', APP_BASE).href;                // https://yosimura99.github.io/ (các repo model cùng origin)
export const T2I_BASE = ROOT + 'studio-ai-t2i/';
export { APP_BASE };
let REG = null;
export async function registry() {
  if (!REG) REG = await (await fetch(APP_BASE + 'models/models.json')).json();
  return REG;
}
const baseOf = (group) => group === 't2i' ? T2I_BASE : APP_BASE;
const isRaw = (m) => m.type === 'raw';
export async function modelInfo(group, id) { return (await registry())[group][id]; }

// ---------- runtime (WebGPU → WASM) ----------
let ortP = null; export let backend = null; let hasF16 = false;
export async function getOrt(pref) {
  if (ortP) return ortP;
  ortP = (async () => {
    let gpu = false;
    if (pref !== 'wasm' && navigator.gpu) {
      try { const a = await navigator.gpu.requestAdapter(); if (a) { gpu = true; hasF16 = a.features.has('shader-f16'); } } catch {}
    }
    const ort = await import(gpu ? '../vendor/ort/ort.webgpu.min.mjs' : '../vendor/ort/ort.wasm.min.mjs');
    ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1;
    ort.env.logLevel = 'error';
    backend = gpu ? 'webgpu' : 'wasm';
    return ort;
  })();
  return ortP;
}
export function backendLabel() {
  if (!backend) return '—';
  return backend === 'webgpu' ? `WebGPU${hasF16 ? ' (fp16)' : ''}` : `WASM CPU · ${self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1} luồng`;
}

// ---------- cache ----------
export async function persist() { try { return await navigator.storage?.persist?.(); } catch { return false; } }
async function cachedBytes(url) { const c = await caches.open(CACHE); const r = await c.match(url); return r ? new Uint8Array(await r.arrayBuffer()) : null; }
async function fetchWithProgress(url, onBytes) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  const len = +r.headers.get('content-length') || 0; const rd = r.body.getReader(); const parts = []; let got = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; onBytes(value.length); }
  const out = new Uint8Array(got); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  if (len && got !== len && !r.headers.get('content-encoding')) throw new Error('Tải thiếu dữ liệu: ' + url);
  return out;
}
function urls(group, m) {
  if (isRaw(m)) { const parts = m.parts.map(p => ROOT + p); return { chunks: parts, wchunks: parts, all: parts }; }
  const b = (m.root ? ROOT : baseOf(group)) + m.path; return { chunks: [...m.chunks, ...(m.extra || [])].map(c => b + c), g16: m.no16 ? null : b + 'g16.onnx', g32: b + 'g32.onnx', segs: b + 'segs.json', wchunks: m.chunks.map(c => b + c), all: null }; }
const allUrls = (u) => u.all || [...u.chunks, u.g16, u.g32, u.segs].filter(Boolean);
export async function extra(group, id, name) { const reg = await registry(); const m = reg[group][id]; const b = (m.root ? ROOT : baseOf(group)) + m.path + name; let x = await cachedBytes(b); if (!x) { await download(group, [id]); x = await cachedBytes(b); } return x; }
export async function isCached(group, ids) {
  const reg = await registry(); const c = await caches.open(CACHE);
  for (const id of ids) { const u = urls(group, reg[group][id]); for (const x of allUrls(u)) if (!(await c.match(x))) return false; }
  return true;
}
export async function totalBytes(group, ids) { const reg = await registry(); return ids.reduce((s, id) => s + reg[group][id].bytes, 0); }
// download (or verify) every file of the listed models; onProgress(done,total)
export async function download(group, ids, onProgress) {
  await persist();
  const reg = await registry(); const c = await caches.open(CACHE);
  const total = await totalBytes(group, ids); let done = 0;
  for (const id of ids) {
    const m = reg[group][id]; const u = urls(group, m);
    const list = u.all || [u.segs, u.g32, u.g16, ...u.chunks].filter(Boolean);
    for (const url of list) {
      const hit = await c.match(url);
      if (hit) { if (url !== u.g16) done += +(hit.headers.get('x-len') || 0); onProgress?.(done, total); continue; }
      let b = null, err;
      for (let k = 0; k < 3 && !b; k++) { let got = 0; try { b = await fetchWithProgress(url, (n) => { if (url !== u.g16) { got += n; done += n; onProgress?.(done, total); } }); } catch (e) { err = e; done -= got; } }
      if (!b) throw err;
      await c.put(url, new Response(b, { headers: { 'content-type': 'application/octet-stream', 'x-len': String(b.length) } }));
    }
  }
  onProgress?.(total, total);
}
export async function remove(group, ids) {
  const reg = await registry(); const c = await caches.open(CACHE);
  for (const id of ids) { const u = urls(group, reg[group][id]); for (const x of allUrls(u)) await c.delete(x); }
  for (const k of [...sessions.keys()]) if (k.startsWith(group + '/') && ids.includes(k.split('/')[1])) release(group, k.split('/')[1]);
}
export async function usage() { try { return await navigator.storage.estimate(); } catch { return null; } }

// ---------- fp16 store → fp32 weights ----------
let F16 = null;
function f16table() {
  if (F16) return F16; F16 = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
    F16[h] = e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15);
  }
  return F16;
}
function expand(w16, segs) {
  const T = f16table(); const out = new Uint8Array(segs.size32);
  for (const [a, n, b, is16] of segs.segs) {
    if (is16) { const src = new Uint16Array(w16.buffer, w16.byteOffset + a, n / 2); const dst = new Float32Array(out.buffer, b, n / 2); for (let i = 0; i < src.length; i++) dst[i] = T[src[i]]; }
    else out.set(w16.subarray(a, a + n), b);
  }
  return out;
}
const sessions = new Map();
export async function session(group, id, onProgress) {
  const key = group + '/' + id; if (sessions.has(key)) return sessions.get(key);
  const p = (async () => {
    const ort = await getOrt(); const reg = await registry(); const m = reg[group][id]; const u = urls(group, m);
    if (!(await isCached(group, [id]))) await download(group, [id], onProgress);
    if (isRaw(m)) {
      if (m.gpu && backend !== 'webgpu') throw new Error('Model Chất lượng cao cần WebGPU (Chrome/Edge máy tính hoặc Safari iOS 26+).');
      const buf = new Uint8Array(m.bytes); let o = 0;
      for (const cu of u.wchunks) { const b = await cachedBytes(cu); buf.set(b, o); o += b.length; }
      return await ort.InferenceSession.create(buf, { logSeverityLevel: 3, executionProviders: [m.gpu ? 'webgpu' : 'wasm'], graphOptimizationLevel: 'all' });
    }
    const w = new Uint8Array(m.size16); let o = 0;
    for (const cu of u.wchunks) { const b = await cachedBytes(cu); w.set(b, o); o += b.length; }
    const use16 = backend === 'webgpu' && hasF16 && !m.no16;
    const graph = await cachedBytes(use16 ? u.g16 : u.g32);
    const ext = use16 ? [{ path: 'w.bin', data: w }] : [{ path: 'w32.bin', data: expand(w, JSON.parse(new TextDecoder().decode(await cachedBytes(u.segs)))) }];
    const opts = { logSeverityLevel: 3, executionProviders: [backend === 'webgpu' ? 'webgpu' : 'wasm'], externalData: ext, graphOptimizationLevel: 'all' };
    try { return await ort.InferenceSession.create(graph, opts); }
    catch (e) {
      if (backend !== 'webgpu') throw e;
      console.warn('WebGPU lỗi, chuyển sang WASM', e);
      const g32 = await cachedBytes(u.g32); const segs = JSON.parse(new TextDecoder().decode(await cachedBytes(u.segs)));
      return await ort.InferenceSession.create(g32, { logSeverityLevel: 3, executionProviders: ['wasm'], externalData: [{ path: 'w32.bin', data: expand(w, segs) }] });
    }
  })();
  sessions.set(key, p);
  try { return await p; } catch (e) { sessions.delete(key); throw e; }
}
export const hasShaderF16 = () => hasF16;
export async function release(group, id) {
  const key = group + '/' + id; const p = sessions.get(key); if (!p) return; sessions.delete(key);
  try { (await p).release?.(); } catch {}
}
/** Giải phóng các session ghép/làm nét không dùng nữa (WASM chỉ có ~4 GB bộ nhớ). keep = ['swap/id','custom/id',…] */
export async function releaseExcept(groups, keep) {
  for (const k of [...sessions.keys()]) if (groups.includes(k.split('/')[0]) && !keep.includes(k)) await release(k.split('/')[0], k.slice(k.indexOf('/') + 1));
}
export const lowMem = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.deviceMemory && navigator.deviceMemory <= 4);

// ---------- model tự tải (người dùng) ----------
const UCACHE = 'studio-ai-custom-v1'; const UKEY = 'studioai.custom.v1';
export function customList() { try { return JSON.parse(localStorage.getItem(UKEY) || '[]'); } catch { return []; } }
function saveList(l) { localStorage.setItem(UKEY, JSON.stringify(l)); }
const ukey = (id, name) => APP_BASE + '__custom/' + id + '/' + encodeURIComponent(name);
/** files: [{name, data:Uint8Array}] (file .onnx đầu tiên là model, còn lại là dữ liệu ngoài .data) */
export async function customAdd(meta, files) {
  const id = meta.id || ('m' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  const c = await caches.open(UCACHE); await persist();
  for (const f of files) await c.put(ukey(id, f.name), new Response(f.data, { headers: { 'content-type': 'application/octet-stream' } }));
  const l = customList().filter(x => x.id !== id);
  l.push({ ...meta, id, files: files.map(f => ({ name: f.name, size: f.data.length })), size: files.reduce((s, f) => s + f.data.length, 0), added: Date.now() });
  saveList(l); return id;
}
export function customUpdate(id, patch) { const l = customList(); const m = l.find(x => x.id === id); if (m) Object.assign(m, patch); saveList(l); }
export async function customRemove(id) {
  const m = customList().find(x => x.id === id); const c = await caches.open(UCACHE);
  if (m) for (const f of m.files) await c.delete(ukey(id, f.name));
  saveList(customList().filter(x => x.id !== id)); const k = 'custom/' + id; if (sessions.has(k)) release('custom', id);
}
export async function customBytes(id, name) { const c = await caches.open(UCACHE); const r = await c.match(ukey(id, name)); return r ? new Uint8Array(await r.arrayBuffer()) : null; }
export async function customSession(id, data) {
  const key = 'custom/' + id; if (sessions.has(key)) return sessions.get(key);
  const p = (async () => {
    const ort = await getOrt(); const m = customList().find(x => x.id === id);
    let model = data, ext = [];
    if (!model) {
      if (!m) throw new Error('Không thấy model tự tải');
      const [g, ...rest] = m.files.filter(f => !f.name.startsWith('__')); model = await customBytes(id, g.name);
      for (const f of rest) ext.push({ path: f.name, data: await customBytes(id, f.name) });
    }
    const opts = { logSeverityLevel: 3, executionProviders: [backend === 'webgpu' ? 'webgpu' : 'wasm'], graphOptimizationLevel: 'all' }; if (ext.length) opts.externalData = ext;
    try { return await ort.InferenceSession.create(model, opts); }
    catch (e) { if (backend !== 'webgpu') throw e; return await ort.InferenceSession.create(model, { ...opts, executionProviders: ['wasm'] }); }
  })();
  sessions.set(key, p);
  try { return await p; } catch (e) { sessions.delete(key); throw e; }
}
export async function fetchBytes(url, onBytes) { return fetchWithProgress(url, onBytes || (() => {})); }
