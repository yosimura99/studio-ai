// Ghép Mặt Video — luồng chính: chọn ảnh + video, chạm chọn mặt, xem thử, rồi giải mã → worker xử lý → mã hoá theo dòng.
import * as S from './store.js';
const $ = (s) => document.querySelector(s);
const LIM = S.lowMem ? { dur: 30, long: 720, res: [720, 540, 480] } : { dur: 180, long: 1920, res: [1920, 1280, 1080, 720, 480] };
const GPU_FLAG = 'studioai.v.gpucrash', RUN_FLAG = 'studioai.v.running';
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
const IN = { src: $('#srcFile'), vid: $('#vidFile') };
const st = { src: null, vurl: null, file: null, ready: false, sel: 0, faces: [], scanned: new Set(), busy: false, cancel: false, msPer: 0, out: null, w: null, backend: '' };
// Một thẻ <video> duy nhất, GẮN VÀO TRANG (ô Video) và hiển thị được: iOS Safari không nạp/giải mã khung cho video tách rời trang
// hoặc chưa từng play() — đó là lý do lỗi "Không tua được video" trên iPhone.
const video = document.createElement('video');
video.muted = true; video.defaultMuted = true; video.setAttribute('muted', ''); video.playsInline = true; video.setAttribute('playsinline', ''); video.setAttribute('webkit-playsinline', '');
video.preload = 'auto'; video.disablePictureInPicture = true; video.setAttribute('disableremoteplayback', ''); video.className = 'vsrc';

// ---------- worker RPC ----------
let W = null, seq = 0; const pend = new Map(); let onProg = null;
function worker() {
  if (W) return W;
  W = new Worker(new URL('./vworker.js', import.meta.url), { type: 'module' });
  W.onmessage = ({ data: m }) => { if (m.prog) { onProg && onProg(...m.prog); return; } const p = pend.get(m.id); if (!p) return; pend.delete(m.id); m.ok ? p.res(m) : p.rej(Object.assign(new Error(m.err), { name: m.name || 'Error' })); };
  W.onerror = (e) => { e.preventDefault?.(); killWorker(new Error('Hết bộ nhớ hoặc trình duyệt dừng tiến trình xử lý. Thử độ phân giải thấp hơn, đoạn ngắn hơn hoặc tắt Làm nét/GPU.')); };
  return W;
}
function killWorker(err) { if (W) W.terminate(); W = null; st.ready = false; for (const p of pend.values()) p.rej(err || new DOMException('Đã huỷ', 'AbortError')); pend.clear(); }
const call = (kind, msg = {}, tr = []) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); worker().postMessage({ ...msg, kind, id }, tr); });

// ---------- giao diện ----------
function status(text, frac, err) { const el = $('#status'); el.hidden = !text; el.classList.toggle('err', !!err); $('#statusText').textContent = text || ''; $('#statusText').style.color = err ? 'var(--bad)' : ''; if (frac != null) $('#barI').style.width = Math.round(frac * 100) + '%'; if (!text || err) $('#eta').textContent = ''; }
const fail = (e) => { console.warn(e); st.busy = false; $('#cancel').hidden = true; lockUI(false); status('⚠️ ' + (e?.name === 'AbortError' || e?.message === 'CANCELLED' ? 'Đã huỷ.' : S.friendlyError(e)), null, true); };
const fmt = (s) => s >= 90 ? `${Math.floor(s / 60)} phút ${Math.round(s % 60)} giây` : `${Math.round(s)} giây`;
function lockUI(on) { IN.src.disabled = IN.vid.disabled = on; for (const id of ['#go', '#prevBtn', '#res', '#fps', '#tFrom', '#tTo', '#restoreOn', '#gpuOn', '#keepMouth', '#colorOn']) $(id).disabled = on; if (!on) $('#go').disabled = !canRun(); }
const canRun = () => st.src && st.file && st.faces.length && $('#consent').checked && !st.busy;
const MB = (b) => (b / 1048576).toFixed(0) + ' MB';
const VLIM = S.lowMem ? 'Điện thoại: tối đa 30 giây, 720p' : 'Máy tính: tối đa 3 phút, 1080p+'; $('#vidLimit').textContent = VLIM;
const gpuAvail = !!navigator.gpu;
$('#gpuOn').checked = gpuAvail && !ls.get(GPU_FLAG); $('#gpuOn').closest('label').hidden = !gpuAvail;
$('#restoreOn').checked = !S.lowMem && gpuAvail;
if (ls.get(RUN_FLAG)) { status('⚠️ Lần trước bị dừng đột ngột (có thể do thiếu RAM). Hãy thử độ phân giải thấp hơn, đoạn ngắn hơn, hoặc tắt Làm nét/GPU.', null, true); ls.set(RUN_FLAG, null); }
if (ls.get(GPU_FLAG)) $('#estHint').textContent = 'GPU bị lỗi ở lần trước nên đã chuyển sang CPU.';

