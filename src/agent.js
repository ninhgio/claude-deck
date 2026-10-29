import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const MAX_TEXT = 4000;

const IS_WIN = process.platform === "win32";

// Binary claude đóng gói kèm SDK (bản Mac). Khi đóng gói nó nằm trong app.asar.unpacked.
function bundledClaude() {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const bin = path.join(path.dirname(pkg), IS_WIN ? "claude.exe" : "claude").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    return fs.existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

// Claude Code đã cài trên máy: chỗ trình cài đặt chính thức đặt vào, rồi tới PATH.
function installedClaude() {
  const home = os.homedir();
  const npmGlobal = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@anthropic-ai");
  const known = IS_WIN
    ? [
        path.join(home, ".local", "bin", "claude.exe"),
        path.join(process.env.LOCALAPPDATA ?? "", "Programs", "claude", "claude.exe"),
        path.join(process.env.LOCALAPPDATA ?? "", "AnthropicClaude", "claude.exe"),
        // Cài bằng npm: lệnh là claude.cmd, nhưng binary thật (claude.exe) nằm trong gói.
        path.join(npmGlobal, "claude-code", "bin", "claude.exe"),
        path.join(npmGlobal, "claude-code-win32-x64", "claude.exe"),
        path.join(npmGlobal, "claude-code", "node_modules", "@anthropic-ai", "claude-code-win32-x64", "claude.exe"),
      ]
    : [path.join(home, ".local", "bin", "claude"), path.join(home, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  const hit = known.find((p) => fs.existsSync(p));
  if (hit) return hit;
  try {
    const out = execFileSync(IS_WIN ? "where" : "which", IS_WIN ? ["claude"] : ["-a", "claude"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const found = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // Windows: chỉ dùng được claude.exe; claude.cmd (cài bằng npm) không chạy trực tiếp được.
    return (IS_WIN ? found.find((p) => /\.exe$/i.test(p)) : found[0]) ?? null;
  } catch {
    return null;
  }
}

let detected; // chưa tìm thấy thì lần sau dò lại (người dùng có thể vừa cài xong)
// Thứ tự: đường dẫn trong Cài đặt → bản đóng gói kèm app → bản cài trên máy.
export function claudeBin(customPath) {
  if (customPath && fs.existsSync(customPath)) return customPath;
  if (!detected) detected = bundledClaude() ?? installedClaude();
  return detected ?? undefined;
}
export function resetClaudeDetection() {
  detected = undefined;
}

// Chạy `claude --version` để kiểm tra đường dẫn.
export function checkClaude(customPath) {
  const custom = customPath?.trim();
  if (custom && !fs.existsSync(custom)) return Promise.resolve({ error: `Không thấy file: ${custom}` });
  if (custom && IS_WIN && !/\.exe$/i.test(custom)) return Promise.resolve({ error: "Trên Windows cần trỏ tới claude.exe (bản cài bằng trình cài đặt chính thức), không dùng được claude.cmd." });
  const bin = custom || claudeBin();
  if (!bin) return Promise.resolve({ error: "Không tìm thấy Claude Code trên máy. Cài Claude Code rồi bấm Kiểm tra lại, hoặc nhập đường dẫn." });
  return new Promise((resolve) =>
    execFile(bin, ["--version"], { timeout: 15000, windowsHide: true }, (err, stdout) =>
      resolve(err ? { path: bin, error: String(err.message) } : { path: bin, version: stdout.trim(), source: custom ? "custom" : bin === bundledClaude() ? "bundled" : "installed" }),
    ),
  );
}

// Lỗi kiểu này nghĩa là phải đăng nhập lại.
const AUTH_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required"]);
const AUTH_TEXT = /authenticat|oauth|token (has )?expired|invalid api key|please run \/login|not logged in|log ?in again|401/i;

// Ghép prompt với file đính kèm. Ảnh gửi thẳng cho model (content block),
// file khác đưa đường dẫn để Claude tự đọc; thư mục ngoài project được cấp quyền đọc.
// priority "later": CLI giữ prompt tới hết lượt đang chạy rồi chạy thành lượt riêng.
function buildInput(prompt, attachments, projectPath, priority) {
  const images = attachments.filter((a) => a.kind === "image" && a.data);
  const files = attachments.filter((a) => a.kind === "file" && a.path);
  let text = prompt;
  if (files.length) text += `\n\nFile đính kèm:\n${files.map((f) => `- ${f.path}`).join("\n")}`;
  const dirs = [...new Set(files.map((f) => path.dirname(f.path)))].filter(
    (d) => d !== projectPath && !d.startsWith(projectPath + path.sep),
  );
  const content = images.length
    ? [...images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } })), { type: "text", text }]
    : text;
  // uuid: CLI phát lại (replay) đúng uuid này khi Claude đọc prompt → biết đã nhận.
  return { message: { type: "user", uuid: randomUUID(), priority, parent_tool_use_id: null, message: { role: "user", content } }, dirs };
}

// Luồng nhập của một phiên claude: prompt gửi thêm khi đang chạy được đẩy vào đây và
// Claude đọc ngay trong lượt đang chạy. end() khi xong lượt: claude vẫn xử lý hết
// những gì đã nhận rồi mới thoát.
class InputQueue {
  constructor(first) {
    this.items = [first];
    this.ended = false;
    this.wake = null;
  }
  push(msg) {
    if (this.ended) return false;
    this.items.push(msg);
    this.wake?.();
    return true;
  }
  end() {
    this.ended = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.items.length) yield this.items.shift();
      if (this.ended) return;
      await new Promise((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

const clip = (s) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "\n… (đã cắt bớt)" : s);

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  }
  return "";
}

// Quản lý các agent đang chạy. Mỗi task là một query() độc lập (một tiến trình
// claude, ~300MB RAM) nên nhiều task chạy song song được, tối đa
// settings.maxConcurrent; task vượt giới hạn nằm trong hàng đợi.
export class AgentManager {
  constructor(store, emit) {
    this.store = store;
    this.emit = emit; // (channel, payload) => void
    this.running = new Map(); // taskId -> Query
    this.pending = new Map(); // requestId -> { taskId, resolve, suggestions }
    this.queue = []; // [{ taskId, prompt }]
    this.bgTasks = new Map(); // taskId -> Set(id lệnh nền / sub-agent nền đang chạy)
    this.procs = new Map(); // taskId -> tiến trình claude của task
    this.ctxPending = new Map();
    this.inputs = new Map(); // taskId -> InputQueue của phiên đang chạy
    this.followups = new Map(); // taskId -> [{ prompt, attachments, entryId }] gửi lúc phiên đang đóng, chạy tiếp ngay sau
    this.inflight = new Map(); // taskId -> Map(uuid -> { prompt, attachments, entryId }) đã đẩy vào phiên, Claude chưa đọc
  }

  get maxConcurrent() {
    return Math.max(1, this.store.settings.maxConcurrent || 1);
  }

  setMaxConcurrent(n) {
    this.store.settings.maxConcurrent = Math.max(1, Math.min(50, Math.round(n) || 1));
    this.store.save();
    this.drain();
  }

  updateTask(task, patch) {
    Object.assign(task, patch, { updatedAt: Date.now() });
    this.store.save();
    this.emit("task:update", { ...task });
  }

  push(task, entry) {
    entry = { id: randomUUID(), at: Date.now(), ...entry };
    this.store.log(task.id).push(entry);
    this.store.saveLog(task.id);
    this.emit("task:entry", { taskId: task.id, entry });
    return entry;
  }

  // Trạng thái prompt gửi lúc đang chạy: pending (chờ Claude đọc) · later (chờ hết lượt) · delivered · cancelled.
  setDelivery(task, entryIds, delivery) {
    const ids = new Set(entryIds);
    const log = this.store.log(task.id);
    for (const entry of [...log]) {
      if (!ids.has(entry.id) || entry.delivery === delivery) continue;
      // Prompt "sau lượt" bắt đầu chạy: chuyển xuống cuối log, đúng chỗ lượt của nó.
      if (entry.delivery === "later" && delivery === "delivered") {
        log.splice(log.indexOf(entry), 1);
        log.push(entry);
        entry.at = Date.now();
        entry.moved = true;
      }
      entry.delivery = delivery;
      this.emit("task:entry", { taskId: task.id, entry });
    }
    this.store.saveLog(task.id);
  }

  createTask(projectId, prompt, permissionMode, { model = null, effort = null, ultracode = false, web = false, attachments = [] } = {}) {
    const task = {
      id: randomUUID(),
      projectId,
      title: prompt.split("\n")[0].slice(0, 80),
      status: "idle",
      permissionMode,
      model, // null = model mặc định của Claude Code
      effort, // null = mức mặc định
      ultracode, // bật điều phối nhiều agent (workflow) cho cả phiên
      web, // cho phép WebSearch/WebFetch không cần hỏi
      sessionId: null,
      costUsd: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.tasks.push(task);
    this.run(task, prompt, attachments);
    return task;
  }

  // Gửi tiếp prompt vào task đã có (tiếp tục cùng session).
  // Task đang chạy: chèn prompt vào lượt đang chạy; Claude vừa xong lượt (phiên chưa đóng)
  // hoặc task đang xếp hàng: giữ lại và gửi ngay sau đó.
  // after: chỉ gửi khi Claude xong lượt đang chạy (thành lượt riêng, có câu trả lời riêng).
  send(taskId, prompt, attachments = [], { after = false } = {}) {
    const task = this.store.task(taskId);
    if (!task) return;
    if (!this.isBusy(taskId)) return this.run(task, prompt, attachments);
    if (task.turnDone) after = false; // Claude đã xong lượt (chỉ còn lệnh nền): không có lượt nào để chờ
    const project = this.store.project(task.projectId);
    if (!project) return;
    const queued = this.queue.find((q) => q.taskId === taskId);
    if (queued) {
      this.logUser(task, prompt, attachments);
      queued.prompt += `\n\n${prompt}`;
      queued.attachments = [...queued.attachments, ...attachments];
      return;
    }
    const entry = this.logUser(task, prompt, attachments, after ? "later" : "pending");
    const { message } = buildInput(prompt, attachments, project.path, after ? "later" : undefined);
    if (this.inputs.get(taskId)?.push(message)) {
      this.inflight.get(taskId)?.set(message.uuid, { prompt, attachments, entryId: entry.id });
      if (task.turnDone && !after) this.updateTask(task, { turnDone: false });
      return;
    }
    if (!after) this.setDelivery(task, [entry.id], "later");
    const later = this.followups.get(taskId) ?? [];
    later.push({ prompt, attachments, entryId: entry.id });
    this.followups.set(taskId, later);
  }

  logUser(task, prompt, attachments, delivery) {
    // Log chỉ giữ tên + ảnh thu nhỏ, không lưu dữ liệu ảnh gốc.
    const shown = attachments.map(({ kind, name, path, thumb }) => ({ kind, name, path, thumb }));
    return this.push(task, { kind: "user", text: prompt, attachments: shown.length ? shown : undefined, delivery });
  }

  isBusy(taskId) {
    return this.running.has(taskId) || this.queue.some((q) => q.taskId === taskId);
  }

  // attachments: [{ kind: "image", name, mediaType, data, thumb } | { kind: "file", name, path }]
  run(task, prompt, attachments = []) {
    if (!this.store.project(task.projectId)) return;
    this.logUser(task, prompt, attachments);
    if (this.running.size >= this.maxConcurrent) {
      this.queue.push({ taskId: task.id, prompt, attachments });
      this.updateTask(task, { status: "queued" });
      return;
    }
    this.start(task, prompt, attachments);
  }

  // Chạy task tiếp theo trong hàng đợi nếu còn chỗ.
  drain() {
    while (this.queue.length && this.running.size < this.maxConcurrent) {
      const { taskId, prompt, attachments } = this.queue.shift();
      const task = this.store.task(taskId);
      if (task) this.start(task, prompt, attachments);
    }
  }

  async start(task, prompt, attachments = []) {
    const project = this.store.project(task.projectId);
    if (!project) return;
    if (!claudeBin(this.store.settings.claudePath)) {
      this.push(task, { kind: "error", text: "Không tìm thấy Claude Code trên máy. Cài Claude Code hoặc nhập đường dẫn tới claude trong ⚙ Cài đặt." });
      this.updateTask(task, { status: "error" });
      this.emit("task:finished", { taskId: task.id, status: "error" });
      return this.drain();
    }
    const input = buildInput(prompt, attachments, project.path);
    // warnings: số thao tác bị người dùng từ chối trong lượt chạy này.
    this.updateTask(task, { status: "running", warnings: 0, turnDone: false, background: 0 });

    const inputQueue = new InputQueue(input.message);
    this.inputs.set(task.id, inputQueue);
    this.inflight.set(task.id, new Map());
    const q = query({
      prompt: inputQueue,
      options: {
        cwd: project.path,
        additionalDirectories: input.dirs.length ? input.dirs : undefined,
        allowedTools: task.web ? ["WebSearch", "WebFetch"] : undefined,
        pathToClaudeCodeExecutable: claudeBin(this.store.settings.claudePath),
        resume: task.sessionId ?? undefined,
        permissionMode: task.permissionMode,
        model: task.model && task.model !== "default" ? task.model : undefined,
        effort: task.effort ?? undefined,
        settings: task.ultracode ? { ultracode: true } : undefined,
        settingSources: ["user", "project", "local"],
        // CLI phát lại prompt (kèm uuid) lúc Claude đọc nó → đánh dấu "đã nhận" cho prompt gửi giữa chừng.
        extraArgs: { "replay-user-messages": null },
        canUseTool: (toolName, input, opts) => this.askPermission(task, toolName, input, opts),
        // Tự khởi chạy claude để nắm được tiến trình: Dừng = tắt hẳn claude (nó dọn luôn lệnh nền).
        spawnClaudeCodeProcess: (o) => {
          // detached: claude làm trưởng nhóm tiến trình để Dừng tắt được cả lệnh nền (Windows dùng taskkill /T).
          const child = spawn(o.command, o.args, { cwd: o.cwd, env: { ...o.env, ...this.extraEnv?.() }, stdio: ["pipe", "pipe", "pipe"], detached: !IS_WIN, windowsHide: true, signal: o.signal });
          child.stderr.resume();
          this.procs.set(task.id, child);
          return child;
        },
      },
    });
    this.running.set(task.id, q);

    let finalStatus = "done";
    try {
      for await (const msg of q) this.handle(task, msg);
    } catch (err) {
      finalStatus = "error";
      // Bị người dùng dừng thì tiến trình thoát với mã lỗi: không phải lỗi thật.
      if (task.status !== "stopping") {
        const text = String(err?.message ?? err);
        this.push(task, { kind: "error", text });
        if (AUTH_TEXT.test(text)) this.authRequired(task, text);
      }
    } finally {
      this.running.delete(task.id);
      this.inputs.delete(task.id);
      // Prompt đã đẩy vào phiên mà Claude chưa kịp đọc (phiên đóng trước): chạy ở phiên tiếp theo, không để mất.
      const unread = [...(this.inflight.get(task.id)?.values() ?? [])];
      this.inflight.delete(task.id);
      if (unread.length) this.followups.set(task.id, [...unread, ...(this.followups.get(task.id) ?? [])]);
      this.bgTasks.delete(task.id);
      this.procs.delete(task.id);
      this.rejectPending(task.id);
      if (task.status === "stopping") finalStatus = "stopped";
      else if (task.lastResultError) finalStatus = "error";
      delete task.lastResultError;
      this.updateTask(task, { status: finalStatus, turnDone: false, background: 0 });
      const later = this.followups.get(task.id);
      this.followups.delete(task.id);
      if (later?.length && finalStatus !== "stopped") {
        // Prompt gửi lúc phiên đang đóng: chạy tiếp ngay trong cùng session.
        this.setDelivery(task, later.map((f) => f.entryId).filter(Boolean), "delivered");
        this.start(task, later.map((f) => f.prompt).join("\n\n"), later.flatMap((f) => f.attachments));
      } else {
        if (later?.length) this.setDelivery(task, later.map((f) => f.entryId).filter(Boolean), "cancelled");
        this.emit("task:finished", { taskId: task.id, status: finalStatus });
        this.store.unloadLog(task.id);
      }
      this.drain();
    }
  }

  handle(task, msg) {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init" && msg.session_id) {
          this.updateTask(task, { sessionId: msg.session_id });
        } else if (msg.subtype === "background_tasks_changed") {
          // Lệnh chạy nền (run_in_background) giữ phiên mở sau khi Claude trả lời xong.
          this.bgTasks.set(task.id, new Set((msg.tasks ?? []).filter((t) => !t.ambient).map((t) => t.task_id)));
          this.updateTask(task, { background: this.bgTasks.get(task.id).size });
          this.endInputIfIdle(task);
        } else if (msg.subtype === "compact_boundary") {
          const m = msg.compact_metadata ?? {};
          this.push(task, { kind: "compact", trigger: m.trigger, preTokens: m.pre_tokens, postTokens: m.post_tokens });
          // Số đo ngay sau khi nén chưa chính xác: dùng post_tokens, bỏ kết quả đo đang dở.
          task.compactAt = Date.now();
          if (task.context && m.post_tokens != null) this.updateTask(task, { context: { ...task.context, used: m.post_tokens } });
        }
        break;
      case "assistant":
        if (task.turnDone) this.updateTask(task, { turnDone: false });
        if (AUTH_ERRORS.has(msg.error)) this.authRequired(task, msg.error);
        // Bỏ qua message của sub-agent để log gọn hơn.
        if (msg.parent_tool_use_id) break;
        this.trackCache(task, msg.message?.usage);
        this.refreshContext(task);
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text" && block.text.trim()) {
            this.push(task, { kind: "text", text: block.text });
            this.updateTask(task, { lastText: block.text.slice(0, 300) });
          } else if (block.type === "thinking" && block.thinking?.trim()) {
            this.push(task, { kind: "thinking", text: clip(block.thinking) });
          } else if (block.type === "tool_use") {
            this.push(task, { kind: "tool", toolUseId: block.id, name: block.name, input: block.input });
          }
        }
        break;
      case "user":
        if (msg.isReplay) {
          // Claude vừa đọc prompt gửi giữa chừng (hoặc bắt đầu lượt "sau lượt").
          const item = this.inflight.get(task.id)?.get(msg.uuid);
          if (item) {
            this.inflight.get(task.id).delete(msg.uuid);
            this.setDelivery(task, [item.entryId], "delivered");
            if (task.turnDone) this.updateTask(task, { turnDone: false });
          }
          break;
        }
        if (msg.parent_tool_use_id || !Array.isArray(msg.message?.content)) break;
        for (const block of msg.message.content) {
          if (block.type === "tool_result") {
            this.push(task, {
              kind: "tool_result",
              toolUseId: block.tool_use_id,
              isError: !!block.is_error,
              text: clip(toolResultText(block.content)),
            });
          }
        }
        break;
      case "result": {
        const ok = msg.subtype === "success" && !msg.is_error;
        // Bấm Dừng giữa lượt: CLI kết thúc lượt bằng error_during_execution ("[ede_diagnostic] …") — đó là dừng, không phải lỗi.
        const stopped = !ok && task.status === "stopping";
        const errText = [msg.result, ...(msg.errors ?? [])].filter(Boolean).join("\n");
        if (!ok && !stopped && AUTH_TEXT.test(errText)) this.authRequired(task, errText);
        if (!ok && !stopped) task.lastResultError = true;
        // turnDone: Claude đã trả lời xong lượt này (phiên có thể còn mở vì lệnh nền).
        this.updateTask(task, { costUsd: (task.costUsd ?? 0) + (msg.total_cost_usd ?? 0), turnDone: true });
        this.endInputIfIdle(task);
        this.push(task, {
          kind: "result",
          ok,
          stopped,
          text: ok || stopped ? "" : (msg.errors?.join("\n") || msg.result || msg.subtype),
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
          turns: msg.num_turns,
        });
        break;
      }
    }
  }

  // Prompt cache: lượt sau trong thời hạn cache đọc lại ngữ cảnh rẻ & nhanh hơn.
  trackCache(task, usage) {
    if (!usage) return;
    const c = usage.cache_creation;
    const ttl = c?.ephemeral_1h_input_tokens > 0 ? 3600 : c?.ephemeral_5m_input_tokens > 0 ? 300 : (task.cacheTtl ?? 3600);
    task.cacheAt = Date.now();
    task.cacheTtl = ttl;
  }

  // Đo ngữ cảnh đang dùng (chỉ đo được khi phiên còn mở). Mỗi task chỉ một lượt đo cùng lúc.
  refreshContext(task) {
    const q = this.running.get(task.id);
    if (!q) return;
    if (this.ctxPending.has(task.id)) return void this.ctxPending.set(task.id, true);
    this.ctxPending.set(task.id, false);
    const started = Date.now();
    q.getContextUsage({ detail: "summary" })
      .then((c) => {
        if ((task.compactAt ?? 0) >= started) return;
        const limit = c.isAutoCompactEnabled && c.autoCompactThreshold ? c.autoCompactThreshold : c.rawMaxTokens;
        this.updateTask(task, { context: { used: c.totalTokens, limit, max: c.rawMaxTokens, auto: !!c.isAutoCompactEnabled } });
      })
      .catch(() => {})
      .finally(() => {
        const again = this.ctxPending.get(task.id);
        this.ctxPending.delete(task.id);
        if (again) this.refreshContext(task);
      });
  }

  // Task đang nghỉ: mở lại phiên (không gửi prompt) chỉ để đo ngữ cảnh, rồi đóng.
  async peekContext(taskId) {
    const task = this.store.task(taskId);
    const project = task && this.store.project(task.projectId);
    if (!task?.sessionId || !project || this.running.has(taskId) || this.peeking?.has(taskId)) return;
    (this.peeking ??= new Set()).add(taskId);
    async function* idle() {
      await new Promise(() => {});
    }
    const q = query({
      prompt: idle(),
      options: {
        cwd: project.path,
        resume: task.sessionId,
        pathToClaudeCodeExecutable: claudeBin(this.store.settings.claudePath),
        model: task.model && task.model !== "default" ? task.model : undefined,
        settingSources: ["user", "project", "local"],
      },
    });
    try {
      const c = await q.getContextUsage({ detail: "summary" });
      if (this.running.has(taskId)) return;
      const limit = c.isAutoCompactEnabled && c.autoCompactThreshold ? c.autoCompactThreshold : c.rawMaxTokens;
      this.updateTask(task, { context: { used: c.totalTokens, limit, max: c.rawMaxTokens, auto: !!c.isAutoCompactEnabled } });
    } catch {
    } finally {
      this.peeking.delete(taskId);
      q.close();
    }
  }

  // Danh sách model + slash command (gồm skill của project). Mở một phiên claude
  // không gửi prompt, đọc thông tin rồi đóng ngay. Cache theo project.
  async meta(projectId) {
    const project = this.store.project(projectId);
    const key = projectId ?? "_";
    const hit = this.metaCache?.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
    async function* idle() {
      await new Promise(() => {});
    }
    const q = query({
      prompt: idle(),
      options: {
        cwd: project?.path,
        pathToClaudeCodeExecutable: claudeBin(this.store.settings.claudePath),
        settingSources: ["user", "project", "local"],
      },
    });
    try {
      const [models, commands] = await Promise.all([q.supportedModels(), q.supportedCommands()]);
      const data = {
        models: models.map((m) => ({ value: m.value, name: m.displayName, description: m.description, efforts: m.supportedEffortLevels ?? [] })),
        commands: commands.map((c) => ({ name: c.name, description: c.description, hint: c.argumentHint })),
      };
      (this.metaCache ??= new Map()).set(key, { at: Date.now(), data });
      return data;
    } finally {
      q.close();
    }
  }

  authRequired(task, reason) {
    this.emit("auth:required", { taskId: task.id, reason: String(reason).slice(0, 300) });
  }

  askPermission(task, toolName, input, { signal, suggestions, toolUseID }) {
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const isQuestion = toolName === "AskUserQuestion";
      this.pending.set(requestId, { taskId: task.id, resolve, suggestions, input, isQuestion });
      if (isQuestion) {
        // Claude hỏi người dùng chọn phương án: hiện các lựa chọn, chờ trả lời.
        this.push(task, { kind: "question", requestId, toolUseId: toolUseID, questions: input.questions ?? [], state: "pending" });
      } else {
        this.push(task, { kind: "permission", requestId, toolUseId: toolUseID, name: toolName, input, state: "pending" });
      }
      this.updateTask(task, { status: "waiting", waitingFor: isQuestion ? "question" : "permission" });
      this.emit("task:needs-approval", { taskId: task.id, toolName, question: isQuestion });
      signal?.addEventListener("abort", () => this.respond(requestId, "deny"));
    });
  }

  // Trả lời câu hỏi AskUserQuestion. answers: { [câu hỏi]: "nhãn" } (nhiều lựa chọn cách nhau dấu phẩy).
  answer(requestId, answers) {
    const p = this.pending.get(requestId);
    if (!p?.isQuestion) return;
    this.pending.delete(requestId);
    p.resolve({ behavior: "allow", updatedInput: { ...p.input, answers } });
    this.settle(p.taskId, requestId, { state: "answered", answers });
  }

  // decision: "allow" | "always" | "deny"
  respond(requestId, decision) {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    const task = this.store.task(p.taskId);

    if (decision === "deny") {
      p.resolve({ behavior: "deny", message: p.isQuestion ? "Người dùng bỏ qua câu hỏi." : "Người dùng từ chối." });
      if (task && task.status !== "stopping" && !p.isQuestion) task.warnings = (task.warnings ?? 0) + 1;
    } else {
      p.resolve({
        behavior: "allow",
        updatedInput: p.input,
        updatedPermissions: decision === "always" ? p.suggestions : undefined,
      });
    }

    this.settle(p.taskId, requestId, { state: decision === "deny" ? (p.isQuestion ? "skipped" : "denied") : "allowed" });
  }

  // Cập nhật entry trong log sau khi người dùng trả lời; hết việc chờ thì về "running".
  settle(taskId, requestId, patch) {
    const task = this.store.task(taskId);
    if (!task) return;
    const entry = this.store.log(task.id).find((e) => e.requestId === requestId);
    if (entry) {
      Object.assign(entry, patch);
      this.store.saveLog(task.id);
      this.emit("task:entry", { taskId: task.id, entry });
    }
    const stillWaiting = [...this.pending.values()].some((x) => x.taskId === task.id);
    if (!stillWaiting && task.status === "waiting") this.updateTask(task, { status: "running", waitingFor: null });
  }

  // Xong lượt và không còn lệnh nền: đóng luồng nhập để phiên tự kết thúc (prompt gửi sau đó chạy ở phiên tiếp theo).
  // Còn lệnh nền thì để mở: prompt nhắn thêm tới Claude ngay, không phải chờ lệnh nền chạy xong.
  endInputIfIdle(task) {
    if (task.turnDone && !this.bgTasks.get(task.id)?.size) this.inputs.get(task.id)?.end();
  }

  rejectPending(taskId) {
    for (const [id, p] of this.pending) {
      if (p.taskId === taskId) this.respond(id, "deny");
    }
  }

  async stop(taskId) {
    const task = this.store.task(taskId);
    const qi = this.queue.findIndex((q) => q.taskId === taskId);
    if (qi >= 0 && task) {
      this.queue.splice(qi, 1);
      this.updateTask(task, { status: "stopped" });
      this.emit("task:finished", { taskId, status: "stopped" });
      return;
    }
    const q = this.running.get(taskId);
    if (!q || !task) return;
    // Dừng: prompt chưa được Claude đọc sẽ không gửi nữa.
    const dropped = [...(this.followups.get(taskId) ?? []), ...(this.inflight.get(taskId)?.values() ?? [])];
    this.setDelivery(task, dropped.map((f) => f.entryId), "cancelled");
    this.inflight.get(taskId)?.clear();
    this.followups.delete(taskId);
    this.inputs.get(taskId)?.end();
    if (task.status === "stopping") return this.kill(taskId); // bấm Dừng lần nữa: tắt ngay
    const idle = task.turnDone; // Claude đã trả lời xong, phiên chỉ còn mở vì lệnh nền
    this.updateTask(task, { status: "stopping" });
    this.rejectPending(taskId);
    if (idle) return this.kill(taskId);
    // Đang giữa lượt: ngắt lượt trước (giữ được phiên để nhắn tiếp);
    // quá 3 giây chưa dừng (vd. lệnh dài đang chạy) thì tắt hẳn.
    setTimeout(() => this.running.get(taskId) === q && this.kill(taskId), 3000);
    try {
      await q.interrupt();
    } catch {
      this.kill(taskId);
    }
  }

  // Tắt tiến trình claude của task (SIGTERM, 2 giây sau chưa thoát thì SIGKILL).
  // claude tự dọn các lệnh nền của nó khi nhận SIGTERM.
  // sync: lúc thoát app trên Windows phải tắt xong cả cây tiến trình trước khi app đóng,
  // không thì tiến trình con còn sót giữ file trong thư mục cài đặt (gỡ cài đặt bị kẹt).
  kill(taskId, sync = false) {
    const child = this.procs.get(taskId);
    if (!child || child.exitCode != null) return this.running.get(taskId)?.close?.();
    if (IS_WIN) {
      const args = ["/pid", String(child.pid), "/T", "/F"];
      if (!sync) return void execFile("taskkill", args, { windowsHide: true }, () => {});
      try {
        execFileSync("taskkill", args, { windowsHide: true, stdio: "ignore", timeout: 5000 });
      } catch {}
      return;
    }
    const signal = (sig) => {
      try {
        process.kill(-child.pid, sig); // cả nhóm tiến trình
      } catch {
        try {
          child.kill(sig);
        } catch {}
      }
    };
    signal("SIGTERM");
    setTimeout(() => child.exitCode == null && child.signalCode == null && signal("SIGKILL"), 2000);
  }

  deleteTask(taskId) {
    this.stop(taskId);
    const i = this.store.tasks.findIndex((t) => t.id === taskId);
    if (i >= 0) this.store.tasks.splice(i, 1);
    this.store.deleteLog(taskId);
    this.store.save();
  }

  stopAll() {
    for (const taskId of [...this.running.keys()]) this.kill(taskId, true);
  }
}
