// Studio AI — giao diện. Mọi xử lý chạy trên máy (WebGPU → WASM), model tải từ GitHub Pages rồi lưu offline.
import * as S from './store.js';
import * as F from './face.js';
import * as G from './t2i.js';
import { loadImage, canvas, ctx2d } from './img.js';
import { findEmap } from './onnxscan.js';
import { parseCommand, SWAP_CHIPS, STYLE_CHIPS } from './cmd.js';
import { translate, hasVietnamese } from './translate.js';
import { checkPrompt, NSFW_BLOCK, CONSENT } from './safety.js';

const $ = (s) => document.querySelector(s); const $$ = (s) => [...document.querySelectorAll(s)];
const MB = (b) => b >= 1e9 ? (b / 1e9).toFixed(2).replace('.', ',') + ' GB' : Math.round(b / 1e6) + ' MB';
const st = { tab: 'swap', src: {}, dst: {}, init: {}, view: null, hist: [], brush: 0, auto: false, busy: false, style: null };
let REG;

// ---------- trạng thái ----------
function status(text, frac, err) {
  const el = $('#status'); el.hidden = !text; el.classList.toggle('err', !!err); $('#statusText').textContent = text || '';
  if (frac != null) $('#bar').style.width = Math.round(frac * 100) + '%';
}
const fail = (e) => { console.warn(e); status('⚠️ ' + (e?.message || e), null, true); };
function ask(msg) { return st.auto ? true : confirm(msg); }

// ---------- tải model khi cần ----------
async function missing(groups) {
  const out = []; for (const [g, ids] of groups) for (const id of ids) if (!(await S.isCached(g, [id]))) out.push([g, id, REG[g][id].bytes]);
  return out;
}
async function ensure(groups, what) {
  const miss = await missing(groups); if (!miss.length) return true;
  const total = miss.reduce((s, m) => s + m[2], 0);
  if (!ask(`${what} cần tải ${MB(total)} model (chỉ lần đầu, sau đó dùng offline).\n\n${miss.map(m => '• ' + (REG[m[0]][m[1]].label || m[1]) + ' — ' + MB(m[2])).join('\n')}\n\nTiếp tục?`)) { status('Đã huỷ tải model.'); return false; }
  let done = 0;
  for (const [g, id, b] of miss) {
    await S.download(g, [id], (d) => status(`Đang tải model ${REG[g][id].label || id}… ${MB(done + d)} / ${MB(total)}`, (done + d) / total));
    done += b;
  }
  refreshModels(); return true;
}
const refOf = (v) => { if (!v || v === 'none') return null; const [src, ...r] = v.split(':'); return { src, id: r.join(':') }; };
function swapGroups(sw, rs) {
  const g = [['face', F.FACE_MODELS]];
  if (sw?.src === 'reg') { g.push(['swap', [sw.id]]); const n = REG.swap[sw.id].needs; if (n) g.push(['conv', n]); }
  else if (sw) { const p = S.customList().find(x => x.id === sw.id)?.profile; const m = /conv(?:raw)?:(.+)/.exec(p?.emb || ''); if (m) g.push(['conv', [m[1]]]); }
  if (rs?.src === 'reg') g.push(['restore', [rs.id]]);
  return g;
}

// ---------- ảnh vào ----------
async function setSlot(slot, key, file) {
  const img = await loadImage(file); st[key] = { img, faces: null, sel: null };
  const el = $(slot); const im = el.querySelector('img'); im.src = img.toDataURL('image/jpeg', 0.85); im.hidden = false; el.querySelector('.ph').hidden = true;
  if (key !== 'init') await detectFaces(key);
}
async function detectFaces(key) {
  const s = st[key]; const box = $(key === 'src' ? '#facesSrc' : '#facesDst'); box.innerHTML = '';
  if (!(await S.isCached('face', ['det']))) { box.innerHTML = '<span class="cap">Mặt sẽ được nhận diện khi bấm Chạy.</span>'; return; }
  s.faces = await F.detect(s.img); s.sel = 0; drawFaces(key);
}
function drawFaces(key) {
  const s = st[key]; const box = $(key === 'src' ? '#facesSrc' : '#facesDst'); box.innerHTML = '';
  if (!s.faces) return;
  const cap = document.createElement('span'); cap.className = 'cap';
  cap.textContent = s.faces.length ? `${key === 'src' ? 'Ảnh nguồn' : 'Ảnh đích'}: ${s.faces.length} mặt — chạm để chọn` : 'Không thấy khuôn mặt nào'; box.append(cap);
  s.faces.forEach((f, i) => { const c = F.faceThumb(s.img, f); if (i === s.sel) c.classList.add('on'); c.title = 'Mặt ' + (i + 1); c.onclick = () => { s.sel = i; drawFaces(key); }; box.append(c); });
}

