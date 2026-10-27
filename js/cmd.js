// Hiểu lệnh tiếng Việt cho Ghép mặt + chip gợi ý.
const strip = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
const NUM = { mot: 1, nhat: 1, hai: 2, ba: 3, bon: 4, tu: 4, nam: 5 };
const num = (w) => /^\d+$/.test(w) ? +w : NUM[w];
export const SWAP_ALIASES = [
  [/hyper ?swap ?1?c|hyperswap c/, 'hyperswap_1c_256'], [/hyper ?swap ?1?b/, 'hyperswap_1b_256'], [/hyper ?swap/, 'hyperswap_1a_256'],
  [/sim ?swap ?512/, 'simswap_unofficial_512'], [/sim ?swap/, 'simswap_256'],
  [/ghost ?3/, 'ghost_3_256'], [/ghost ?2/, 'ghost_2_256'], [/ghost/, 'ghost_1_256'], [/uni ?face/, 'uniface_256'], [/inswapper|mac dinh/, 'inswapper_128'],
];
export const RESTORE_ALIASES = [[/code ?former/, 'codeformer'], [/gpen/, 'gpen_bfr_512'], [/restore ?former/, 'restoreformer_plus_plus'], [/gfpgan/, 'gfpgan_1.4']];
/** Trả về tuỳ chọn: {srcFace, dstFace, all, lock, keepMouth, restore, restoreAmt, restorer, swapper, colorMatch, upscale, notes[]} */
export function parseCommand(text) {
  const t = ' ' + strip(text || '') + ' '; const o = { notes: [] };
  const mDst = t.match(/(?:vao|cho|thay|len)\s+(?:khuon\s+)?mat\s+(?:thu\s+|so\s+)?(\d+|mot|hai|ba|bon|nam)/);
  if (mDst) { o.dstFace = num(mDst[1]); o.notes.push(`mặt đích thứ ${o.dstFace}`); }
  const mSrc = t.match(/mat\s+(?:thu\s+|so\s+)?(\d+|mot|hai|ba|bon|nam)\s+(?:cua\s+|trong\s+|o\s+)?anh\s+(?:nguon|1|mot|dau)/) || t.match(/(?:lay|dung)\s+mat\s+(?:thu\s+|so\s+)?(\d+|mot|hai|ba|bon|nam)/);
  if (mSrc) { o.srcFace = num(mSrc[1]); o.notes.push(`mặt nguồn thứ ${o.srcFace}`); }
  if (/ben trai|nguoi trai|phia trai/.test(t)) { o.dstFace = 'left'; o.notes.push('mặt bên trái'); }
  if (/ben phai|nguoi phai|phia phai/.test(t)) { o.dstFace = 'right'; o.notes.push('mặt bên phải'); }
  if (/lon nhat|to nhat|gan nhat/.test(t)) { o.dstFace = 'largest'; o.notes.push('mặt lớn nhất'); }
  if (/tat ca|moi mat|moi nguoi|ca nhom|het cac mat/.test(t)) { o.all = true; o.notes.push('tất cả các mặt'); }
  if (/(khong|bo|tat)\s+khoa|thay ca toc|ca toc|lay ca toc/.test(t)) { o.lock = false; o.notes.push('không khoá vùng (thay cả ô vuông mặt)'); }
  else if (/khoa vung|giu toc|chi thay mat|giu nguyen toc/.test(t)) { o.lock = true; o.notes.push('khoá vùng mặt'); }
  if (/giu (mieng|moi|rang|nu cuoi)/.test(t)) { o.keepMouth = true; o.notes.push('giữ miệng gốc'); }
  if (/(khong|bo|tat)\s+(lam net|phuc hoi|restore)/.test(t)) { o.restore = false; o.notes.push('không làm nét'); }
  else if (/lam net (manh|nhieu|toi da)|net nhat/.test(t)) { o.restore = true; o.restoreAmt = 1; o.notes.push('làm nét mạnh'); }
  else if (/lam net (nhe|it|vua)/.test(t)) { o.restore = true; o.restoreAmt = 0.5; o.notes.push('làm nét nhẹ'); }
  if (/(khong|bo|tat)\s+(chinh|khop|can)\s+mau/.test(t)) { o.colorMatch = false; o.notes.push('không khớp màu'); }
  const up = t.match(/(?:phong to|xuat|nang)\s*(?:len\s*)?(4k|2k|full ?hd|1080|2x|4x)/);
  if (up) { const k = up[1].replace(' ', ''); o.upscale = k === '4k' ? 3840 : k === '2k' ? 2560 : k === '2x' ? 2 : k === '4x' ? 4 : 1920; o.notes.push('phóng to ' + up[1].toUpperCase()); }
  for (const [re, id] of SWAP_ALIASES) if (re.test(t)) { o.swapper = id; o.notes.push('model ' + id); break; }
  for (const [re, id] of RESTORE_ALIASES) if (re.test(t)) { o.restorer = id; if (o.restore !== false) o.restore = true; o.notes.push('làm nét bằng ' + id); break; }
  return o;
}
export const SWAP_CHIPS = ['Ghép vào mặt lớn nhất', 'Ghép vào mặt bên trái', 'Ghép vào mặt bên phải', 'Ghép tất cả các mặt', 'Giữ miệng gốc', 'Thay cả tóc', 'Làm nét mạnh', 'Không làm nét', 'Dùng HyperSwap', 'Xuất 4K'];
export const STYLE_CHIPS = {
  'Chân dung': 'portrait photo, soft studio lighting, 85mm, detailed face, sharp focus',
  'Anime': 'anime style, vibrant colors, clean line art, cel shading',
  'Phong cảnh': 'wide landscape, golden hour, dramatic sky, highly detailed, 4k',
  'Siêu thực': 'photorealistic, ultra detailed, natural light, 8k photo',
  '3D': '3d render, octane render, soft global illumination, cute, high detail',
  'Tranh vẽ': 'oil painting, visible brush strokes, artstation, masterpiece',
};
