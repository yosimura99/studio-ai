// Đọc nhanh protobuf ONNX (không cần thư viện) để lấy initializer, ví dụ ma trận emap 512x512 của inswapper.
function varint(b, p) { let x = 0, s = 1, c; do { c = b[p.i++]; x += (c & 127) * s; s *= 128; } while (c & 128); return x; }
function fields(b, start, end, cb) {
  const p = { i: start };
  while (p.i < end) {
    const key = varint(b, p); const f = Math.floor(key / 8), wt = key & 7;
    if (wt === 0) { const v = varint(b, p); cb(f, wt, v, 0); }
    else if (wt === 2) { const n = varint(b, p); const s = p.i; p.i += n; cb(f, wt, s, n); }
    else if (wt === 1) { p.i += 8; } else if (wt === 5) { p.i += 4; } else throw new Error('protobuf lạ');
  }
}
/** Trả về các initializer dạng {name, dims, type, raw:[off,len]} (không đọc dữ liệu lớn). */
export function initializers(b) {
  const out = [];
  fields(b, 0, b.length, (f, wt, s, n) => {
    if (f !== 7 || wt !== 2) return;
    fields(b, s, s + n, (gf, gwt, gs, gn) => {
      if (gf !== 5 || gwt !== 2) return;
      const t = { dims: [], type: 0, name: '', raw: null };
      fields(b, gs, gs + gn, (tf, twt, v, l) => {
        if (tf === 1) { if (twt === 0) t.dims.push(v); else { const p = { i: v }; while (p.i < v + l) t.dims.push(varint(b, p)); } }
        else if (tf === 2) t.type = v;
        else if (tf === 8) t.name = new TextDecoder().decode(b.subarray(v, v + l));
        else if (tf === 9 && twt === 2) t.raw = [v, l];
        else if (tf === 4 && twt === 2) t.floats = [v, l];
      });
      out.push(t);
    });
  });
  return out;
}
export function findEmap(b) {
  const ins = initializers(b).filter(t => t.dims.length === 2 && t.dims[0] === 512 && t.dims[1] === 512 && t.type === 1 && (t.raw || t.floats));
  if (!ins.length) return null;
  const t = ins[ins.length - 1]; const [o, l] = t.raw || t.floats;
  return new Float32Array(b.slice(o, o + l).buffer);
}