// ---------- GHÉP MẶT (lõi, dùng cho cả UI và bot API) ----------
async function coreSwap({ srcImg, dstImg, cmd = '', ui = {}, srcSel, dstSel }) {
  const c = parseCommand(cmd);
  const sw = c.swapper ? { src: 'reg', id: c.swapper } : (ui.swapper || { src: 'reg', id: 'inswapper_128' });
  let rs = c.restorer ? { src: 'reg', id: c.restorer } : (ui.restorer === undefined ? { src: 'reg', id: 'gfpgan_1.4' } : ui.restorer);
  if (c.restore === false) rs = null; else if (c.restore === true && !rs) rs = { src: 'reg', id: 'gfpgan_1.4' };
  if (!(await ensure(swapGroups(sw, rs), 'Ghép mặt'))) throw new Error('Chưa có model.');
  status('Nhận diện khuôn mặt…', 0.1);
  const sf = await F.detect(srcImg), df = await F.detect(dstImg);
  if (!sf.length) throw new Error('Không thấy khuôn mặt trong ảnh nguồn.');
  if (!df.length) throw new Error('Không thấy khuôn mặt trong ảnh đích.');
  const sFace = c.srcFace ? F.pickFace(sf, c.srcFace) : sf[srcSel ?? 0] || sf[0];
  const targets = c.all ? df : [c.dstFace != null ? F.pickFace(df, c.dstFace) : df[dstSel ?? 0] || df[0]];
  const opts = { swapper: sw, restorer: rs, restore: !!rs, lock: c.lock ?? ui.lock ?? true, keepMouth: c.keepMouth ?? ui.keepMouth ?? false, colorMatch: c.colorMatch ?? ui.colorMatch ?? true, restoreAmt: c.restoreAmt ?? ui.restoreAmt ?? 0.8,
    onStep: (m, p) => status(m, 0.1 + p * 0.85), onProgress: (d, t) => status(`Đang tải model… ${MB(d)} / ${MB(t)}`, d / t) };
  let cur = dstImg, job = null, diffs = [];
  for (const [k, t] of targets.entries()) {
    if (targets.length > 1) status(`Mặt ${k + 1}/${targets.length}…`);
    job = await F.swap(srcImg, sFace, cur, t, opts); diffs.push(F.diffOutsideMask(job).outside); cur = job.result;
  }
  return { job, cmd: c, diffs, faces: { src: sf.length, dst: df.length }, upscale: c.upscale };
}
function finalOf(r) {
  let out = r.job.result;
  if (r.upscale) out = F.upscaleTo(out, r.upscale <= 4 ? Math.max(out.width, out.height) * r.upscale : r.upscale);
  return out;
}
async function runSwap() {
  if (!st.src.img || !st.dst.img) return status('Hãy chọn đủ ảnh nguồn và ảnh đích.', null, true);
  if (!$('#consent').checked) return status('Hãy xác nhận bạn có quyền dùng các ảnh này.', null, true);
  const ui = { swapper: refOf($('#selSwap').value), restorer: refOf($('#selRestore').value), lock: $('#optLock').checked, keepMouth: $('#optMouth').checked, colorMatch: $('#optColor').checked, restoreAmt: $('#restoreAmt').value / 100 };
  await busy(async () => {
    const r = await coreSwap({ srcImg: st.src.img, dstImg: st.dst.img, cmd: $('#swapCmd').value, ui, srcSel: st.src.sel, dstSel: st.dst.sel });
    if (!st.src.faces) { st.src.faces = await F.detect(st.src.img); st.src.sel = 0; drawFaces('src'); }
    if (!st.dst.faces) { st.dst.faces = await F.detect(st.dst.img); st.dst.sel = 0; drawFaces('dst'); }
    const t = r.job.times; const meta = `${r.job.profile.label || ''} · ${t.total} ms · ngoài mặt nạ: ${r.diffs.join('/')} px khác`;
    show(finalOf(r), st.dst.img, meta, r.upscale ? null : r.job); addHist();
    status(`Xong (${(t.total / 1000).toFixed(1)} s, ${S.backendLabel()}).`, 1);
  });
}

