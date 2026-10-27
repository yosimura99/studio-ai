# Studio AI — Ghép mặt & Tạo ảnh offline

Ứng dụng web chạy **hoàn toàn trong trình duyệt** (WebGPU, tự chuyển sang WASM nếu máy không có WebGPU). Không API key, không server, ảnh không rời khỏi máy. Model chỉ tải khi bạn dùng tới, sau đó lưu trong máy để chạy offline.

- Mở app: https://yosimura99.github.io/studio-ai/
- Hướng dẫn (tiếng Việt): https://yosimura99.github.io/studio-ai/docs.html
- App riêng (cài lên màn hình chính được), đi kèm **Pỏn của Khang** (https://yosimura99.github.io/studio/), dùng chung mã PIN (`js/lock.js`, `data-ns="studio"`).

## Tính năng
- **Ghép mặt AI**: SCRFD (tìm mặt) → ArcFace → model ghép (inswapper / HyperSwap / SimSwap / GHOST / UniFace) → làm nét (GFPGAN / CodeFormer / GPEN / RestoreFormer++) → BiSeNet khoá vùng mặt + cọ vẽ mặt nạ. Ảnh xuất đủ độ phân giải, điểm ảnh ngoài mặt nạ giữ nguyên 100%.
- **Lệnh tiếng Việt** + nút gợi ý (ghép vào mặt thứ 2, giữ miệng, làm nét mạnh, xuất 4K…).
- **Tạo ảnh từ prompt / từ ảnh**: 2 mức — *Nhanh* (SDXS-512, 1 bước, ≈0,88 GB) và *Chất lượng cao* (SD-Turbo, 1–8 bước, ≈2,58 GB, cần WebGPU). Prompt tiếng Việt được dịch offline sang tiếng Anh (opus-mt vi→en).
- **Tải model của bạn**: file `.onnx`, cả thư mục, hoặc link (Hugging Face…). Tự nhận dạng kiểu model qua đầu vào/ra, đọc `model.json` nếu có, hoặc cho chọn kiểu thủ công. Có thể xoá bất kỳ lúc nào.
- **Bot API**: `?cmd=...&auto=1` hoặc `window.studioAI.run({...})` / `window.studioAI.generate({...})` (chỉ chạy sau khi mở khoá PIN).
- **An toàn**: lọc ảnh nhạy cảm (open_nsfw) cho ảnh vào và ảnh ra, chặn từ khoá Việt + Anh, nhắc về sự đồng ý.

## Model & giấy phép
Model nằm trong repo này (`models/`) và các repo phụ cùng domain GitHub Pages: `studio-ai-m1..m4` (ghép/làm nét), `studio-ai-t2i` (mức Nhanh), `studio-ai-hq1..3` (mức Chất lượng cao). Mỗi model được đóng gói lại thành các mảnh ≤ 45 MB (fp16), không đổi trọng số.

| Model | Dùng cho | Dung lượng | Giấy phép |
|---|---|---|---|
| SCRFD 2.5g / ArcFace w600k_r50 | tìm mặt / nhận dạng | 8 / 87 MB | InsightFace — phi thương mại |
| inswapper_128 | ghép (mặc định) | 278 MB | InsightFace — phi thương mại |
| HyperSwap 1a / 1b / 1c (256) | ghép | 403 MB mỗi cái | ResearchRAIL-M (FaceFusion) |
| SimSwap 256 / unofficial 512 | ghép | 110 / 120 MB | Phi thương mại (neuralchen/SimSwap) |
| GHOST 1 / 2 / 3 (256) | ghép | 258 / 370 / 428 MB | Apache-2.0 (ai-forever/ghost) |
| UniFace 256 | ghép | 204 MB | Chưa rõ — chỉ dùng cá nhân |
| crossface simswap / ghost | đổi embedding | 11 MB mỗi cái | theo model ghép (FaceFusion) |
| GFPGAN 1.4 | làm nét (mặc định) | 170 MB | Apache-2.0 (TencentARC) |
| CodeFormer | làm nét | 189 MB | S-Lab License 1.0 — phi thương mại |
| GPEN-BFR 512 | làm nét | 142 MB | Phi thương mại (yangxy/GPEN) |
| RestoreFormer++ | làm nét | 148 MB | Apache-2.0 |
| BiSeNet face parsing | khoá vùng mặt | 47 MB | MIT |
| open_nsfw | lọc an toàn | 12 MB | BSD-2-Clause (Yahoo) |
| SDXS-512 (text encoder / UNet / TAESD) | tạo ảnh Nhanh | 246 / 632 / 4 MB | CreativeML OpenRAIL++-M |
| SD-Turbo (UNet / text encoder / VAE) | tạo ảnh Chất lượng cao | 1733 / 681 / 167 MB | Stability AI Community License |
| opus-mt-vi-en (encoder / decoder) | dịch prompt | 47 / 54 MB | CC-BY-4.0 (Helsinki-NLP) |

Đã thử và **loại bỏ**: BlendSwap (kết quả không đạt khi kiểm tra). Không có model người nổi tiếng/idol và không có model NSFW.

Thư viện: onnxruntime-web 1.31.1 (MIT), nằm trong `vendor/ort`.

## Lưu ý sử dụng
Chỉ dùng ảnh của chính bạn hoặc người đã đồng ý. Không dùng để mạo danh, lừa đảo, bôi nhọ hay tạo nội dung khiêu dâm/người chưa thành niên. Phần lớn model ghép/làm nét chỉ cho phép dùng **phi thương mại**.
