// An toàn: chặn nội dung tình dục / liên quan trẻ vị thành niên (VI + EN), prompt phủ định mặc định, ngưỡng open_nsfw.
const strip = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
const SEX = ['nude', 'naked', 'nsfw', 'porn', 'sex', 'sexy', 'hentai', 'erotic', 'nipple', 'topless', 'genital', 'penis', 'vagina', 'boob', 'breast', 'lingerie', 'undress', 'striptease', 'xxx', 'fetish', 'onlyfans', 'bdsm', 'orgasm', 'cum', 'blowjob', 'nudity',
  'khoa than', 'loa the', 'khieu dam', 'tinh duc', 'doi truy', 'nguc tran', 'lo nguc', 'lo hang', 'cho buom', 'sex', 'lam tinh', 'dit', 'dam duc', 'goi cam', 'hoc mon', 'vu to', 'mong to', 'bikini', 'noi y', 'do lot', 'thoat y', 'cuoi do', 'phim nguoi lon', 'nguoi lon 18', '18+', 'jav', 'clip nong'];
const MINOR = ['child', 'children', 'kid', 'kids', 'minor', 'underage', 'teen', 'teenage', 'loli', 'shota', 'schoolgirl', 'schoolboy', 'young girl', 'young boy', 'baby', 'toddler', 'preteen',
  'tre em', 'tre con', 'be gai', 'be trai', 'em be', 'thieu nhi', 'hoc sinh', 'vi thanh nien', 'thieu nu', 'dua tre', 'nhi dong', 'mam non', 'tieu hoc', 'cap 1', 'cap 2'];
const word = (t, w) => new RegExp('(^|[^a-z0-9])' + w.replace(/[+]/g, '\\+') + '($|[^a-z0-9])').test(t);
/** Trả {ok, reason} */
export function checkPrompt(text) {
  const t = strip(text || '');
  const sex = SEX.find(w => word(t, w)); const minor = MINOR.find(w => word(t, w));
  if (sex && minor) return { ok: false, reason: 'Bị chặn: nội dung tình dục liên quan đến trẻ vị thành niên.' };
  if (sex) return { ok: false, reason: `Bị chặn: lệnh có từ không phù hợp ("${sex}"). Ứng dụng không tạo nội dung khiêu dâm/hở hang.` };
  return { ok: true, minor: !!minor };
}
export const NEGATIVE = 'nsfw, nude, naked, nudity, sexual, cleavage, lingerie, gore, blood, watermark, text, logo, low quality, blurry, deformed, extra fingers, bad anatomy';
export const NSFW_BLOCK = 0.6;      // ảnh vào / ra có điểm open_nsfw ≥ ngưỡng → chặn
export const CONSENT = 'Chỉ dùng ảnh của bạn hoặc người đã đồng ý. Không dùng để mạo danh, lừa đảo, bôi nhọ, hay tạo ảnh nhạy cảm. Mọi xử lý diễn ra trên máy của bạn — ảnh không được gửi lên mạng.';
