// API cho bot / tự động hoá:
//   window.studioAI.run({prompt, source, target, swapper, restorer}) → dataURL PNG
//   window.studioAI.generate({prompt, tier, seed, steps, size, init, strength, style}) → dataURL PNG
//   URL: ?cmd=<lệnh>&src=<url ảnh nguồn>&dst=<url ảnh đích>&auto=1   |   ?mode=t2i&prompt=…&auto=1
// Ảnh vào: dataURL, URL cùng origin/CORS, Blob/File, <img>, <canvas>.
export function install(A) {
  const toImg = async (x) => {
    if (!x) throw new Error('Thiếu ảnh');
    if (x instanceof HTMLImageElement) { const c = document.createElement('canvas'); c.width = x.naturalWidth; c.height = x.naturalHeight; c.getContext('2d').drawImage(x, 0, 0); return c; }
    return A.loadImage(x);
  };
  // Khoá PIN: API chỉ chạy khi ứng dụng đã mở khoá.
  const unlocked = () => new Promise(r => window.StudioLock ? window.StudioLock.onUnlock(r) : r());
  const ref = (v, g) => v == null ? undefined : v === false || v === 'none' ? null : typeof v === 'string' ? { src: v.startsWith('custom:') ? 'custom' : 'reg', id: v.replace(/^(custom|reg):/, '') } : v;
  const api = {
    version: '1.0',
    ready: true,
    async run({ prompt = '', cmd, source, target, swapper, restorer, lock, keepMouth, colorMatch, restoreAmt, show = true } = {}) {
      await unlocked(); A.st.auto = true;
      const [s, d] = await Promise.all([toImg(source), toImg(target)]);
      const r = await A.coreSwap({ srcImg: s, dstImg: d, cmd: cmd ?? prompt, ui: { swapper: ref(swapper), restorer: ref(restorer), lock, keepMouth, colorMatch, restoreAmt } });
      const out = A.finalOf(r);
      if (show) { A.show(out, d, `bot · ngoài mặt nạ: ${r.diffs.join('/')} px khác`, r.upscale ? null : r.job); A.addHist(); A.status('Xong.', 1); }
      api.last = { diffOutside: r.diffs, times: r.job.times, model: r.job.profile.label, faces: r.faces };
      return out.toDataURL('image/png');
    },
    async generate({ prompt, tier = 'fast', seed, steps, size = 512, init, strength, style, show = true } = {}) {
      await unlocked(); A.st.auto = true;
      const im = init ? await toImg(init) : null;
      const out = await A.coreGen({ prompt, tier, seed, steps, size, init: im, strength, style });
      if (show) { A.show(out, null, `bot · seed ${out.meta.seed}`, null); A.addHist(); A.status('Xong.', 1); }
      api.last = out.meta; return out.toDataURL('image/png');
    },
    models: () => ({ swap: Object.keys(A.REG.swap), restore: Object.keys(A.REG.restore) }),
  };
  window.studioAI = api;
  const qs = new URLSearchParams(location.search);
  if (qs.get('auto') === '1') {
    (async () => {
      const mode = qs.get('mode') || (qs.get('src') ? 'swap' : qs.get('prompt') ? 't2i' : 'swap');
      try {
        let url;
        if (mode === 'swap') { A.setTab('swap'); url = await api.run({ cmd: qs.get('cmd') || '', source: qs.get('src'), target: qs.get('dst'), swapper: qs.get('model') || undefined }); }
        else { A.setTab(mode); url = await api.generate({ prompt: qs.get('prompt') || qs.get('cmd'), tier: qs.get('tier') || 'fast', seed: qs.get('seed') ? +qs.get('seed') : undefined, size: +(qs.get('size') || 512), init: qs.get('init') || undefined, strength: qs.get('strength') ? +qs.get('strength') : undefined }); }
        document.documentElement.dataset.result = 'ok'; window.studioAIResult = url;
        (window.opener || (window.parent !== window ? window.parent : null))?.postMessage({ type: 'studioAI:result', dataURL: url, meta: api.last }, location.origin);
      } catch (e) { document.documentElement.dataset.result = 'error'; window.studioAIError = e.message; A.status('⚠️ ' + e.message, null, true); }
    })();
  }
  window.dispatchEvent(new Event('studioAI:ready'));
}