function loadImg(file) { return new Promise((res, rej) => { const u = URL.createObjectURL(file); const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Không đọc được ảnh này.')); i.src = u; }); }
async function bitmapOf(img, maxLong) { const sc = Math.min(1, maxLong / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height)); const w = Math.round((img.naturalWidth || img.width) * sc), h = Math.round((img.naturalHeight || img.height) * sc); const c = new OffscreenCanvas(w, h); c.getContext('2d').drawImage(img, 0, 0, w, h); return c.transferToImageBitmap(); }

IN.src.onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { const img = await loadImg(f); st.src = img; st.srcScanned = false; $('#srcSlot').replaceChildren(IN.src, img); await prepare(); } catch (err) { fail(err); }
};
const BAD_FMT = 'Trình duyệt không giải mã được video này (thường là video HEVC/HDR từ camera iPhone hoặc codec lạ). Cách khắc phục: (1) Mở app Ảnh → chọn video → Chia sẻ → "Lưu vào Tệp" rồi chọn lại, hoặc Sửa → Xong → "Lưu thành video mới"; (2) Cài đặt → Camera → Định dạng → chọn "Tương thích nhất" rồi quay lại; (3) Dùng bản MP4 (H.264) tải từ TikTok/Facebook.';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function waitEv(el, evs, ms) { return new Promise(res => { let t = 0; const h = (e) => { clean(); res(e.type); }; const clean = () => { clearTimeout(t); for (const n of evs) el.removeEventListener(n, h); }; for (const n of evs) el.addEventListener(n, h); t = setTimeout(() => { clean(); res(null); }, ms); }); }
function frameCb(ms) {   // chờ 1 khung được trình chiếu (rVFC) — có thời hạn
  return new Promise(res => {
    if (!('requestVideoFrameCallback' in video)) { setTimeout(() => res(null), Math.min(ms, 150)); return; }
    let done = false; const id = video.requestVideoFrameCallback((n, m) => { if (!done) { done = true; res(m.mediaTime ?? video.currentTime); } });
    setTimeout(() => { if (!done) { done = true; try { video.cancelVideoFrameCallback(id); } catch {} res(null); } }, ms);
  });
}
async function tryPlay(ms = 2500) { try { const p = video.play(); if (p) await Promise.race([p, sleep(ms)]); return !video.paused; } catch { return false; } }
function vidPlaceholder(msg) { const ph = document.createElement('div'); ph.className = 'ph'; ph.innerHTML = `<b>＋</b>Video<small>${msg || ''}</small>`; $('#vidSlot').replaceChildren(IN.vid, ph); }
// Gửi file cho service worker → nhận URL thường (hỗ trợ Range). null nếu không có SW điều khiển trang.
async function swUrl(f) {
  const ctl = navigator.serviceWorker?.controller; if (!ctl) return null;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const ext = (f.name.split('.').pop() || '').toLowerCase(), apple = /iPhone|iPad|Macintosh/.test(navigator.userAgent) && !/Chrome|Android/.test(navigator.userAgent);
  let mime = f.type || ({ mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/webm' }[ext] || 'video/mp4');
  if (mime === 'video/quicktime' && !apple) mime = 'video/mp4';
  const ok = await new Promise(res => { try { const ch = new MessageChannel(); ch.port1.onmessage = () => res(true); ctl.postMessage({ type: 'vfile', id, blob: f, mime }, [ch.port2]); setTimeout(() => res(false), 4000); } catch { res(false); } });
  return ok ? new URL('__vfile/' + id, location.href).href : null;
}
// Mở 1 nguồn và kiểm tra thật sự giải mã + tua được (trả về lỗi dạng chuỗi nếu không)
async function tryOpen(src) {
  st.playMode = false; video.pause(); video.removeAttribute('src'); video.src = src; video.load();
  const pp = video.play(); if (pp) pp.catch(() => {});
  const ev = await waitEv(video, ['loadedmetadata', 'error'], 12000);
  if (ev !== 'loadedmetadata' || !video.videoWidth) return 'meta:' + (video.error?.code || 'timeout');
  if (video.readyState < 2) { if (video.paused) await tryPlay(); await Promise.race([waitEv(video, ['loadeddata', 'canplay', 'playing', 'error'], 10000), frameCb(10000)]); }
  if (video.error) return 'data:' + video.error.code;
  st.srcFps = await probeFps(); video.pause();
  const D = video.duration || 0, mid = Math.min(1, D / 2);
  if (!(await seek(mid, true)) || Math.abs(video.currentTime - mid) > 0.3) return 'seek';
  if (!(await seek(0.001, true))) return 'seek0';
  if (video.error) return 'err:' + video.error.code;
  if (!(await hasPicture())) return 'black';
  return null;
}
IN.vid.addEventListener('click', () => { try { const p = video.play(); if (p) p.catch(() => {}); video.pause(); } catch {} });   // chạm thật vào ô → "mở khoá" phát video trên iOS
IN.vid.onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  if (st.vurl) URL.revokeObjectURL(st.vurl);
  st.file = f; st.vurl = URL.createObjectURL(f); st.scanned = new Set(); st.faces = []; st.playMode = false;
  $('#pickCard').hidden = true; $('#prevCard').hidden = true; lockUI(st.busy);
  // gắn video vào trang ngay (iOS cần thẻ video nằm trong trang, hiển thị được) + play() ngay trong sự kiện
  video.src = st.vurl; const p0 = video.play(); if (p0) p0.catch(() => {});
  $('#vidSlot').replaceChildren(IN.vid, video);
  try {
    status('Đang mở video…', 0.01);
    const srcs = [await swUrl(f), st.vurl].filter(Boolean); let why = [];
    for (const src of srcs) { const r = await tryOpen(src); if (!r) { why = null; break; } why.push((src.startsWith('blob:') ? 'blob ' : 'sw ') + r); console.warn('mở video thất bại', src.slice(0, 40), r); }
    if (why) {   // cuối cùng: chế độ phát-từng-bước nếu ít nhất phát được
      if (video.videoWidth && video.readyState >= 2 && !video.error && (await playTo(0.3)) && video.currentTime > 0.05) { st.playMode = true; console.warn('dùng chế độ phát từng bước', why); }
      else throw new Error(BAD_FMT + ' [' + why.join(', ') + ']');
    }
    setupControls(); status('', null); await prepare();
  } catch (err) { video.pause(); video.removeAttribute('src'); try { video.load(); } catch {} st.file = null; vidPlaceholder(VLIM); fail(err); }
};
$('#consent').onchange = () => { lockUI(st.busy); };

function setupControls() {
  const d = video.duration || 0, vw = video.videoWidth, vh = video.videoHeight, L = Math.max(vw, vh);
  $('#tFrom').value = 0; $('#tTo').value = (Math.min(d, LIM.dur)).toFixed(1); $('#tFrom').max = $('#tTo').max = d.toFixed(1);
  const res = $('#res'); res.innerHTML = ''; const opts = [...new Set([Math.min(L, LIM.long), ...LIM.res.filter(r => r < L)])].sort((a, b) => b - a);
  for (const r of opts) res.add(new Option(r + (r === L ? ' (gốc)' : '') + ' px', r));
  res.value = Math.min(L, S.lowMem ? 720 : 1280); if (!res.value) res.selectedIndex = 0;
  const f = $('#fps'); f.innerHTML = ''; const top = Math.min(30, Math.round(st.srcFps || 30)); for (const v of [...new Set([top, 24, 15].filter(v => v <= top))]) f.add(new Option(v + ' fps' + (v === top ? ' (theo clip)' : ''), v));
  $('#pT').max = d.toFixed(2); $('#pT').value = Math.min(d, 1).toFixed(2);
  if (d > LIM.dur) $('#pickHint').textContent = `Video dài ${d.toFixed(1)} s — ${S.lowMem ? 'trên điện thoại' : ''} chỉ ghép tối đa ${LIM.dur} s, chọn đoạn bên dưới.`;
}
// Tua tới t (giây) chắc chắn có khung: chờ 'seeked' + rVFC (có thời hạn); nếu iOS không phản hồi thì "huých" bằng play()/pause().
async function seek(t, strict) {
  const D = video.duration || 0; t = Math.max(0.001, D ? Math.min(t, D - 0.001) : t);
  if (st.playMode) return playTo(t);
  for (let k = 0; k < 3; k++) {
    if (video.error) break;   // lỗi giải mã: thôi, đừng chờ
    if (!video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - t) < 1e-3) return true;
    const fc = frameCb(k ? 2500 : 1200), ev = waitEv(video, ['seeked'], k ? 6000 : 4000);
    video.currentTime = t;
    if (await ev) { await Promise.race([fc, sleep(150)]); if (video.readyState >= 2) return true; }
    // huých: phát ngắn rồi dừng (iOS đôi khi chỉ giải mã sau khi play())
    await tryPlay(1500); await Promise.race([frameCb(1500), waitEv(video, ['timeupdate', 'playing'], 1500)]); video.pause();
    if (video.readyState >= 2 && Math.abs(video.currentTime - t) < 0.25) return true;
  }
  // tua không được → chuyển sang chế độ phát-từng-bước (chỉ đi tới)
  if (strict || video.error) return false;
  console.warn('seek không ổn định → chế độ phát từng bước'); st.playMode = true; return playTo(t);
}
async function playTo(t) {
  const half = 0.5 / (st.srcFps || 30);
  if (video.currentTime > t + 0.25) { video.currentTime = t; await Promise.race([waitEv(video, ['seeked'], 3000), frameCb(3000)]); }   // lùi lại (thử, không chờ lâu)
  if (video.currentTime >= t - half && video.readyState >= 2) return true;   // đã tới/qua: dùng khung hiện tại
  const T = performance.now();
  if (!(await tryPlay(3000))) return false;
  while (performance.now() - T < 15000) { const m = await frameCb(2000); if (video.ended || video.error) break; if ((m ?? video.currentTime) >= t - half) break; }
  video.pause(); return video.readyState >= 2 && !video.error;
}
async function probeFps() {
  if (!('requestVideoFrameCallback' in video)) return 30;
  try {
    const ts = []; if (video.paused && !(await tryPlay())) return 30;
    await new Promise(res => { const cb = (n, m) => { ts.push(m.mediaTime); if (ts.length < 14) video.requestVideoFrameCallback(cb); else res(); }; video.requestVideoFrameCallback(cb); setTimeout(res, 2500); });
    video.pause();
    const d = []; for (let i = 1; i < ts.length; i++) if (ts[i] > ts[i - 1]) d.push(ts[i] - ts[i - 1]); d.sort((a, b) => a - b);
    const med = d[Math.floor(d.length / 2)]; return med ? Math.max(10, Math.min(60, 1 / med)) : 30;
  } catch { return 30; } finally { video.pause(); }
}
const probeC = document.createElement('canvas'); probeC.width = probeC.height = 16;
function blackFrame() { try { const g = probeC.getContext('2d', { willReadFrequently: true }); g.drawImage(video, 0, 0, 16, 16); const d = g.getImageData(0, 0, 16, 16).data; let mx = 0; for (let i = 0; i < d.length; i += 4) mx = Math.max(mx, d[i], d[i + 1], d[i + 2]); return mx < 6; } catch { return false; } }
async function hasPicture() { for (let k = 0; k < 3; k++) { if (!blackFrame()) return true; await tryPlay(1200); await frameCb(1200); video.pause(); } return !blackFrame() || video.readyState >= 2; }
function dims() { const vw = video.videoWidth, vh = video.videoHeight; const L = +$('#res').value || Math.max(vw, vh); const sc = Math.min(1, L / Math.max(vw, vh)); return [Math.round(vw * sc / 2) * 2, Math.round(vh * sc / 2) * 2]; }
const grabC = { c: null };
async function grab(t, w, h) {
  if (!(await seek(t))) throw new Error('Không tua được video. ' + BAD_FMT);
  if (!grabC.c || grabC.c.width !== w || grabC.c.height !== h) { grabC.c = document.createElement('canvas'); grabC.c.width = w; grabC.c.height = h; }
  const g = grabC.c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(video, 0, 0, w, h);   // HDR (HEVC 10-bit): Safari tự chuyển về SDR khi vẽ
  return createImageBitmap(grabC.c);
}

// ---------- chuẩn bị: tải model, kiểm duyệt ảnh nguồn, dò mặt khung đầu ----------
const LIST = () => [['face', 'det', 'dò mặt'], ['face', 'arcface', 'nhận diện'], ['swap', 'inswapper_128', 'ghép mặt'], ['face', 'bisenet', 'mặt nạ'], ...($('#restoreOn').checked ? [['restore', 'gfpgan_1.4', 'làm nét']] : [])];
async function ensureWorker() {
  if (st.ready) { await call('setOpts', { opts: curOpts() }); return; }
  const need = [...LIST(), ['face', 'nsfw', 'kiểm duyệt']]; const miss = [];
  for (const [g, id] of need) if (!(await S.isCached(g, [id]))) miss.push([g, id]);
  if (miss.length) { let tot = 0; for (const [g, id] of miss) tot += await S.totalBytes(g, [id]); if (!confirm(`Cần tải ${MB(tot)} model (chỉ lần đầu, sau đó dùng offline). Tiếp tục?`)) throw new DOMException('Đã huỷ', 'AbortError'); }
  const useGpu = $('#gpuOn').checked && gpuAvail;
  const r = await call('init', { opts: curOpts(), lite: S.lowMem, threads: S.lowMem ? 4 : 0 });   // trang video: cho phép đa luồng cả trên điện thoại (cần cô lập cross-origin)
  st.backend = r.backend; $('#backend').textContent = r.backend; st.gpuRun = /WebGPU/.test(r.backend) && useGpu;
  onProg = (d, t, label) => status(`Đang tải model ${label}… ${MB(d)} / ${MB(t)}`, t ? d / t : null);
  if (st.gpuRun) ls.set(GPU_FLAG, '1');
  await call('load', { list: [...LIST(), ['face', 'nsfw', 'kiểm duyệt']] });
  if (st.gpuRun) ls.set(GPU_FLAG, null);
  onProg = null; st.ready = true;
}
const curOpts = () => ({ gpu: $('#gpuOn').checked && gpuAvail, restore: $('#restoreOn').checked, keepMouth: $('#keepMouth').checked, color: $('#colorOn').checked });
for (const id of ['#keepMouth', '#colorOn', '#restoreOn']) $(id).onchange = () => { if (st.ready) call('setOpts', { opts: curOpts() }).catch(() => {}); };
$('#gpuOn').onchange = () => { if (st.ready) killWorker(); ls.set(GPU_FLAG, null); };
$('#restoreOn').addEventListener('change', () => { if ($('#restoreOn').checked && st.ready) call('load', { list: [['restore', 'gfpgan_1.4', 'làm nét']] }).catch(fail); });

async function nsfwCheck(bmp) { const r = await call('nsfw', { bitmap: bmp }, [bmp]); return r.block; }
const REFUSE = 'Ảnh hoặc video có nội dung nhạy cảm/khiêu dâm — Studio AI không ghép mặt cho nội dung này.';

async function prepare() {
  if (!st.src || !st.file || st.busy) return;
  st.busy = true; lockUI(true);
  try {
    status('Đang chuẩn bị model…', 0.02);
    await ensureWorker();
    if (!st.srcScanned) {
      status('Kiểm tra ảnh nguồn…', 0.5);
      if (await nsfwCheck(await bitmapOf(st.src, 1024))) { st.src = null; throw new Error(REFUSE); }
      const r = await call('source', { bitmap: await bitmapOf(st.src, 1280) }, []);
      if (!r.n) { throw new Error('Không thấy khuôn mặt trong ảnh nguồn. Hãy chọn ảnh rõ mặt, nhìn thẳng.'); }
      st.srcScanned = true;
    }
    status('Dò khuôn mặt trong video…', 0.8);
    const [w, h] = dims(); const t0 = +$('#tFrom').value || 0;
    const b = await grab(Math.min(video.duration - 0.01, t0 + 0.02), w, h);
    const fb = await createImageBitmap(b);   // giữ một bản để vẽ khung chọn
    const r = await call('faces', { bitmap: b }, [b]);
    st.faces = r.faces; st.firstDims = [w, h]; st.firstT = t0;
    if (!st.faces.length) { drawPick(fb); fb.close(); throw new Error('Không thấy khuôn mặt nào ở khung đầu của đoạn đã chọn. Đổi "Từ giây" tới chỗ thấy rõ mặt.'); }
    st.sel = 0; st.pickBmp = fb; drawPick(fb); await choose(0);
    $('#pickCard').hidden = false; $('#prevCard').hidden = false;
    status('Sẵn sàng. Chạm vào mặt cần thay (nếu có nhiều người), xem thử rồi bấm Ghép video.', 1);
  } catch (e) { st.busy = false; lockUI(false); fail(e); return; }
  st.busy = false; lockUI(false);
}
function drawPick(bmp) {
  const c = $('#pick'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
  g.lineWidth = Math.max(2, bmp.width / 300);
  st.faces.forEach((f, i) => { const [x1, y1, x2, y2] = f.box; g.strokeStyle = i === st.sel ? '#9b6bff' : 'rgba(255,255,255,.7)'; g.setLineDash(i === st.sel ? [] : [8, 6]); g.strokeRect(x1, y1, x2 - x1, y2 - y1); if (i === st.sel) { g.fillStyle = '#9b6bff'; g.font = `bold ${Math.max(14, bmp.width / 40)}px sans-serif`; g.fillText('✓ mặt sẽ thay', x1, Math.max(16, y1 - 6)); } });
  $('#pickHint').textContent = st.faces.length > 1 ? `Thấy ${st.faces.length} khuôn mặt — chạm vào người cần thay.` : (video.duration > LIM.dur ? $('#pickHint').textContent : 'Đã chọn khuôn mặt duy nhất.');
}
async function choose(i) { st.sel = i; const r = await call('select', { index: i }); if (st.pickBmp) drawPick(st.pickBmp); return r; }
$('#pick').onclick = async (e) => {
  if (st.busy || !st.faces.length) return; const c = $('#pick'), rc = c.getBoundingClientRect(); const x = (e.clientX - rc.left) * c.width / rc.width, y = (e.clientY - rc.top) * c.height / rc.height;
  let best = -1, bd = 1e18; st.faces.forEach((f, i) => { const [x1, y1, x2, y2] = f.box; const inside = x >= x1 && x <= x2 && y >= y1 && y <= y2; const d = inside ? 0 : Math.hypot(x - (x1 + x2) / 2, y - (y1 + y2) / 2); if (d < bd) { bd = d; best = i; } });
  if (best >= 0) choose(best).catch(fail);
};
let reprepT = null; for (const id of ['#tFrom', '#res']) $(id).addEventListener('change', () => { clearTimeout(reprepT); reprepT = setTimeout(prepare, 200); });

// kiểm duyệt ~1 khung/giây trong đoạn đã chọn (chỉ quét những giây chưa quét)
async function scanRange(a, b, w, h, frac0 = 0, frac1 = 0.1) {
  const secs = []; for (let s = Math.floor(a); s <= Math.ceil(b - 0.01); s++) if (!st.scanned.has(s)) secs.push(s);
  for (let i = 0; i < secs.length; i++) {
    if (st.cancel) throw new DOMException('Đã huỷ', 'AbortError');
    status(`Kiểm tra nội dung… ${i + 1}/${secs.length}`, frac0 + (frac1 - frac0) * i / secs.length);
    const t = Math.min(video.duration - 0.02, Math.max(a, secs[i] + 0.5)); const bm = await grab(t, Math.min(w, 448), Math.round(Math.min(w, 448) * h / w));
    if (await nsfwCheck(bm)) throw new Error(REFUSE);
    st.scanned.add(secs[i]);
  }
}

// ---------- xem thử ----------
$('#prevBtn').onclick = async () => {
  if (!canRun()) { if (!$('#consent').checked) status('Hãy đánh dấu ô đồng ý trước.', null, true); return; }
  st.busy = true; st.cancel = false; lockUI(true);
  try {
    await ensureWorker(); const [w, h] = dims(); const t = +$('#pT').value;
    await scanRange(t, t + 0.01, w, h);
    status('Đang ghép thử…', 0.5);
    const b = await grab(t, w, h); const keep = await createImageBitmap(b);
    const t0 = performance.now(); const r = await call('frame', { bitmap: b, t, fresh: Math.abs(t - st.firstT) > 0.05 }, [b]); const ms = performance.now() - t0;
    for (const [id, bm] of [['#cA', keep], ['#cB', r.bitmap]]) { const c = $(id); c.width = bm.width; c.height = bm.height; c.getContext('2d').drawImage(bm, 0, 0); bm.close(); }
    $('#cmp').hidden = false; $('#cBcap').textContent = r.info.found ? `Đã ghép · ${(ms / 1000).toFixed(2)} s/khung` : (r.info.profile ? 'Mặt nghiêng quá — giữ khung gốc' : 'Không nhận ra người đã chọn ở khung này — giữ khung gốc');
    st.msPer = ms; estimate();
    await call('reset', {});
    status('Xem thử xong.', 1);
  } catch (e) { fail(e); }
  st.busy = false; lockUI(false);
};
function estimate() { const a = +$('#tFrom').value, b = +$('#tTo').value; const n = Math.max(1, Math.round((b - a) * +$('#fps').value)); if (st.msPer) $('#estHint').textContent = `Ước tính: ${n} khung × ${(st.msPer / 1000).toFixed(2)} s ≈ ${fmt(n * st.msPer / 1000 * 1.1)} (${st.backend}).`; }
for (const id of ['#tTo', '#fps']) $(id).addEventListener('change', estimate);

// ---------- âm thanh ----------
async function decodeAudio(a, b) {
  try {
    const buf = await st.file.arrayBuffer(); const ctx = new OfflineAudioContext(2, 48000, 48000);
    const ab = await ctx.decodeAudioData(buf); const s0 = Math.floor(a * ab.sampleRate), s1 = Math.min(ab.length, Math.floor(b * ab.sampleRate));
    if (s1 <= s0) return null; const n = Math.round((s1 - s0) / ab.sampleRate * 48000);
    const oc = new OfflineAudioContext(2, n, 48000); const src = oc.createBufferSource(); const cut = oc.createBuffer(ab.numberOfChannels, s1 - s0, ab.sampleRate);
    for (let c = 0; c < ab.numberOfChannels; c++) cut.copyToChannel(ab.getChannelData(c).subarray(s0, s1), c);
    src.buffer = cut; src.connect(oc.destination); src.start(); return await oc.startRendering();
  } catch (e) { console.warn('audio', e); return null; }
}
async function pickV(w, h, fps) {
  const bitrate = Math.round(Math.min(16e6, Math.max(1.2e6, w * h * fps * 0.12)));
  const list = [['mp4', 'avc', 'avc1.640033'], ['mp4', 'avc', 'avc1.640028'], ['mp4', 'avc', 'avc1.4d0028'], ['mp4', 'avc', 'avc1.42e01f'], ['webm', 'V_VP9', 'vp09.00.40.08'], ['webm', 'V_VP8', 'vp8']];
  for (const [box, mux, codec] of list) { const cfg = { codec, width: w, height: h, bitrate, framerate: fps }; if (mux === 'avc') cfg.avc = { format: 'avc' }; try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return { box, mux, cfg }; } catch {} }
  return null;
}
async function pickA(box) {
  if (typeof AudioEncoder === 'undefined') return null;
  const list = box === 'mp4' ? [['aac', 'mp4a.40.2'], ['opus', 'opus']] : [['A_OPUS', 'opus']];
  for (const [mux, codec] of list) { const cfg = { codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }; try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { mux, cfg }; } catch {} }
  return null;
}

