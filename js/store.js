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
    if (pref !== 'wasm' && navigator.gpu && !(lowMem && !gpuOptIn())) {
      try { const a = await navigator.gpu.requestAdapter(); if (a) { gpu = true; hasF16 = a.features.has('shader-f16'); } } catch {}
    }
    const ort = await import(gpu ? '../vendor/ort/ort.webgpu.min.mjs' : '../vendor/ort/ort.wasm.min.mjs');
    ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
    ort.env.wasm.numThreads = threads();
    ort.env.logLevel = 'error';
    backend = gpu ? 'webgpu' : 'wasm';
    return ort;
  })();
  return ortP;
}
export function backendLabel() {
  if (!backend) return '—';
  return backend === 'webgpu' ? `WebGPU${hasF16 ? ' (fp16)' : ''}` : `WASM CPU · ${threads()} luồng`;
}
// iPhone/máy ít RAM: 1 luồng (mỗi luồng WASM thêm stack + bộ nhớ chia sẻ lớn hơn), không dò WebGPU khi mở trang.
const threads = () => (self.crossOriginIsolated && !lowMem) ? Math.min(4, navigator.hardwareConcurrency || 4) : 1;
/** Lỗi thiếu RAM/khởi tạo ONNX → câu tiếng Việt dễ hiểu */
export function friendlyError(e) {
  const m = String(e?.message || e || '');
  if (/abort|hủy|huỷ/i.test(e?.name || '') || /Đã huỷ/.test(m)) return 'Đã huỷ.';
  if (/memory|thiếu RAM|RangeError|Array buffer allocation|out of bounds|OOM|bad_alloc|std::|Aborted\(|WebAssembly/i.test(m) || e instanceof RangeError)
    return 'Máy không đủ bộ nhớ (RAM) để chạy model này. Hãy đóng bớt tab/app khác, tải lại trang rồi thử lại' + (lowMem ? ', hoặc dùng khổ ảnh nhỏ hơn.' : '.');
  if (/no available backend|wasm|onnx|ort/i.test(m)) return 'Không khởi động được bộ chạy AI (ONNX) trên trình duyệt này: ' + m.slice(0, 120);
  return m;
}

// ---------- cache ----------
export async function persist() { try { return await navigator.storage?.persist?.(); } catch { return false; } }
async function cachedBytes(url) { const c = await caches.open(CACHE); const r = await c.match(url); return r ? new Uint8Array(await r.arrayBuffer()) : null; }
async function fetchWithProgress(url, onBytes, signal) {
  const r = await fetch(url, { cache: 'no-cache', signal });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  const enc = r.headers.get('content-encoding'); const len = enc ? 0 : (+r.headers.get('content-length') || 0); const rd = r.body.getReader();
  // ghi thẳng vào 1 bộ đệm cấp sẵn (không giữ nhiều mảnh rồi ghép → không nhân đôi RAM)
  let out = new Uint8Array(len || 1 << 20), got = 0;
  for (;;) {
    if (signal?.aborted) { try { rd.cancel(); } catch {} throw new DOMException('Đã huỷ', 'AbortError'); }
    const { done, value } = await rd.read(); if (done) break;
    if (got + value.length > out.length) { const n = new Uint8Array(Math.max(out.length * 2, got + value.length)); n.set(out.subarray(0, got)); out = n; }
    out.set(value, got); got += value.length; onBytes(value.length);
  }
  if (len && got !== len) throw new Error('Tải thiếu dữ liệu: ' + url);
  return got === out.length ? out : out.slice(0, got);
}
function urls(group, m) {
  if (isRaw(m)) { const parts = m.parts.map(p => ROOT + p); return { chunks: parts, wchunks: parts, all: parts }; }
  const b = (m.root ? ROOT : baseOf(group)) + m.path; const qb = m.q && m.q.root ? ROOT + m.q.root : b; return { gq: m.q ? qb + 'gq.onnx' : null, qchunks: m.q ? m.q.chunks.map(c => qb + c) : [], chunks: [...m.chunks, ...(m.extra || [])].map(c => b + c), g16: m.no16 ? null : b + 'g16.onnx', g32: b + 'g32.onnx', gc: m.gc ? b + 'gc.onnx' : null, segs: b + 'segs.json', wchunks: m.chunks.map(c => b + c), all: null }; }
// gc.onnx = đồ thị fp32 nhưng trọng số giữ fp16 (+ Cast khi chạy): RAM bằng 1/2 so với g32. Dùng trên WASM khi máy ít RAM.
const useGc = (m) => !!m.gc && (lowMem || FORCE_GC);
// gq.onnx + q.NNN = trọng số int8 theo kênh (DequantizeLinear khi chạy): RAM bằng 1/4 fp32. Ưu tiên trên iPhone.
const useQ = (m) => !!m.q && (lowMem || FORCE_GC);
export const sizeOf = (m) => useQ(m) ? m.q.bytes : m.bytes;
const FORCE_GC = (() => { try { return !!self.__lite || /[?&]lite=1/.test(location.search) || localStorage.getItem('studioai.lite') === '1'; } catch { return !!self.__lite; } })();
const need = (u, m) => u.all || (useQ(m) ? [u.gq, ...u.qchunks] : [u.segs, ...(useGc(m) ? [u.gc] : [u.g32, u.g16]), ...u.chunks]).filter(Boolean);
const allUrls = (u) => u.all || [...u.chunks, ...u.qchunks, u.g16, u.g32, u.gc, u.gq, u.segs].filter(Boolean);
export async function extra(group, id, name) { const reg = await registry(); const m = reg[group][id]; const b = (m.root ? ROOT : baseOf(group)) + m.path + name; let x = await cachedBytes(b); if (!x) { await download(group, [id]); x = await cachedBytes(b); } return x; }
export async function isCached(group, ids) {
  const reg = await registry(); const c = await caches.open(CACHE);
  for (const id of ids) { const m = reg[group][id]; const u = urls(group, m); for (const x of need(u, m)) if (!(await c.match(x))) return false; }
  return true;
}
export async function totalBytes(group, ids) { const reg = await registry(); return ids.reduce((s, id) => s + sizeOf(reg[group][id]), 0); }
// download (or verify) every file of the listed models; onProgress(done,total)
export async function download(group, ids, onProgress, signal) {
  await persist();
  const reg = await registry(); const c = await caches.open(CACHE);
  const total = await totalBytes(group, ids); let done = 0;
  for (const id of ids) {
    const m = reg[group][id]; const u = urls(group, m);
    const list = need(u, m);
    for (const url of list) {
      const hit = await c.match(url);
      if (signal?.aborted) throw new DOMException('Đã huỷ', 'AbortError');
      if (hit) { if (url !== u.g16) done += +(hit.headers.get('x-len') || 0); onProgress?.(done, total); continue; }
      let b = null, err;
      for (let k = 0; k < 3 && !b; k++) { let got = 0; try { b = await fetchWithProgress(url, (n) => { if (url !== u.g16) { got += n; done += n; onProgress?.(done, total); } }, signal); } catch (e) { err = e; done -= got; if (e.name === 'AbortError') throw e; } }
      if (!b) throw err;
      await c.put(url, new Response(b, { headers: { 'content-type': 'application/octet-stream', 'x-len': String(b.length) } })); b = null;
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
// Tùy chọn tiết kiệm RAM khi tạo phiên trên WASM: tắt arena/mem-pattern (không giữ khối nhớ lớn cấp sẵn).
const lean = (o) => lowMem || FORCE_GC ? { ...o, enableCpuMemArena: false, enableMemPattern: false, executionMode: 'sequential' } : o;
async function readInto(list, size) { const buf = new Uint8Array(size); let o = 0; for (const cu of list) { let b = await cachedBytes(cu); buf.set(b, o); o += b.length; b = null; } return buf; }
export async function session(group, id, onProgress, signal) {
  const key = group + '/' + id; if (sessions.has(key)) return sessions.get(key);
  const p = (async () => {
    const reg = await registry(); const m = reg[group][id]; const u = urls(group, m);
    if (!(await isCached(group, [id]))) await download(group, [id], onProgress, signal);
    if (signal?.aborted) throw new DOMException('Đã huỷ', 'AbortError');
    const ort = await getOrt();
    if (isRaw(m)) {
      if (m.gpu && backend !== 'webgpu') throw new Error('Model Chất lượng cao cần WebGPU (Chrome/Edge máy tính hoặc Safari iOS 26+).');
      let buf = await readInto(u.wchunks, m.bytes);
      try { return await ort.InferenceSession.create(buf, lean({ logSeverityLevel: 3, executionProviders: [m.gpu ? 'webgpu' : 'wasm'], graphOptimizationLevel: lowMem || FORCE_GC ? 'disabled' : 'all' })); } finally { buf = null; }
    }
    const use16 = backend === 'webgpu' && hasF16 && !m.no16;
    const segsOf = async () => JSON.parse(new TextDecoder().decode(await cachedBytes(u.segs)));
    if (!use16 && useQ(m)) {
      let w = await readInto(u.qchunks, m.q.size); const graph = await cachedBytes(u.gq);
      try { return await ort.InferenceSession.create(graph, lean({ logSeverityLevel: 3, executionProviders: ['wasm'], externalData: [{ path: 'q.bin', data: w }], graphOptimizationLevel: 'disabled' })); }
      finally { w = null; self.gc?.(); }
    }
    if (!use16 && useGc(m)) {
      // fp16 giữ nguyên trong RAM, KHÔNG tối ưu đồ thị (nếu tối ưu, ORT sẽ gộp Cast → lại thành fp32 gấp đôi RAM)
      let w = await readInto(u.wchunks, m.size16); const graph = await cachedBytes(u.gc);
      try { return await ort.InferenceSession.create(graph, lean({ logSeverityLevel: 3, executionProviders: ['wasm'], externalData: [{ path: 'w.bin', data: w }], graphOptimizationLevel: 'disabled' })); }
      finally { w = null; self.gc?.(); }
    }
    let w = await readInto(u.wchunks, m.size16);
    if (use16) {
      try { return await ort.InferenceSession.create(await cachedBytes(u.g16), { logSeverityLevel: 3, executionProviders: ['webgpu'], externalData: [{ path: 'w.bin', data: w }], graphOptimizationLevel: 'all' }); }
      catch (e) { console.warn('WebGPU lỗi, chuyển sang WASM', e); }
    }
    let w32 = expand(w, await segsOf()); w = null;
    try { return await ort.InferenceSession.create(await cachedBytes(u.g32), lean({ logSeverityLevel: 3, executionProviders: [backend === 'webgpu' && !use16 ? 'webgpu' : 'wasm'], externalData: [{ path: 'w32.bin', data: w32 }], graphOptimizationLevel: 'all' })); }
    catch (e) {
      if (backend !== 'webgpu' || use16) throw e;
      console.warn('WebGPU lỗi, chuyển sang WASM', e);
      return await ort.InferenceSession.create(await cachedBytes(u.g32), lean({ logSeverityLevel: 3, executionProviders: ['wasm'], externalData: [{ path: 'w32.bin', data: w32 }] }));
    } finally { w32 = null; }
  })();
  sessions.set(key, p);
  try { return await p; } catch (e) { sessions.delete(key); throw e; }
}
/** Giải phóng mọi session (trừ keep) — gọi trước khi chuyển giữa Ghép mặt ↔ Tạo ảnh */
export async function releaseAll(keep = []) { for (const k of [...sessions.keys()]) if (!keep.includes(k)) await release(k.split('/')[0], k.slice(k.indexOf('/') + 1)); }
export const hasShaderF16 = () => hasF16;
export async function release(group, id) {
  const key = group + '/' + id; const p = sessions.get(key); if (!p) return; sessions.delete(key);
  try { (await p).release?.(); } catch {}
}
/** Giải phóng các session ghép/làm nét không dùng nữa (WASM chỉ có ~4 GB bộ nhớ). keep = ['swap/id','custom/id',…] */
export async function releaseExcept(groups, keep) {
  for (const k of [...sessions.keys()]) if (groups.includes(k.split('/')[0]) && !keep.includes(k)) await release(k.split('/')[0], k.slice(k.indexOf('/') + 1));
}
export const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isMobile = isIOS || /Android|Mobile/i.test(navigator.userAgent);
// điện thoại/máy tính bảng hoặc máy ≤4 GB RAM → chế độ tiết kiệm RAM (int8/fp16, 1 luồng, mỗi model 1 worker riêng)
export const lowMem = isMobile || !!(navigator.deviceMemory && navigator.deviceMemory <= 4);
function gpuOptIn() { try { return localStorage.getItem('studioai.gpu') === '1'; } catch { return false; } }
export const ortStarted = () => !!ortP;

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

// ---------- chạy cô lập trong worker (máy ít RAM) ----------
export const isolate = () => (lowMem || FORCE_GC) && typeof Worker !== 'undefined' && typeof document !== 'undefined';
let liveWorker = null;
export function cancelIsolated() { if (liveWorker) { liveWorker.terminate(); liveWorker.rej?.(new DOMException('Đã huỷ', 'AbortError')); liveWorker = null; } }
export function inWorker(msg, onProgress, signal) {
  return new Promise((res, rej) => {
    const w = new Worker(new URL('./iso.js', import.meta.url), { type: 'module' }); liveWorker = w; w.rej = rej;
    const end = () => { w.terminate(); if (liveWorker === w) liveWorker = null; signal?.removeEventListener('abort', ab); };
    const ab = () => { end(); rej(new DOMException('Đã huỷ', 'AbortError')); }; signal?.addEventListener('abort', ab);
    w.onmessage = ({ data }) => { if (data.prog) return onProgress?.(...data.prog); end(); if (data.ok) res(data.out); else { const e = new Error(data.err); e.name = data.name || 'Error'; rej(e); } };
    w.onerror = (e) => { end(); rej(new Error('Worker lỗi (có thể do thiếu RAM): ' + (e.message || ''))); };
    w.postMessage({ ...msg, lite: FORCE_GC });
  });
}
/** Chạy 1 lần model (group,id) với inputs [{type,data,dims}] theo thứ tự inputNames → output đầu tiên {type,data,dims} */
export async function runOnce(group, id, inputs, { onProgress, signal, keep = false, noIso = false } = {}) {
  if (!noIso && isolate()) return inWorker({ kind: 'run', group, id, inputs }, onProgress, signal);
  const ort = await getOrt(); const s = await session(group, id, onProgress, signal);
  const feeds = {}; inputs.forEach((x, i) => feeds[s.inputNames[i]] = x instanceof ort.Tensor ? x : new ort.Tensor(x.type, x.data, x.dims));
  const r = await s.run(feeds); const o = r[s.outputNames[0]]; const out = { type: o.type, data: o.data, dims: o.dims };
  if (!keep) await release(group, id); return out;
}
