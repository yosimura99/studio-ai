// Dịch Việt → Anh offline bằng opus-mt-vi-en (Marian, ONNX lượng tử hoá ~100 MB) + từ điển dự phòng.
import * as S from './store.js';
// Từ riêng Việt Nam: opus-mt dịch sai (VD "phở" → "bots", "áo dài" → "dress pond") nên tách ra trước, dịch phần còn lại, rồi ghép tên tiếng Anh lên đầu prompt.
const KEEP = [['áo dài', 'ao dai, traditional Vietnamese long silk dress'], ['nón lá', 'Vietnamese conical hat'], ['phố cổ hội an', 'Hoi An ancient town'], ['hội an', 'Hoi An ancient town'], ['phố cổ hà nội', 'Hanoi old quarter'], ['hà nội', 'Hanoi'], ['sài gòn', 'Saigon'], ['tp hcm', 'Ho Chi Minh City'], ['vịnh hạ long', 'Ha Long Bay'], ['hạ long', 'Ha Long Bay'], ['phở bò', 'pho bo, Vietnamese beef noodle soup'], ['phở gà', 'pho ga, Vietnamese chicken noodle soup'], ['phở', 'pho, Vietnamese noodle soup'], ['bún chả', 'bun cha, grilled pork with rice noodles'], ['bún bò', 'bun bo Hue, spicy beef noodle soup'], ['bánh mì', 'banh mi, Vietnamese baguette sandwich'], ['cơm tấm', 'com tam, broken rice with grilled pork'], ['gỏi cuốn', 'fresh spring rolls'], ['cà phê sữa đá', 'Vietnamese iced milk coffee'], ['đà lạt', 'Da Lat'], ['huế', 'Hue'], ['sapa', 'Sapa'], ['ruộng bậc thang', 'rice terraces'], ['đông xe máy', 'crowded with motorbikes'], ['đông người', 'crowded with people'], ['đông đúc', 'crowded'], ['xe máy', 'motorbikes'], ['xích lô', 'cyclo rickshaw']];
// lượng từ đứng trước món ăn: "tô phở" → "a bowl of pho" (opus-mt dịch "tô" thành "coating")
const CLS = { 'tô': 'a bowl of', 'bát': 'a bowl of', 'chén': 'a bowl of', 'đĩa': 'a plate of', 'dĩa': 'a plate of', 'ổ': 'a', 'ly': 'a glass of', 'cốc': 'a glass of', 'tách': 'a cup of' };
const CLS_RE = Object.keys(CLS).join('|');
function pullKeep(text) { let pre = ' ' + text + ' '; const keep = [];
  for (const [k, v] of KEEP) { const re = new RegExp('(^|[^\\p{L}])(?:(' + CLS_RE + ')\\s+)?' + k + '(?=$|[^\\p{L}])', 'giu');
    pre = pre.replace(re, (_, b, c) => { const t = (c ? CLS[c.toLowerCase()] + ' ' : '') + v; if (!keep.includes(t)) keep.push(t); return b + ' '; }); }
  pre = pre.replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').trim(); if (/^(một|những|các|vài|nhiều)?[\s,.]*$/iu.test(pre)) pre = '';
  return { pre, keep }; }
