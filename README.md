# ClaudeDeck

App desktop macOS để quản lý nhiều project và giao việc cho Claude chạy song song, khỏi phải mở nhiều cửa sổ VSCode.

## Chạy

```bash
npm install
npm start
```

Đóng gói thành app (`dist/mac-arm64/ClaudeDeck.app`), sau đó kéo vào thư mục Applications:

```bash
npm run dist
```

Yêu cầu: đã cài Claude Code (`claude`) và đã đăng nhập. App dùng chung đăng nhập và settings (`~/.claude`, `CLAUDE.md` của từng project) với Claude Code.

## Cách dùng

- **＋** ở sidebar: thêm một hoặc nhiều thư mục project.
- **Tổng quan**: chọn project, gõ prompt, nhấn Enter (Shift + Enter để xuống dòng). Có thể giao liên tục nhiều task cho nhiều project, các task chạy song song.
- Bấm vào một task để xem tiến trình, duyệt quyền (Cho phép / Luôn cho phép / Từ chối) và nhắn tiếp trong cùng phiên.
- Chế độ quyền mỗi task:
  - Tự sửa file, hỏi khi chạy lệnh (`acceptEdits`)
  - Hỏi trước mọi thao tác (`default`)
  - Auto
  - Toàn quyền
  - Chỉ lên kế hoạch
- Khi task cần duyệt hoặc đã xong, app gửi thông báo macOS nếu cửa sổ không ở phía trước.

Dữ liệu được lưu tại `~/Library/Application Support/ClaudeDeck/data.json`.

## Cấu trúc

- `src/main.js`: tiến trình chính của Electron, gồm IPC, cửa sổ, thông báo
- `src/agent.js`: chạy task bằng Claude Agent SDK, mỗi task một `query()` riêng
- `src/store.js`: lưu project và task
- `src/preload.cjs`: cầu nối an toàn giữa main và giao diện
- `src/renderer/`: giao diện (HTML/CSS/JS thuần)

## Ghi chú

- Chạy từ terminal của VSCode vẫn được: script `start` đã bỏ biến `ELECTRON_RUN_AS_NODE` mà VSCode tự đặt.
- Nếu Electron báo cài lỗi, chạy `node node_modules/electron/install.js`.
