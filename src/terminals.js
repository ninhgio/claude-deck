import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

// node-pty là module native (CommonJS): nạp khi mở terminal đầu tiên, để nếu module lỗi
// thì chỉ terminal không chạy chứ app vẫn mở được.
let pty;
const loadPty = () => (pty ??= createRequire(import.meta.url)("node-pty"));

// Quản lý các terminal (pty) của từng project. Shell sống ở main process nên
// chuyển màn hình trong app không làm mất terminal.
export class TerminalManager {
  constructor(emit) {
    this.emit = emit; // (channel, payload) => void
    this.terms = new Map(); // id -> { proc, projectId }
  }

  create({ projectId, cwd, cols = 80, rows = 24 }) {
    const id = randomUUID();
    const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "ClaudeDeck" };
    delete env.ELECTRON_RUN_AS_NODE;
    const win = process.platform === "win32";
    const shell = win ? "powershell.exe" : process.env.SHELL || "/bin/zsh";
    const proc = loadPty().spawn(shell, win ? [] : ["-l"], { name: "xterm-256color", cwd, cols, rows, env });

    // Gom dữ liệu ra theo từng nhịp ngắn để không gửi quá nhiều IPC khi output dồn dập.
    let buf = "";
    let timer = null;
    proc.onData((data) => {
      buf += data;
      if (!timer) {
        timer = setTimeout(() => {
          this.emit("term:data", { id, data: buf });
          buf = "";
          timer = null;
        }, 8);
      }
    });
    proc.onExit(({ exitCode }) => {
      if (buf) this.emit("term:data", { id, data: buf });
      this.terms.delete(id);
      this.emit("term:exit", { id, exitCode });
    });

    this.terms.set(id, { proc, projectId });
    return { id, shell: shell.split(/[\\/]/).pop().replace(/\.exe$/i, "") };
  }

  write(id, data) {
    this.terms.get(id)?.proc.write(data);
  }

  resize(id, cols, rows) {
    if (cols > 0 && rows > 0) this.terms.get(id)?.proc.resize(cols, rows);
  }

  kill(id) {
    this.terms.get(id)?.proc.kill();
    this.terms.delete(id);
  }

  killProject(projectId) {
    for (const [id, t] of this.terms) if (t.projectId === projectId) this.kill(id);
  }

  // Lúc thoát app. Windows: tắt cả cây tiến trình (shell, lệnh đang chạy trong đó, OpenConsole)
  // trước khi app đóng, để không còn gì giữ file trong thư mục cài đặt.
  killAll() {
    for (const [id, t] of [...this.terms]) {
      if (process.platform === "win32" && t.proc.pid) {
        try {
          execFileSync("taskkill", ["/pid", String(t.proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
        } catch {}
      }
      this.kill(id);
    }
  }
}
