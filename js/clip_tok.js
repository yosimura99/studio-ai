// Bộ tách từ CLIP BPE (giống CLIPTokenizer của transformers), chạy offline.
let TOK = null;
function bytesToUnicode() {
  const bs = []; for (let i = 33; i <= 126; i++) bs.push(i); for (let i = 161; i <= 172; i++) bs.push(i); for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = [...bs]; let n = 0; for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  const m = {}; bs.forEach((b, i) => m[b] = String.fromCharCode(cs[i])); return m;
}
export async function loadTok(base) {
  if (TOK) return TOK;
  const [vocab, merges] = await Promise.all([fetch(base + 'vocab.json').then(r => r.json()), fetch(base + 'merges.txt').then(r => r.text())]);
  const ranks = new Map(); merges.split('\n').slice(1).filter(l => l.trim()).forEach((l, i) => ranks.set(l, i));
  TOK = { vocab, ranks, b2u: bytesToUnicode(), cache: new Map() }; return TOK;
}
function bpe(T, token) {
  if (T.cache.has(token)) return T.cache.get(token);
  let word = [...token.slice(0, -1), token.slice(-1) + '</w>'];
  if (word.length === 1) return [token + '</w>'];
  for (;;) {
    let best = null, br = Infinity;
    for (let i = 0; i < word.length - 1; i++) { const r = T.ranks.get(word[i] + ' ' + word[i + 1]); if (r !== undefined && r < br) { br = r; best = i; } }
    if (best === null) break;
    const a = word[best], b = word[best + 1]; const nw = [];
    for (let i = 0; i < word.length;) { if (i < word.length - 1 && word[i] === a && word[i + 1] === b) { nw.push(a + b); i += 2; } else { nw.push(word[i]); i++; } }
    word = nw; if (word.length === 1) break;
  }
  T.cache.set(token, word); return word;
}
const PAT = /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/gu;
/** Trả về mảng 77 id: BOS ... EOS rồi đệm bằng pad. */
export function encode(T, text, pad = 49407, len = 77) {
  const clean = text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  const ids = [49406]; const enc = new TextEncoder();
  for (const m of clean.matchAll(PAT)) {
    const tok = [...enc.encode(m[0])].map(b => T.b2u[b]).join('');
    for (const p of bpe(T, tok)) { const id = T.vocab[p]; if (id !== undefined) ids.push(id); }
  }
  const out = ids.slice(0, len - 1); out.push(49407); while (out.length < len) out.push(pad); return out;
}
