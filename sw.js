// Service worker Studio AI: thêm header COOP/COEP (để WASM chạy đa luồng), lưu giao diện offline.
// KHÔNG lưu sẵn model lúc cài — model được tải khi người dùng cần và nằm trong Cache Storage riêng.
const VERSION = 'studio-ai-shell-v9';
const SHELL = ['./', 'index.html', 'docs.html', 'css/app.css', 'js/app.js', 'js/api.js', 'js/store.js', 'js/face.js', 'js/img.js', 'js/t2i.js', 'js/clip_tok.js', 'js/translate.js',
  'js/safety.js', 'js/cmd.js', 'js/onnxscan.js', 'js/iso.js', 'js/lock.js', 'video.html', 'js/vswap.js', 'js/vworker.js', 'vendor/mp4-muxer.js', 'vendor/webm-muxer.js', 'models/models.json', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('studio-ai-shell') && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
const scope = new URL(self.registration.scope);
function coi(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const h = new Headers(res.headers); h.set('Cross-Origin-Opener-Policy', 'same-origin'); h.set('Cross-Origin-Embedder-Policy', 'require-corp'); h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
// --- Ghép Mặt Video: phát file video người dùng chọn qua URL thường có hỗ trợ Range (206) ---
// iOS Safari/WebKit đôi khi không tua/giải mã được video từ blob: URL; phục vụ qua SW giống một file trên mạng thì ổn định hơn.
const VF = new Map(), VFC = 'studio-ai-vfile', vkey = (id) => scope.href + '__vfile/' + id;
self.addEventListener('message', e => {
  const m = e.data; if (!m || m.type !== 'vfile') return;
  VF.clear(); VF.set(m.id, { blob: m.blob, type: m.mime }); e.ports[0]?.postMessage('ok');
  e.waitUntil((async () => { const c = await caches.open(VFC); for (const k of await c.keys()) await c.delete(k); await c.put(new Request(vkey(m.id)), new Response(m.blob, { headers: { 'Content-Type': m.mime } })); })().catch(() => {}));   // dự phòng khi SW bị khởi động lại
});
async function vfile(req, id) {
  let ent = VF.get(id);
  if (!ent) { const hit = await (await caches.open(VFC)).match(vkey(id)); if (!hit) return new Response('', { status: 404 }); ent = { blob: await hit.blob(), type: hit.headers.get('Content-Type') }; VF.set(id, ent); }
  const b = ent.blob, n = b.size, h = { 'Content-Type': ent.type || b.type || 'video/mp4', 'Accept-Ranges': 'bytes', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' };
  const r = /bytes=(\d*)-(\d*)/.exec(req.headers.get('Range') || '');
  if (!r || (r[1] === '' && r[2] === '')) return new Response(b, { status: 200, headers: { ...h, 'Content-Length': String(n) } });
  const a = r[1] === '' ? Math.max(0, n - +r[2]) : +r[1], z = r[1] === '' || r[2] === '' ? n - 1 : Math.min(n - 1, +r[2]);
  if (a >= n || z < a) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${n}` } });
  return new Response(b.slice(a, z + 1), { status: 206, headers: { ...h, 'Content-Range': `bytes ${a}-${z}/${n}`, 'Content-Length': String(z - a + 1) } });
}
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== scope.origin || !u.pathname.startsWith(scope.pathname)) return;      // repo model khác: đi thẳng mạng
  if (u.pathname.startsWith(scope.pathname + '__vfile/')) { e.respondWith(vfile(req, u.pathname.split('/').pop())); return; }
  if (/\/models\/(?!models\.json|tok\/|opus\/vocab)/.test(u.pathname) || /\/vendor\//.test(u.pathname) && /\.wasm$/.test(u.pathname)) {
    if (req.mode === 'navigate') return; e.respondWith(fetch(req).then(coi)); return;    // file lớn: không lưu ở đây
  }
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    try { const r = await fetch(req, req.mode === 'navigate' ? undefined : { cache: 'no-cache' }); if (r.ok) c.put(req, r.clone()).catch(() => {}); return coi(r); }
    catch (err) { const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' && await c.match('index.html')); if (hit) return coi(hit); throw err; }
  })());
});
