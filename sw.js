// Service worker Studio AI: thêm header COOP/COEP (để WASM chạy đa luồng), lưu giao diện offline.
// KHÔNG lưu sẵn model lúc cài — model được tải khi người dùng cần và nằm trong Cache Storage riêng.
const VERSION = 'studio-ai-shell-v6';
const SHELL = ['./', 'index.html', 'docs.html', 'css/app.css', 'js/app.js', 'js/api.js', 'js/store.js', 'js/face.js', 'js/img.js', 'js/t2i.js', 'js/clip_tok.js', 'js/translate.js',
  'js/safety.js', 'js/cmd.js', 'js/onnxscan.js', 'js/iso.js', 'js/lock.js', 'models/models.json', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('studio-ai-shell') && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
const scope = new URL(self.registration.scope);
function coi(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const h = new Headers(res.headers); h.set('Cross-Origin-Opener-Policy', 'same-origin'); h.set('Cross-Origin-Embedder-Policy', 'require-corp'); h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== scope.origin || !u.pathname.startsWith(scope.pathname)) return;      // repo model khác: đi thẳng mạng
  if (/\/models\/(?!models\.json|tok\/|opus\/vocab)/.test(u.pathname) || /\/vendor\//.test(u.pathname) && /\.wasm$/.test(u.pathname)) {
    if (req.mode === 'navigate') return; e.respondWith(fetch(req).then(coi)); return;    // file lớn: không lưu ở đây
  }
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    try { const r = await fetch(req, req.mode === 'navigate' ? undefined : { cache: 'no-cache' }); if (r.ok) c.put(req, r.clone()).catch(() => {}); return coi(r); }
    catch (err) { const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' && await c.match('index.html')); if (hit) return coi(hit); throw err; }
  })());
});
