import fs from "node:fs";
import path from "node:path";

export const DEFAULT_SETTINGS = { maxConcurrent: 10 };

// Ghi ra file tạm rồi đổi tên: app có tắt đột ngột cũng không để lại file ghi dở.
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// data.json chỉ giữ project, thông tin task và settings. Lịch sử mỗi task nằm
// ở logs/<taskId>.json, chỉ nạp vào RAM khi task đang chạy hoặc đang được xem.
export class Store {
  constructor(dir) {
    this.file = path.join(dir, "data.json");
    this.logDir = path.join(dir, "logs");
    this.data = { projects: [], groups: [], tasks: [], settings: {} };
    if (fs.existsSync(this.file)) {
      try {
        this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
      } catch {
        // File hỏng: giữ lại bản sao để không mất dữ liệu, rồi chạy với dữ liệu trống.
        fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      }
    }
    this.data.settings = { ...DEFAULT_SETTINGS, ...this.data.settings };
    this.timer = null;
    this.logs = new Map(); // taskId -> entries (đang nạp)
    this.logTimers = new Map(); // taskId -> timeout ghi file

    fs.mkdirSync(this.logDir, { recursive: true });
    let migrated = false;
    for (const t of this.data.tasks) {
      // Task đang chạy dở khi app tắt thì coi như đã dừng.
      if (["running", "waiting", "stopping", "queued"].includes(t.status)) t.status = "stopped";
      // Chuyển log từ bản cũ (nằm trong data.json) ra file riêng.
      if (Array.isArray(t.log)) {
        fs.writeFileSync(this.logFile(t.id), JSON.stringify(t.log));
        delete t.log;
        migrated = true;
      }
    }
    if (migrated) this.flush();
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeAtomic(this.file, JSON.stringify(this.data, null, 2));
    for (const id of this.logTimers.keys()) this.flushLog(id);
  }

  // ---------- log từng task ----------

  logFile(taskId) {
    return path.join(this.logDir, `${taskId}.json`);
  }

  log(taskId) {
    let entries = this.logs.get(taskId);
    if (!entries) {
      try {
        entries = JSON.parse(fs.readFileSync(this.logFile(taskId), "utf8"));
      } catch {
        entries = [];
      }
      this.logs.set(taskId, entries);
    }
    return entries;
  }

  saveLog(taskId) {
    clearTimeout(this.logTimers.get(taskId));
    this.logTimers.set(taskId, setTimeout(() => this.flushLog(taskId), 500));
  }

  flushLog(taskId) {
    clearTimeout(this.logTimers.get(taskId));
    this.logTimers.delete(taskId);
    const entries = this.logs.get(taskId);
    // Task đã bị xoá thì không ghi lại file.
    if (entries && this.task(taskId)) writeAtomic(this.logFile(taskId), JSON.stringify(entries));
  }

  // Ghi xuống đĩa rồi bỏ khỏi RAM.
  unloadLog(taskId) {
    if (this.logTimers.has(taskId)) this.flushLog(taskId);
    this.logs.delete(taskId);
  }

  deleteLog(taskId) {
    clearTimeout(this.logTimers.get(taskId));
    this.logTimers.delete(taskId);
    this.logs.delete(taskId);
    fs.rmSync(this.logFile(taskId), { force: true });
  }

  // ---------- truy cập ----------

  get projects() {
    return this.data.projects;
  }

  get groups() {
    return (this.data.groups ??= []);
  }

  get tasks() {
    return this.data.tasks;
  }

  get settings() {
    return this.data.settings;
  }

  task(id) {
    return this.data.tasks.find((t) => t.id === id);
  }

  project(id) {
    return this.data.projects.find((p) => p.id === id);
  }
}