const joinKeep = (keep, t) => [...keep, t].filter(x => x && x.replace(/[\s,.]/g, '')).join(', ');
const DICT = { 'một': 'a', 'con': '', 'cô gái': 'girl', 'chàng trai': 'young man', 'người': 'person', 'mèo': 'cat', 'chó': 'dog', 'cáo': 'fox', 'đỏ': 'red', 'xanh': 'blue', 'vàng': 'yellow', 'trắng': 'white', 'đen': 'black', 'rừng': 'forest', 'tuyết': 'snow', 'biển': 'sea', 'núi': 'mountain', 'hoàng hôn': 'sunset', 'bình minh': 'sunrise', 'đêm': 'night', 'mưa': 'rain', 'phố': 'street', 'hoa': 'flowers', 'sen': 'lotus', 'đèn lồng': 'lanterns', 'trong': 'in', 'bên': 'by', 'dưới': 'under', 'trên': 'on', 'với': 'with', 'và': 'and', 'đẹp': 'beautiful', 'chân dung': 'portrait', 'phong cảnh': 'landscape', 'thành phố': 'city', 'bầu trời': 'sky', 'sao': 'stars', 'trăng': 'moon', 'nắng': 'sunlight' };
export const hasVietnamese = (s) => /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(s);
let VOCAB = null, PIECES = null, MAXL = 0;
async function vocab() {
  if (VOCAB) return; const r = await fetch(S.APP_BASE + 'models/opus/vocab.json'); VOCAB = await r.json();
  PIECES = new Map(); VOCAB.forEach(([p, s], i) => { PIECES.set(p, [i, s]); if (p.length > MAXL) MAXL = p.length; });
}
function tokenize(text) {
  const ids = [];
  for (const w0 of text.split(/\s+/).filter(Boolean)) {
    const w = [...('▁' + w0)]; const n = w.length; const best = Array.from({ length: n + 1 }, () => [-1e18, null]); best[0] = [0, null];
    for (let i = 0; i < n; i++) {
      if (best[i][0] < -1e17) continue; let hit = false;
      for (let j = i + 1; j <= Math.min(n, i + MAXL); j++) { const q = PIECES.get(w.slice(i, j).join('')); if (q) { hit = true; const sc = best[i][0] + q[1]; if (sc > best[j][0]) best[j] = [sc, [i, q[0]]]; } }
      if (!hit && best[i + 1][0] < best[i][0] - 10) best[i + 1] = [best[i][0] - 10, [i, 1]];
    }
    const out = []; let j = n; while (j > 0) { const [i, id] = best[j][1]; out.push(id); j = i; } ids.push(...out.reverse());
  }
  ids.push(0); return ids;
}
function dictFallback(s) {
  let t = ' ' + s.toLowerCase() + ' ';
  for (const [k, v] of Object.entries(DICT).sort((a, b) => b[0].length - a[0].length)) t = t.split(k).join(' ' + v + ' ');
  return t.replace(/\s+/g, ' ').trim();
}
export async function mtReady() { return S.isCached('mt', ['encoder', 'decoder']); }
/** Dịch; trả {text, how:'opus'|'dict'|'none'} */
export async function translate(text, onP) {
  if (!hasVietnamese(text)) return { text, how: 'none' };
  if (S.isolate()) { try { return await S.inWorker({ kind: 'translate', text }); } catch (e) { console.warn('dịch trong worker lỗi', e); } }
  const { pre, keep } = pullKeep(text);
  if (!hasVietnamese(pre)) return { text: joinKeep(keep, pre), how: 'dict' };
  try {
    await vocab(); const ort = await S.getOrt();
    const enc = await S.session('mt', 'encoder', onP), dec = await S.session('mt', 'decoder', onP);
    const parts = pre.split(/(?<=[.;!?\n])\s*/).filter(x => x.trim()); const outs = [];
    for (const part of parts) {
      const ids = tokenize(part.trim()); const x = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]); const m = new ort.Tensor('int64', new BigInt64Array(ids.length).fill(1n), [1, ids.length]);
      const h = (await enc.run({ input_ids: x, attention_mask: m })).last_hidden_state;
      const out = [53738]; const empty = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 64]);
      for (let k = 0; k < Math.min(80, ids.length * 3 + 10); k++) {
        const f = { encoder_attention_mask: m, input_ids: new ort.Tensor('int64', BigInt64Array.from(out.map(BigInt)), [1, out.length]), encoder_hidden_states: h };
        for (const n of dec.inputNames) { if (n.startsWith('past')) f[n] = empty; if (n === 'use_cache_branch') f[n] = new ort.Tensor('bool', [false], [1]); }
        const r = await dec.run(f); const lg = r.logits; const V = lg.dims[2]; const off = (out.length - 1) * V; let bi = 0, bv = -1e30;
        for (let v = 0; v < V; v++) { if (v === 53738) continue; const q = lg.data[off + v]; if (q > bv) { bv = q; bi = v; } }
        if (bi === 0) break; out.push(bi);
      }
      outs.push(out.slice(1).map(i => VOCAB[i][0]).join('').replace(/▁/g, ' ').trim());
    }
    return { text: joinKeep(keep, outs.join(' ').replace(/\s+/g, ' ').trim()), how: 'opus' };
  } catch (e) { console.warn('opus-mt lỗi, dùng từ điển', e); return { text: joinKeep(keep, dictFallback(pre)), how: 'dict' }; }
  finally { if (S.lowMem) { await S.release('mt', 'encoder'); await S.release('mt', 'decoder'); } }
}