// ---------- chạy cả clip ----------
$('#go').onclick = async () => {
  if (!canRun()) { if (!$('#consent').checked) status('Hãy đánh dấu ô đồng ý trước.', null, true); return; }
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') { status('⚠️ Trình duyệt chưa hỗ trợ mã hoá video (WebCodecs). Hãy cập nhật iOS 16.4+ / Safari 17+ hoặc dùng Chrome/Edge mới.', null, true); return; }
  let a = Math.max(0, +$('#tFrom').value || 0), b = Math.min(video.duration, +$('#tTo').value || video.duration);
  if (b - a > LIM.dur + 0.05) { b = a + LIM.dur; $('#tTo').value = b.toFixed(1); }
  if (b - a < 0.2) { status('Đoạn video quá ngắn.', null, true); return; }
  st.busy = true; st.cancel = false; lockUI(true); $('#cancel').hidden = false; $('#outCard').hidden = true;
  if (st.out) { URL.revokeObjectURL(st.out.url); st.out = null; }
  let venc = null, aenc = null, crashSet = false;
  try {
    await ensureWorker(); const [w, h] = dims(); const fps = +$('#fps').value || 30;
    await scanRange(a, b, w, h, 0, 0.08);
    await call('nsfwDone');  // giải phóng model kiểm duyệt trước khi chạy cả clip (giảm RAM)
    st.scanned = new Set(); st.nsfwFreed = true;
    // nếu khung đầu khác chỗ đã chọn mặt → chọn lại
    if (Math.abs(st.firstT - a) > 0.05 || st.firstDims?.[0] !== w) { st.busy = false; await prepare(); st.busy = true; lockUI(true); }
    await call('reset', {});
    status('Đang chuẩn bị âm thanh…', 0.09);
    const audio = await decodeAudio(a, b);
    const vconf = await pickV(w, h, fps); if (!vconf) throw new Error('Trình duyệt không mã hoá được video ở kích thước này. Thử độ phân giải thấp hơn.');
    const aconf = audio ? await pickA(vconf.box) : null;
    let warn = audio && !aconf ? 'Trình duyệt không mã hoá được âm thanh — video không có tiếng (cần iOS 26+/Safari 26+ hoặc Chrome).' : (!audio ? 'Video gốc không có tiếng (hoặc không đọc được).' : '');
    let muxer, target;
    if (vconf.box === 'mp4') { target = new Mp4Muxer.ArrayBufferTarget(); muxer = new Mp4Muxer.Muxer({ target, video: { codec: vconf.mux, width: w, height: h, frameRate: fps }, ...(aconf ? { audio: { codec: aconf.mux, numberOfChannels: 2, sampleRate: 48000 } } : {}), fastStart: 'in-memory', firstTimestampBehavior: 'offset' }); }
    else { target = new WebMMuxer.ArrayBufferTarget(); muxer = new WebMMuxer.Muxer({ target, video: { codec: vconf.mux, width: w, height: h, frameRate: fps }, ...(aconf ? { audio: { codec: aconf.mux, numberOfChannels: 2, sampleRate: 48000 } } : {}), firstTimestampBehavior: 'offset' }); }
    let encErr = null;
    venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => { encErr = e; } }); venc.configure(vconf.cfg);
    // âm thanh mã hoá trước (nhỏ), để khung hình được ghi theo dòng
    if (aconf) {
      aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => { encErr = e; } }); aenc.configure(aconf.cfg);
      const n = audio.length, L = audio.getChannelData(0), R = audio.numberOfChannels > 1 ? audio.getChannelData(1) : L;
      for (let off = 0; off < n; off += 4800) { const k = Math.min(4800, n - off); const buf = new Float32Array(k * 2); buf.set(L.subarray(off, off + k), 0); buf.set(R.subarray(off, off + k), k); const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: k, numberOfChannels: 2, timestamp: Math.round(off / 48000 * 1e6), data: buf }); aenc.encode(ad); ad.close(); if (aenc.encodeQueueSize > 20) await new Promise(r => setTimeout(r, 2)); }
      await aenc.flush(); aenc.close(); aenc = null;
    }
    const N = Math.max(1, Math.floor((b - a) * fps + 1e-6)); const T0 = performance.now(); let found = 0, emaMs = 0;
    ls.set(RUN_FLAG, '1'); crashSet = true; if (st.gpuRun) ls.set(GPU_FLAG, '1');
    const tOf = (i) => Math.min(video.duration - 0.005, a + (i + 0.5) / fps);
    let next = grab(tOf(0), w, h);
    for (let i = 0; i < N; i++) {
      if (st.cancel) throw new DOMException('Đã huỷ', 'AbortError');
      const bm = await next; const t1 = performance.now();
      const p = call('frame', { bitmap: bm, t: (i + 0.5) / fps }, [bm]);
      if (i + 1 < N) next = grab(tOf(i + 1), w, h);   // giải mã khung kế tiếp trong lúc worker đang ghép
      const r = await p;
      if (r.info.found) found++;
      const vf = new VideoFrame(r.bitmap, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      venc.encode(vf, { keyFrame: i % (fps * 2) === 0 }); vf.close(); r.bitmap.close();
      while (venc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 4));
      if (encErr) throw encErr;
      const dt = performance.now() - t1; emaMs = i ? emaMs * 0.85 + dt * 0.15 : dt;
      const el = (performance.now() - T0) / 1000, left = (N - i - 1) * emaMs / 1000;
      status(`Đang ghép khung ${i + 1}/${N} · ${found} khung có mặt`, 0.1 + 0.88 * (i + 1) / N); $('#eta').textContent = `đã chạy ${fmt(el)} · còn ~${fmt(left)}`;
    }
    await venc.flush(); venc.close(); venc = null; if (encErr) throw encErr; muxer.finalize();
    if (st.gpuRun) ls.set(GPU_FLAG, null); ls.set(RUN_FLAG, null); crashSet = false;
    const mime = vconf.box === 'mp4' ? 'video/mp4' : 'video/webm'; const blob = new Blob([target.buffer], { type: mime });
    const url = URL.createObjectURL(blob); st.out = { blob, url, ext: vconf.box, mime };
    $('#outV').src = url; $('#outCard').hidden = false;
    const secs = (performance.now() - T0) / 1000;
    $('#outHint').textContent = `${w}×${h} · ${fps} fps · ${N} khung (${found} khung đã ghép) · ${vconf.cfg.codec}${aconf ? ' + ' + aconf.cfg.codec : ''} · ${MB(blob.size)} · mất ${fmt(secs)} (${(secs / N).toFixed(2)} s/khung, ${st.backend}). ${warn}`;
    window.__vlast = { N, found, secs, w, h, fps, codec: vconf.cfg.codec, audio: aconf?.cfg.codec || null, size: blob.size, backend: st.backend };
    status('✅ Xong! Xem, tải về hoặc chia sẻ bên dưới.', 1); $('#outCard').scrollIntoView({ behavior: 'smooth' });
    // nạp lại model kiểm duyệt cho lần sau (sẽ tải từ bộ nhớ đệm)
  } catch (e) {
    try { venc && venc.state !== 'closed' && venc.close(); aenc && aenc.state !== 'closed' && aenc.close(); } catch {}
    if (crashSet) { ls.set(RUN_FLAG, null); if (st.gpuRun) ls.set(GPU_FLAG, null); }
    fail(e);
  }
  if (st.nsfwFreed) { st.nsfwFreed = false; st.scanned = new Set(); }
  st.busy = false; $('#cancel').hidden = true; lockUI(false);
};
$('#cancel').onclick = () => { st.cancel = true; status('Đang huỷ…', null); };
$('#dl').onclick = () => { if (!st.out) return; const a = $('#dlA'); a.href = st.out.url; a.download = `studio-ai-video-${Date.now()}.${st.out.ext}`; a.click(); };
$('#share').onclick = async () => {
  if (!st.out) return; const f = new File([st.out.blob], `studio-ai-video.${st.out.ext}`, { type: st.out.mime });
  try { if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title: 'Studio AI' }); else $('#dl').click(); } catch (e) { if (e.name !== 'AbortError') $('#dl').click(); }
};
if (/[?&]vtest\b/.test(location.search)) window.__vtest = { grab, seek, st, video };
window.addEventListener('pagehide', () => { if (!st.busy) ls.set(RUN_FLAG, null); });