// ---------- TẠO ẢNH (lõi) ----------
async function coreGen({ prompt, tier = 'fast', seed, steps, size = 512, init = null, strength = 0.55, style = null }) {
  const sup = G.tierSupported(tier); if (!sup.ok) throw new Error(sup.why);
  const T = G.TIERS[tier]; const groups = [[T.group, init ? T.ids : T.ids.slice(0, 3)]];
  if (hasVietnamese(prompt) && !(await S.isCached('mt', ['encoder', 'decoder']))) groups.push(['mt', ['encoder', 'decoder']]);
  if (!(await S.isCached('face', ['nsfw']))) groups.push(['face', ['nsfw']]);
  if (!(await ensure(groups, T.label))) throw new Error('Chưa có model.');
  status('Dịch prompt…', 0.05);
  const tr = await translate(prompt);
  const en = [tr.text.replace(/[.。!?\s]+$/, ''), style && STYLE_CHIPS[style]].filter(Boolean).join(', ');
  const out = await G.generate({ tier, prompt: en, seed, steps, size, init, strength, onStep: (m, p) => status(m, 0.1 + p * 0.85), onProgress: (d, t) => status(`Đang tải model… ${MB(d)} / ${MB(t)}`, d / t) });
  out.meta.en = en; out.meta.how = tr.how; return out;
}
async function runGen() {
  const i2i = st.tab === 'i2i'; if (i2i && !st.init.img) return status('Hãy chọn ảnh gốc.', null, true);
  const prompt = $('#genPrompt').value.trim(); if (!prompt) return status('Hãy nhập prompt.', null, true);
  const tier = $('input[name=tier]:checked').value; const sv = $('#seed').value;
  await busy(async () => {
    const out = await coreGen({ prompt, tier, seed: sv === '' ? undefined : +sv, steps: +$('#steps').value, size: +$('#size').value, init: i2i ? st.init.img : null, strength: $('#strength').value / 100, style: st.style });
    $('#trEcho').textContent = out.meta.how === 'none' ? '' : `Dịch (${out.meta.how === 'opus' ? 'opus-mt' : 'từ điển'}): ${out.meta.en}`;
    let before = null; if (i2i) { before = canvas(out.width, out.height); const s = Math.min(st.init.img.width, st.init.img.height); ctx2d(before).drawImage(st.init.img, (st.init.img.width - s) / 2, (st.init.img.height - s) / 2, s, s, 0, 0, out.width, out.height); }
    const m = out.meta; show(out, before, `${G.TIERS[m.tier].label} · seed ${m.seed} · ${m.steps} bước · ${m.size}px · ${m.times.total ?? ''} ms`, null); addHist();
    status(`Xong (seed ${m.seed}).`, 1);
  });
}
async function busy(f) {
  if (st.busy) return; st.busy = true; $$('.run').forEach(b => b.disabled = true);
  try { await f(); } catch (e) { fail(e); } finally { st.busy = false; $$('.run').forEach(b => b.disabled = false); }
}

