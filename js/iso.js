// Worker chạy 1 model rồi bị huỷ → bộ nhớ WASM của model được trả lại hệ điều hành (heap WASM không tự co lại).
// Dùng trên iPhone/máy ít RAM: text encoder → unet → vae lần lượt, mỗi cái một worker.
self.onmessage = async ({ data: q }) => {
  try {
    if (q.lite) self.__lite = true;
    if (q.kind === 'translate') { const T = await import('./translate.js'); self.postMessage({ ok: true, out: await T.translate(q.text) }); return; }
    const S = await import('./store.js'); const ort = await S.getOrt();
    const s = await S.session(q.group, q.id, (d, t) => self.postMessage({ prog: [d, t] }));
    const feeds = {}; q.inputs.forEach((x, i) => feeds[s.inputNames[i]] = new ort.Tensor(x.type, x.data, x.dims));
    const r = await s.run(feeds); const o = r[s.outputNames[0]];
    const data = o.data.slice(); self.postMessage({ ok: true, out: { type: o.type, data, dims: o.dims } }, [data.buffer]);
  } catch (e) { self.postMessage({ ok: false, err: String(e?.message || e), name: e?.name }); }
};