// ---------- khung kết quả ----------
function show(after, before, meta, job) {
  st.view = { after, before, meta, job };
  $('#vEmpty').hidden = true; $('#stage').hidden = false;
  const A = $('#vAfter'); A.width = after.width; A.height = after.height; ctx2d(A).drawImage(after, 0, 0);
  const B = $('#vBefore'); $('#beforeWrap').hidden = !before; $('#handle').hidden = !before; $('#cmpL').hidden = !before;
  if (before) { B.width = after.width; B.height = after.height; ctx2d(B).drawImage(before, 0, 0, after.width, after.height); }
  $('#vMeta').textContent = meta || ''; $('#dlOne').disabled = false; setCmp(); drawMask();
}
function setCmp() { const v = $('#cmp').value; $('#beforeWrap').style.clipPath = `inset(0 ${100 - v}% 0 0)`; $('#handle').style.left = v + '%'; }
function drawMask() {
  const M = $('#vMask'); const j = st.view?.job; const on = $('#showMask').checked && j && j.B;
  M.hidden = !on; if (!on) return; M.width = j.result.width; M.height = j.result.height;
  const g = ctx2d(M); const { x, y, w, h } = j.region; const im = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) if (j.B[i]) { im.data[i * 4] = 155; im.data[i * 4 + 1] = 107; im.data[i * 4 + 2] = 255; im.data[i * 4 + 3] = 200; }
  g.putImageData(im, x, y);
}
let brushRaf = 0;
function brushAt(e) {
  const j = st.view?.job; if (!st.brush || !j) return; const A = $('#vAfter'); const r = A.getBoundingClientRect();
  const k = A.width / r.width; const px = (e.clientX - r.left) * k, py = (e.clientY - r.top) * k;
  F.brush(j, px, py, +$('#brushSize').value * k, st.brush);
  if (!brushRaf) brushRaf = requestAnimationFrame(() => { brushRaf = 0; F.compose(j); ctx2d(A).drawImage(j.result, 0, 0); st.view.after = j.result; drawMask(); const d = F.diffOutsideMask(j); $('#vMeta').textContent = st.view.meta.replace(/ngoài mặt nạ: [\d/]+/, 'ngoài mặt nạ: ' + d.outside); });
}
function addHist() {
  const v = st.view; const t = canvas(Math.round(v.after.width * 72 / v.after.height), 72); ctx2d(t).drawImage(v.after, 0, 0, t.width, t.height);
  const full = canvas(v.after.width, v.after.height); ctx2d(full).drawImage(v.after, 0, 0);
  const item = { ...v, after: full, thumb: t.toDataURL('image/jpeg', 0.8) }; st.hist.unshift(item); drawHist(item);
}
function drawHist(cur) {
  const s = $('#strip'); s.innerHTML = '';
  for (const it of st.hist) { const im = new Image(); im.src = it.thumb; if (it === cur) im.className = 'on'; im.onclick = () => { show(it.after, it.before, it.meta, it.job); drawHist(it); }; s.append(im); }
}
async function save(c, name) {
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const file = new File([blob], name, { type: 'image/png' });
  if (S.lowMem && navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file] }); return; } catch {} }
  const a = $('#dlA'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------- danh sách model ----------
function optLabel(m, cached) { return `${m.label} · ${MB(m.bytes)}${cached ? ' ✓' : ''}`; }
async function refreshModels() {
  const fill = async (sel, group, kind, extra) => {
    const el = $(sel); const keep = el.value; el.innerHTML = extra || '';
    const og = document.createElement('optgroup'); og.label = 'Có sẵn (tải khi cần)';
    for (const [id, m] of Object.entries(REG[group])) og.append(new Option(optLabel(m, await S.isCached(group, [id])), 'reg:' + id));
    el.append(og);
    const cu = S.customList().filter(x => x.profile?.kind === kind);
    if (cu.length) { const o2 = document.createElement('optgroup'); o2.label = 'Model của bạn'; for (const m of cu) o2.append(new Option(`${m.name} · ${MB(m.size)}`, 'custom:' + m.id)); el.append(o2); }
    el.value = [...el.options].some(o => o.value === keep) ? keep : el.options[extra ? 1 : 0].value;
  };
  await fill('#selSwap', 'swap', 'swap'); await fill('#selRestore', 'restore', 'restore', '<option value="none">Không làm nét</option>');
  modelInfo(); renderModelPane();
}
function modelInfo() {
  const a = refOf($('#selSwap').value), b = refOf($('#selRestore').value); const lines = [];
  for (const [r, g] of [[a, 'swap'], [b, 'restore']]) {
    if (!r) continue; if (r.src === 'reg') { const m = REG[g][r.id]; lines.push(`<b>${m.label}</b>: ${m.note || ''} <span class="lic">Giấy phép: ${m.license}</span>`); }
    else { const m = S.customList().find(x => x.id === r.id); if (m) lines.push(`<b>${m.name}</b>: model của bạn (${m.profile?.label || ''}).`); }
  }
  $('#modelInfo').innerHTML = lines.join('<br>');
}
const BUNDLES = () => [
  { name: 'Lõi ghép mặt (nhận diện, ArcFace, BiSeNet, lọc an toàn)', g: [['face', F.FACE_MODELS]], lic: 'InsightFace (phi thương mại) · BiSeNet MIT · open_nsfw BSD-2' },
  ...Object.entries(REG.swap).map(([id, m]) => ({ name: 'Ghép: ' + m.label, g: [['swap', [id]], ...(m.needs ? [['conv', m.needs]] : [])], lic: m.license })),
  ...Object.entries(REG.restore).map(([id, m]) => ({ name: 'Làm nét: ' + m.label, g: [['restore', [id]]], lic: m.license })),
  { name: 'Tạo ảnh — Nhanh (SDXS-512, có img2img)', g: [['t2i', G.TIERS.fast.ids]], lic: G.TIERS.fast.license },
  { name: 'Tạo ảnh — Chất lượng cao (SD-Turbo, cần WebGPU)', g: [['hq', G.TIERS.hq.ids]], lic: G.TIERS.hq.license },
  { name: 'Dịch Việt → Anh (opus-mt-vi-en)', g: [['mt', ['encoder', 'decoder']]], lic: REG.mt.encoder.license },
];
async function renderModelPane() {
  const u = await S.usage(); $('#usage').textContent = u ? `Bộ nhớ đã dùng: ${MB(u.usage || 0)} / ${MB(u.quota || 0)} · Chạy bằng: ${S.backendLabel()}` : '';
  const rl = $('#regList'); rl.innerHTML = '';
  for (const b of BUNDLES()) {
    let bytes = 0, ok = true; for (const [g, ids] of b.g) for (const id of ids) { bytes += REG[g][id].bytes; if (!(await S.isCached(g, [id]))) ok = false; }
    const d = document.createElement('div'); d.className = 'mitem';
    d.innerHTML = `<b>${b.name}</b> · ${MB(bytes)} ${ok ? '<span class="ok">✓ đã lưu offline</span>' : ''}<div class="lic">Giấy phép: ${b.lic}</div><div class="act"></div>`;
    const act = d.querySelector('.act');
    const bt = (t, f) => { const x = document.createElement('button'); x.className = 'ghost-btn sm'; x.type = 'button'; x.textContent = t; x.onclick = f; act.append(x); };
    if (!ok) bt('Tải về (' + MB(bytes) + ')', () => busy(async () => { await ensure(b.g, b.name); status('Đã tải xong.', 1); }));
    else bt('Xoá khỏi máy', async () => { for (const [g, ids] of b.g) await S.remove(g, ids); refreshModels(); });
    rl.append(d);
  }
  const cl = $('#customList'); cl.innerHTML = S.customList().length ? '' : '<p class="hint">Chưa có. Bấm “＋ Tải model của bạn”.</p>';
  for (const m of S.customList()) {
    const d = document.createElement('div'); d.className = 'mitem';
    d.innerHTML = `<b>${m.name}</b> · ${MB(m.size)} · ${m.profile ? (m.profile.kind === 'swap' ? 'ghép mặt' : 'làm nét') + ' — ' + m.profile.label : '<span class="lic">chưa rõ kiểu</span>'}<div class="act"></div>`;
    const x = document.createElement('button'); x.className = 'ghost-btn sm'; x.type = 'button'; x.textContent = 'Xoá'; x.onclick = async () => { await S.customRemove(m.id); refreshModels(); };
    d.querySelector('.act').append(x); cl.append(d);
  }
}

// ---------- tải model của người dùng ----------
const PRESET_OPTS = () => [...Object.entries(F.SWAP_PRESETS).map(([k, p]) => ['swap:' + k, 'Ghép mặt — ' + p.label]), ...Object.entries(F.RESTORE_PRESETS).map(([k, p]) => ['restore:' + k, 'Làm nét — ' + p.label])];
function presetProfile(v) { const [k, n] = v.split(':'); return k === 'swap' ? { kind: 'swap', ...F.SWAP_PRESETS[n] } : { kind: 'restore', ...F.RESTORE_PRESETS[n] }; }
/** files: [{name, data}] — 1 .onnx (+ .data). sidecar: object|null. Trả id. */
async function addCustom(files, sidecar, name, report = (h) => { $('#mResult').innerHTML = h; }) {
  const main = files.find(f => /\.onnx$/i.test(f.name)); if (!main) throw new Error('Không thấy file .onnx.');
  const rest = files.filter(f => f !== main && !/\.json$/i.test(f.name));
  report('Đang đọc model…');
  let prof = F.profileFromSidecar(sidecar);
  let emap = null; if (!prof || prof.emb === 'emap') { try { emap = findEmap(main.data); } catch {} }
  if (prof?.emap_url && !emap) { try { const b = await S.fetchBytes(prof.emap_url); emap = new Float32Array(b.buffer); } catch (e) { throw new Error('Không tải được emap_url: ' + e.message); } }
  const extraFiles = emap ? [{ name: '__emap.bin', data: new Uint8Array(emap.buffer, emap.byteOffset, emap.byteLength) }] : [];
  const id = await S.customAdd({ name: name || sidecar?.name || main.name.replace(/\.onnx$/i, ''), source: main.source || 'file' }, [main, ...rest, ...extraFiles]);
  let sess; try { sess = await S.customSession(id); } catch (e) { await S.customRemove(id); throw new Error('Không mở được model này: ' + (e.message || e)); }
  const io = F.describeIO(sess);
  if (!prof) { const d = F.detectProfile(sess, !!emap); if (d) prof = d.profile; }
  if (prof?.emb === 'emap' && !emap) prof.emb = 'norm';
  S.customUpdate(id, { io, profile: prof || null });
  const ioHtml = `<pre>Vào: ${io.inputs}\nRa: ${io.outputs}</pre>`;
  if (prof) { report(`✓ Đã thêm <b>${S.customList().find(x => x.id === id).name}</b> — nhận ra: ${prof.kind === 'swap' ? 'ghép mặt' : 'làm nét'} (${prof.label}).${ioHtml}`); }
  else {
    report(`Chưa nhận ra kiểu model. Hãy chọn kiểu phù hợp:${ioHtml}<select id="mPreset">${PRESET_OPTS().map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select><button type="button" class="ghost-btn" id="mPresetOk">Lưu kiểu này</button>`);
    $('#mPresetOk').onclick = () => { S.customUpdate(id, { profile: presetProfile($('#mPreset').value) }); report('✓ Đã lưu kiểu model.'); refreshModels(); };
  }
  await refreshModels();
  if (prof) { const sel = prof.kind === 'swap' ? '#selSwap' : '#selRestore'; $(sel).value = 'custom:' + id; modelInfo(); }
  return id;
}
const readFile = async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()), path: f.webkitRelativePath || f.name });
async function addFromFileList(list) {
  const fs = [...list]; const jsons = fs.filter(f => /\.json$/i.test(f.name)); const onnx = fs.filter(f => /\.onnx$/i.test(f.name));
  if (!onnx.length) throw new Error('Không có file .onnx nào.');
  const dirOf = (f) => (f.webkitRelativePath || f.name).split('/').slice(0, -1).join('/');
  for (const o of onnx) {
    const base = o.name.replace(/\.onnx$/i, ''); const dir = dirOf(o);
    const js = jsons.find(j => j.name === base + '.json' && dirOf(j) === dir) || jsons.find(j => j.name === 'model.json' && dirOf(j) === dir) || (onnx.length === 1 ? jsons[0] : null);
    let side = null; if (js) { try { side = JSON.parse(await js.text()); } catch { throw new Error(js.name + ' không phải JSON hợp lệ.'); } }
    const datas = fs.filter(f => /\.(data|bin)$/i.test(f.name) && dirOf(f) === dir && (onnx.length === 1 || f.name.startsWith(base)));
    status(`Đang thêm ${o.name}…`);
    await addCustom([await readFile(o), ...(await Promise.all(datas.map(readFile)))], side, onnx.length === 1 ? $('#mName').value.trim() : '');
  }
  status('Đã thêm model.', 1);
}
async function addFromUrl(url, jurl) {
  url = url.trim().replace(/huggingface\.co\/([^/]+\/[^/]+)\/blob\//, 'huggingface.co/$1/resolve/');
  if (!/^https?:\/\//.test(url)) throw new Error('Link không hợp lệ.');
  let data, side = null;
  try { data = await S.fetchBytes(url, (() => { let g = 0; return (n) => { g += n; status(`Đang tải từ link… ${MB(g)}`); }; })()); }
  catch (e) { throw new Error(e instanceof TypeError ? 'Không tải được: máy chủ chặn truy cập (CORS) hoặc mất mạng. Hãy tải file về máy rồi dùng mục “File .onnx”.' : e.message); }
  if (jurl) { try { side = JSON.parse(new TextDecoder().decode(await S.fetchBytes(jurl.trim()))); } catch { throw new Error('Không đọc được model.json từ link.'); } }
  const name = decodeURIComponent(url.split('?')[0].split('/').pop() || 'model.onnx');
  await addCustom([{ name: /\.onnx$/i.test(name) ? name : name + '.onnx', data, source: url }], side, $('#mName').value.trim());
  status('Đã thêm model.', 1);
}

// ---------- khởi động ----------
function chips(box, list, onClick) { const b = $(box); for (const t of list) { const c = document.createElement('button'); c.type = 'button'; c.className = 'chip'; c.textContent = t; c.onclick = () => onClick(t, c); b.append(c); } }
function setTab(t) {
  st.tab = t; $$('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $('#pane-swap').hidden = t !== 'swap'; $('#pane-gen').hidden = !(t === 't2i' || t === 'i2i'); $('#pane-models').hidden = t !== 'models';
  $('#slotInit').hidden = t !== 'i2i'; $('#strengthL').hidden = t !== 'i2i';
  if (t === 'models') renderModelPane();
  tierUI();
}
async function tierUI() {
  const tier = $('input[name=tier]:checked').value; const s = G.tierSupported(tier); const w = $('#tierWarn');
  w.hidden = !(s.why || s.warn); w.textContent = s.why || s.warn || ''; $('#stepsL').hidden = tier !== 'hq';
  const fb = await G.tierBytes('fast'), hb = await G.tierBytes('hq');
  $('#tierFast').textContent = `SDXS-512 · 1 bước · ${MB(fb)} · chạy cả iPhone`; $('#tierHq').textContent = `SD-Turbo · 1–8 bước · ${MB(hb)} · cần WebGPU`;
}
async function init() {
  const qs = new URLSearchParams(location.search); st.auto = qs.get('auto') === '1';
  if (document.referrer && !/\/studio\//.test(document.referrer) && !qs.get('from')) $('#back').href = '../studio/';
  REG = await S.registry();
  $('#consentNote').textContent = CONSENT;
  chips('#swapChips', SWAP_CHIPS, (t) => { const a = $('#swapCmd'); a.value = (a.value.trim() ? a.value.trim().replace(/[,.]$/, '') + ', ' : '') + t.toLowerCase(); echoCmd(); });
  chips('#styleChips', Object.keys(STYLE_CHIPS), (t, c) => { st.style = st.style === t ? null : t; $$('#styleChips .chip').forEach(x => x.classList.toggle('on', x.textContent === st.style)); });
  const echoCmd = () => { const n = parseCommand($('#swapCmd').value).notes; $('#cmdEcho').textContent = n.length ? 'Hiểu là: ' + n.join(' · ') : ''; };
  $('#swapCmd').oninput = echoCmd;
  $$('.tab').forEach(b => b.onclick = () => setTab(b.dataset.tab));
  for (const [sel, key] of [['#slotSrc', 'src'], ['#slotDst', 'dst'], ['#slotInit', 'init']]) $(sel + ' input').onchange = (e) => e.target.files[0] && setSlot(sel, key, e.target.files[0]).catch(fail);
  $('#runSwap').onclick = runSwap; $('#runGen').onclick = runGen;
  $('#restoreAmt').oninput = (e) => $('#restoreAmtV').textContent = e.target.value + '%';
  $('#steps').oninput = (e) => $('#stepsV').textContent = e.target.value; $('#strength').oninput = (e) => $('#strengthV').textContent = e.target.value + '%';
  $('#dice').onclick = () => { $('#seed').value = Math.floor(Math.random() * 2 ** 31); };
  $$('input[name=tier]').forEach(r => r.onchange = tierUI);
  $('#cmp').oninput = setCmp; $('#showMask').onchange = drawMask;
  $$('[data-brush]').forEach(b => b.onclick = () => { st.brush = +b.dataset.brush; $$('[data-brush]').forEach(x => x.classList.toggle('on', x === b && st.brush !== 0)); $('#stage').classList.toggle('brushing', !!st.brush); if (st.brush) { $('#showMask').checked = true; drawMask(); } });
  $('#brushReset').onclick = () => { const j = st.view?.job; if (!j) return; j.edits.fill(0); F.compose(j); show(j.result, st.view.before, st.view.meta, j); };
  const stg = $('#stage'); let down = false;
  stg.onpointerdown = (e) => { if (!st.brush) return; down = true; stg.setPointerCapture(e.pointerId); brushAt(e); };
  stg.onpointermove = (e) => { if (down) brushAt(e); }; stg.onpointerup = stg.onpointercancel = () => { down = false; };
  $('#dlOne').onclick = () => st.view && save(st.view.after, `studio-ai-${Date.now()}.png`);
  $('#histClr').onclick = () => { st.hist = []; drawHist(); };
  $('#histDl').onclick = async () => { for (const [i, h] of [...st.hist].reverse().entries()) { await save(h.after, `studio-ai-${i + 1}.png`); await new Promise(r => setTimeout(r, 400)); } };
  $('#selSwap').onchange = modelInfo; $('#selRestore').onchange = modelInfo;
  // hộp thoại tải model
  const dlg = $('#dlgModel'); const open = () => { $('#mResult').innerHTML = ''; dlg.showModal(); };
  $('#btnAddModel').onclick = open; $('#btnAddModel2').onclick = open;
  $$('.dlg .segs .seg').forEach(b => b.onclick = () => { $$('.dlg .segs .seg').forEach(x => x.classList.toggle('on', x === b)); $$('[data-pane]').forEach(p => p.hidden = p.dataset.pane !== b.dataset.src); });
  const wrap = (f) => async (...a) => { try { await f(...a); } catch (e) { $('#mResult').innerHTML = '<span style="color:var(--bad)">⚠️ ' + (e.message || e) + '</span>'; status(''); } };
  $('#mFile').onchange = wrap((e) => addFromFileList(e.target.files));
  $('#mDir').onchange = wrap((e) => addFromFileList(e.target.files));
  $('#mDirBtn').onclick = wrap(async () => {
    if (window.showDirectoryPicker) {
      const root = await window.showDirectoryPicker(); const files = [];
      const walk = async (h, p) => { for await (const [n, x] of h.entries()) { if (x.kind === 'directory') await walk(x, p + n + '/'); else if (/\.(onnx|json|data|bin)$/i.test(n)) { const f = await x.getFile(); Object.defineProperty(f, 'webkitRelativePath', { value: p + n }); files.push(f); } } };
      await walk(root, root.name + '/'); return addFromFileList(files);
    }
    $('#mDir').click();
  });
  $('#mUrlGo').onclick = wrap(() => addFromUrl($('#mUrl').value, $('#mUrlJson').value));
  await refreshModels(); tierUI();
  S.getOrt().then(() => { $('#backend').textContent = S.backendLabel(); });
  const tab = qs.get('tab'); if (tab) setTab(tab);
  const { install } = await import('./api.js');
  install({ coreSwap, coreGen, finalOf, loadImage, show, addHist, status, setTab, st, addCustom, refreshModels, REG });
}
init().catch(fail);
