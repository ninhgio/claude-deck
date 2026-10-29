import electron from "electron";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Store } from "./store.js";
import { AgentManager, checkClaude, claudeBin, resetClaudeDetection } from "./agent.js";
import { TerminalManager } from "./terminals.js";
import { PmClient } from "./pm.js";

const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, protocol, safeStorage, shell } = electron;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;

// App mở từ Finder/Dock không có PATH của shell, nên Claude sẽ không thấy
// git, node, brew... Lấy PATH từ login shell của người dùng, cùng các biến cấu hình
// Claude (token, base URL, proxy) mà người dùng export trong .zshrc/.bashrc.
const SHELL_ENV = /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|HTTPS?_PROXY$|NO_PROXY$)/i;
function loadShellPath() {
  if (IS_WIN) return; // Windows: app đã có PATH và biến môi trường của hệ thống
  try {
    const shellBin = process.env.SHELL || "/bin/zsh";
    const out = execFileSync(shellBin, ["-ilc", "printf '\\0__ENV__\\0'; env -0"], { encoding: "utf8", timeout: 5000 });
    const vars = out.split("\0__ENV__\0").pop().split("\0");
    for (const line of vars) {
      const i = line.indexOf("=");
      if (i <= 0) continue;
      const key = line.slice(0, i);
      if (key === "PATH" || (SHELL_ENV.test(key) && process.env[key] === undefined)) process.env[key] = line.slice(i + 1);
    }
  } catch {}
}
loadShellPath();

// Token Claude nhập trong app (cho người không có tài khoản claude.ai, dùng token được cấp):
// mã hoá bằng Keychain, nạp vào biến môi trường để mọi tiến trình claude dùng chung.
const CLAUDE_TOKEN_VARS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
const baseEnv = Object.fromEntries([...CLAUDE_TOKEN_VARS, "ANTHROPIC_BASE_URL"].map((k) => [k, process.env[k]]));
function readClaudeToken() {
  const enc = store.settings.claudeTokenEnc;
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, "base64"));
  } catch {
    return null;
  }
}
function claudeTokenEnv(kind, token, baseUrl) {
  const env = { ...baseEnv };
  if (token) {
    for (const k of CLAUDE_TOKEN_VARS) env[k] = undefined; // token trong app thay hẳn token từ shell
    env[kind] = token;
    env.ANTHROPIC_BASE_URL = baseUrl || undefined;
  }
  return env;
}
// Môi trường hiện tại + thay đổi (undefined = bỏ biến đó, để token cũ từ shell không lấn token mới).
function mergeEnv(patch) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}
function applyClaudeToken() {
  const s = store.settings;
  const env = claudeTokenEnv(s.claudeTokenKind, readClaudeToken(), s.claudeBaseUrl);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// Bản cũ tên "IDE Claude" lưu dữ liệu ở thư mục khác: chép sang lần đầu chạy ClaudeDeck.
function migrateOldData() {
  const oldDir = path.join(app.getPath("appData"), "IDE Claude");
  const newDir = app.getPath("userData");
  if (!fs.existsSync(path.join(oldDir, "data.json")) || fs.existsSync(path.join(newDir, "data.json"))) return;
  fs.mkdirSync(newDir, { recursive: true });
  for (const name of ["data.json", "logs"]) {
    const src = path.join(oldDir, name);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(newDir, name), { recursive: true });
  }
}
migrateOldData();

let win;
const store = new Store(app.getPath("userData"));
const send = (channel, payload) => win?.webContents.send(channel, payload);

const notify = (title, body) => {
  if (win?.isFocused()) return;
  new Notification({ title, body }).show();
};

const agents = new AgentManager(store, (channel, payload) => {
  send(channel, payload);
  const task = payload?.taskId && store.task(payload.taskId);
  if (!task) return;
  const projectName = store.project(task.projectId)?.name ?? "";
  if (channel === "auth:required") {
    authState.required = true;
    notify("Claude cần đăng nhập lại", "Một task bị dừng vì lỗi xác thực.");
    refreshAuth();
    return;
  }
  if (channel === "task:needs-approval") {
    notify(
      payload.question ? `${projectName}: Claude đang hỏi bạn` : `${projectName}: cần duyệt`,
      payload.question ? task.title : `${payload.toolName} — ${task.title}`,
    );
    app.dock?.bounce("informational");
  } else if (channel === "task:finished" && payload.status !== "stopped") {
    notify(`${projectName}: ${payload.status === "done" ? "xong" : "lỗi"}`, task.title);
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    autoHideMenuBar: process.platform !== "darwin",
    backgroundColor: "#1a1a1a",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadURL("app://bundle/src/renderer/index.html");
  win.on("closed", () => (win = null));
  // Không bao giờ để cửa sổ app điều hướng sang trang khác; link https mở bằng trình duyệt.
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("app://bundle/")) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

const taskMeta = (task) => ({ ...task });

ipcMain.handle("state:get", () => ({
  projects: store.projects,
  groups: store.groups,
  tasks: store.tasks.map(taskMeta),
  settings: publicSettings(),
  appVersion: APP_VERSION,
}));

ipcMain.handle("settings:set", (_e, patch) => {
  if (patch.maxConcurrent != null) agents.setMaxConcurrent(Number(patch.maxConcurrent));
  if (patch.claudePath !== undefined) {
    const p = patch.claudePath?.trim();
    if (p) store.settings.claudePath = p;
    else delete store.settings.claudePath;
    store.save();
    resetClaudeDetection();
    refreshAuth();
  }
  if (patch.pmShareEnv !== undefined) {
    store.settings.pmShareEnv = !!patch.pmShareEnv;
    store.save();
  }
  // Project trên PM -> project trong app để bấm "Xử lý" ở Dashboard.
  if (patch.pmProjectMap) {
    const map = { ...store.settings.pmProjectMap };
    for (const [k, v] of Object.entries(patch.pmProjectMap)) {
      if (v) map[k] = v;
      else delete map[k];
    }
    store.settings.pmProjectMap = map;
    store.save();
  }
  return publicSettings();
});
ipcMain.handle("claude:check", (_e, customPath) => checkClaude(customPath));

// Thử token bằng một lượt hỏi nhỏ thật (`claude auth status` chỉ xem có token, không biết token còn dùng được không).
function testClaudeToken(env) {
  if (!hasClaude()) return Promise.resolve({ error: "Không tìm thấy Claude Code trên máy." });
  return new Promise((resolve) => {
    execFile(
      claude(),
      ["-p", "Reply with exactly: OK", "--output-format", "json", "--max-turns", "1", "--tools", ""],
      { env: mergeEnv(env), cwd: app.getPath("temp"), timeout: 90000, windowsHide: true },
      (err, stdout, stderr) => {
        let r = null;
        try {
          r = JSON.parse(stdout.trim().split("\n").pop());
        } catch {}
        if (r && !r.is_error) return resolve({ ok: true });
        const msg = r?.result || r?.errors?.join("\n") || stderr?.trim() || err?.message || "Không gọi được Claude";
        resolve({ error: String(msg).slice(0, 400) });
      },
    );
  });
}

// kind: biến môi trường của token; token null = xoá token trong app.
ipcMain.handle("claude-token:set", async (_e, { kind, token, baseUrl } = {}) => {
  const s = store.settings;
  baseUrl = baseUrl?.trim() || null;
  token = token?.trim() || null;
  if (!CLAUDE_TOKEN_VARS.includes(kind)) kind = "ANTHROPIC_AUTH_TOKEN";
  const use = token ?? readClaudeToken(); // để trống ô token = giữ token đã lưu (đổi loại/base URL)
  if (!use) return { error: "Nhập token.", settings: publicSettings() };
  const test = await testClaudeToken(claudeTokenEnv(kind, use, baseUrl));
  if (test.error) return { error: test.error, settings: publicSettings() };
  s.claudeTokenEnc = safeStorage.encryptString(use).toString("base64");
  s.claudeTokenKind = kind;
  if (baseUrl) s.claudeBaseUrl = baseUrl;
  else delete s.claudeBaseUrl;
  store.save();
  applyClaudeToken();
  await refreshAuth();
  if (authState.status?.loggedIn) authState.required = false;
  sendAuth();
  return { ok: true, settings: publicSettings() };
});
ipcMain.handle("claude-token:clear", async () => {
  const s = store.settings;
  delete s.claudeTokenEnc;
  delete s.claudeTokenKind;
  delete s.claudeBaseUrl;
  store.save();
  applyClaudeToken();
  await refreshAuth();
  sendAuth();
  return publicSettings();
});

// Token PM chỉ nằm ở main process (mã hoá bằng Keychain), không gửi sang giao diện.
function publicSettings() {
  const { pmTokenEnc, pmRefreshEnc, claudeTokenEnc, ...rest } = store.settings;
  return { ...rest, hasClaudeToken: !!claudeTokenEnc };
}

ipcMain.handle("pm:get", () => pm.state());
ipcMain.handle("pm:refresh", () => pm.refresh());
ipcMain.handle("pm:set-token", (_e, token) => pm.setToken(token));
ipcMain.handle("pm:login", (_e, { email, password } = {}) => pm.login(email, password));

ipcMain.handle("project:add", async (_e, opts = {}) => {
  const res = await dialog.showOpenDialog(win, {
    title: "Chọn thư mục project",
    properties: ["openDirectory", "multiSelections"],
  });
  if (res.canceled) return [];
  const added = [];
  for (const dir of res.filePaths) {
    if (store.projects.some((p) => p.path === dir)) continue;
    const project = { id: randomUUID(), name: path.basename(dir), path: dir, groupId: opts?.groupId ?? null };
    store.projects.push(project);
    added.push(project);
  }
  store.save();
  return added;
});

// ---------- Nhóm project (chỉ để sắp xếp sidebar) ----------

ipcMain.handle("group:create", (_e, { name, icon } = {}) => {
  const group = { id: randomUUID(), name: String(name || "Nhóm mới").trim().slice(0, 80), icon: String(icon || "📁").slice(0, 8), collapsed: false };
  store.groups.push(group);
  store.save();
  return group;
});

ipcMain.handle("group:update", (_e, { id, ...patch }) => {
  const g = store.groups.find((x) => x.id === id);
  if (!g) return;
  if (typeof patch.name === "string" && patch.name.trim()) g.name = patch.name.trim().slice(0, 80);
  if (typeof patch.collapsed === "boolean") g.collapsed = patch.collapsed;
  if (typeof patch.icon === "string" && patch.icon) g.icon = patch.icon.slice(0, 8);
  store.save();
});

// Xoá nhóm: project trong nhóm chuyển ra ngoài, không bị xoá.
ipcMain.handle("group:delete", (_e, id) => {
  store.data.groups = store.groups.filter((g) => g.id !== id);
  for (const p of store.projects) if (p.groupId === id) p.groupId = null;
  store.save();
});

// Chuyển project vào nhóm (groupId null = ra ngoài), đặt trước project `beforeId` nếu có.
ipcMain.handle("project:move", (_e, { id, groupId, beforeId }) => {
  const i = store.projects.findIndex((p) => p.id === id);
  if (i < 0) return;
  const [p] = store.projects.splice(i, 1);
  p.groupId = groupId && store.groups.some((g) => g.id === groupId) ? groupId : null;
  const j = beforeId ? store.projects.findIndex((x) => x.id === beforeId) : -1;
  if (j >= 0) store.projects.splice(j, 0, p);
  else store.projects.push(p);
  store.save();
});

// Ghim project lên đầu sidebar (tối đa 5). pinnedAt giữ thứ tự ghim.
const MAX_PINNED = 5;
ipcMain.handle("project:pin", (_e, { id, pinned }) => {
  const p = store.project(id);
  if (!p) return { error: "Không tìm thấy project" };
  if (pinned && !p.pinnedAt) {
    if (store.projects.filter((x) => x.pinnedAt).length >= MAX_PINNED) return { error: `Chỉ ghim được tối đa ${MAX_PINNED} project.` };
    p.pinnedAt = Date.now();
  } else if (!pinned) delete p.pinnedAt;
  store.save();
  return { ok: true, pinnedAt: p.pinnedAt ?? null };
});

ipcMain.handle("project:rename", (_e, { id, name }) => {
  const p = store.project(id);
  if (p && name.trim()) p.name = name.trim();
  store.save();
});

ipcMain.handle("project:remove", (_e, id) => {
  terminals.killProject(id);
  for (const t of store.tasks.filter((t) => t.projectId === id)) agents.deleteTask(t.id);
  store.data.projects = store.projects.filter((p) => p.id !== id);
  store.save();
});

ipcMain.handle("project:open", (_e, { id, app: target }) => {
  const p = store.project(id);
  if (!p) return;
  if (target === "finder") shell.openPath(p.path);
  else if (target === "vscode") openInVSCode(p.path);
  else if (target === "terminal") {
    if (IS_WIN) spawn("cmd.exe", ["/c", "start", "powershell.exe"], { cwd: p.path, detached: true, stdio: "ignore" }).unref();
    else execFileSync("open", ["-a", "Terminal", p.path]);
  }
});

// ---------- Terminal ----------

const terminals = new TerminalManager(send);
const pm = new PmClient(store, app.getPath("userData"), send);
// Bật trong Cài đặt: task Claude nhận token PM qua biến môi trường để skill gọi API PM.
agents.extraEnv = () => (store.settings.pmShareEnv ? pm.env() : {});

ipcMain.handle("term:create", (_e, { projectId, cols, rows }) => {
  const p = store.project(projectId);
  if (!p) return null;
  try {
    return terminals.create({ projectId, cwd: fs.existsSync(p.path) ? p.path : app.getPath("home"), cols, rows });
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
});
ipcMain.on("term:write", (_e, { id, data }) => terminals.write(id, data));
ipcMain.on("term:resize", (_e, { id, cols, rows }) => terminals.resize(id, cols, rows));
ipcMain.handle("term:kill", (_e, id) => terminals.kill(id));

// ---------- Git ----------

const git = (cwd, args) =>
  new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });

// git@gitlab.com:group/repo.git | https://gitlab.com/group/repo.git -> https://gitlab.com/group/repo
function remoteWebUrl(url) {
  if (!url) return null;
  url = url.trim().replace(/\.git$/, "");
  const ssh = url.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  if (/^https?:\/\//.test(url)) return url.replace(/\/\/[^@/]+@/, "//");
  return null;
}

ipcMain.handle("git:status", async (_e, projectId) => {
  const p = store.project(projectId);
  if (!p) return null;
  const out = await git(p.path, ["status", "--porcelain=v2", "--branch"]);
  if (out == null) return null; // không phải repo git
  const st = { branch: null, detached: false, ahead: 0, behind: 0, upstream: null, changed: 0, staged: 0, untracked: 0, conflicts: 0 };
  for (const line of out.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      st.branch = line.slice(14);
      if (st.branch === "(detached)") st.detached = true;
    } else if (line.startsWith("# branch.upstream ")) st.upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) {
      const [a, b] = line.slice(12).split(" ");
      st.ahead = Math.abs(Number(a));
      st.behind = Math.abs(Number(b));
    } else if (line.startsWith("? ")) st.untracked++;
    else if (line.startsWith("u ")) st.conflicts++;
    else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.slice(2, 4);
      if (xy[0] !== ".") st.staged++;
      if (xy[1] !== ".") st.changed++;
    }
  }
  if (st.detached) st.branch = ((await git(p.path, ["rev-parse", "--short", "HEAD"])) ?? "").trim() || "HEAD";
  const remote = (await git(p.path, ["remote", "get-url", "origin"]))?.trim() ?? null;
  st.remoteUrl = remoteWebUrl(remote);
  const host = st.remoteUrl ? new URL(st.remoteUrl).hostname : "";
  st.provider = /gitlab/i.test(host) ? "gitlab" : /github/i.test(host) ? "github" : /bitbucket/i.test(host) ? "bitbucket" : remote ? "git" : null;
  return st;
});

// Trạng thái git từng file cho Explorer (kiểu WebStorm). Đường dẫn trả về tương đối với thư mục project
// (project có thể là thư mục con của repo).
// code: "M" đã sửa/đã add/đổi tên, "?" chưa git add, "U" xung đột, "!" bị ignore.
ipcMain.handle("git:files", async (_e, projectId) => {
  const p = store.project(projectId);
  if (!p) return null;
  const [changes, ignored, prefixOut] = await Promise.all([
    git(p.path, ["status", "--porcelain=v1", "-z", "-uall", "--", "."]),
    git(p.path, ["status", "--porcelain=v1", "-z", "--ignored=traditional", "-unormal", "--", "."]),
    git(p.path, ["rev-parse", "--show-prefix"]),
  ]);
  if (changes == null) return null; // không phải repo git
  const prefix = (prefixOut ?? "").trim();
  const rel = (f) => (prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f);
  const files = {};
  const parts = changes.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const file = rel(entry.slice(3));
    if (x === "R" || x === "C") i++; // bản ghi đổi tên có thêm đường dẫn cũ ở phần tử sau
    let code;
    if (x === "?" && y === "?") code = "?";
    else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) code = "U";
    else if (x === "D" || y === "D") continue; // file đã xoá: không còn trong cây
    else code = "M";
    files[file] = code;
  }
  const ignoredPaths = [];
  for (const entry of (ignored ?? "").split("\0")) {
    if (entry.startsWith("!! ")) ignoredPaths.push(rel(entry.slice(3)));
  }
  return { files, ignored: ignoredPaths };
});

ipcMain.handle("open:url", (_e, url) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
});

// ---------- File đính kèm ----------

const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const MAX_IMAGE_SIDE = 1568; // ảnh lớn hơn thì thu nhỏ trước khi gửi cho model

// Ảnh -> base64 (thu nhỏ nếu cần) + thumbnail để hiện trong app.
function imageAttachment(img, name, mediaType, rawBuf) {
  if (img.isEmpty()) return null;
  let out = img;
  const { width, height } = img.getSize();
  if (Math.max(width, height) > MAX_IMAGE_SIDE) {
    out = img.resize(width >= height ? { width: MAX_IMAGE_SIDE } : { height: MAX_IMAGE_SIDE }, { quality: "best" });
  }
  // GIF/WebP giữ nguyên khi không phải thu nhỏ; còn lại xuất PNG/JPEG.
  let data;
  if (out === img && rawBuf && (mediaType === "image/gif" || mediaType === "image/webp" || mediaType === "image/png" || mediaType === "image/jpeg")) {
    data = rawBuf.toString("base64");
  } else if (mediaType === "image/jpeg") {
    data = out.toJPEG(88).toString("base64");
  } else {
    data = out.toPNG().toString("base64");
    mediaType = "image/png";
  }
  const thumb = img.resize({ height: 96, quality: "good" }).toJPEG(80).toString("base64");
  return { kind: "image", name, mediaType, data, thumb: `data:image/jpeg;base64,${thumb}` };
}

async function attachmentFromPath(p) {
  const ext = path.extname(p).slice(1).toLowerCase();
  const name = path.basename(p);
  try {
    const st = await fs.promises.stat(p);
    if (st.isDirectory()) return { kind: "file", name: name + "/", path: p };
    if (IMAGE_TYPES[ext] && st.size < 30 * 1024 * 1024) {
      const buf = await fs.promises.readFile(p);
      const img = imageAttachment(nativeImage.createFromBuffer(buf), name, IMAGE_TYPES[ext], buf);
      if (img) return { ...img, path: p };
    }
    return { kind: "file", name, path: p };
  } catch {
    return null;
  }
}

ipcMain.handle("attach:pick", async () => {
  const res = await dialog.showOpenDialog(win, { title: "Đính kèm file", properties: ["openFile", "multiSelections"] });
  if (res.canceled) return [];
  return (await Promise.all(res.filePaths.map(attachmentFromPath))).filter(Boolean);
});

ipcMain.handle("attach:paths", async (_e, paths) => (await Promise.all((paths ?? []).map(attachmentFromPath))).filter(Boolean));

// Ảnh dán từ clipboard (screenshot…).
ipcMain.handle("attach:image-data", (_e, { name, type, bytes }) => {
  const buf = Buffer.from(bytes);
  return imageAttachment(nativeImage.createFromBuffer(buf), name || "Ảnh dán.png", type || "image/png", buf);
});

// Danh sách file của project cho @mention: git ls-files nếu là repo, không thì duyệt thư mục.
const fileIndex = new Map(); // projectId -> { at, files }
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".nuxt", ".cache", "coverage", "vendor", "__pycache__", ".venv", ".idea"]);

async function listProjectFiles(projectId) {
  const p = store.project(projectId);
  if (!p) return [];
  const hit = fileIndex.get(projectId);
  if (hit && Date.now() - hit.at < 30000) return hit.files;
  let files = (await git(p.path, ["ls-files", "-co", "--exclude-standard"]))?.split("\n").filter(Boolean);
  if (!files) {
    files = [];
    const walk = async (dir, rel) => {
      if (files.length > 20000) return;
      let entries = [];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {}
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
        } else files.push(rel ? `${rel}/${e.name}` : e.name);
      }
    };
    await walk(p.path, "");
  }
  fileIndex.set(projectId, { at: Date.now(), files });
  return files;
}

ipcMain.handle("fs:search", async (_e, { projectId, q }) => {
  const files = await listProjectFiles(projectId);
  q = (q ?? "").toLowerCase();
  if (!q) return files.slice(0, 50);
  // Ưu tiên khớp tên file, rồi khớp đường dẫn; đường dẫn ngắn hơn đứng trước.
  const scored = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let score = -1;
    if (base.startsWith(q)) score = 3;
    else if (base.includes(q)) score = 2;
    else if (lower.includes(q)) score = 1;
    if (score >= 0) scored.push([score, f]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].length - b[1].length);
  return scored.slice(0, 50).map((x) => x[1]);
});

// Tìm theo nội dung: quét file văn bản của project (bỏ file nhị phân / > 1MB / bị .gitignore).
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|icns|bmp|tiff?|pdf|zip|gz|tgz|7z|rar|jar|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|wav|ogg|dmg|exe|dll|so|dylib|node|bin|psd|sketch|sqlite|db)$/i;
let grepSeq = 0;
ipcMain.handle("fs:grep", async (_e, { projectId, q }) => {
  const p = store.project(projectId);
  const needle = (q ?? "").toLowerCase();
  if (!p || needle.trim().length < 2) return { files: [], truncated: false };
  const seq = ++grepSeq; // lần tìm mới hơn thì bỏ lần cũ
  const files = (await listProjectFiles(projectId)).filter((f) => !BINARY_EXT.test(f));
  const out = [];
  let total = 0;
  let truncated = false;
  const started = Date.now();
  const scan = async (rel) => {
    const abs = path.join(p.path, rel);
    try {
      const st = await fs.promises.stat(abs);
      if (!st.isFile() || st.size > 1024 * 1024) return;
      const buf = await fs.promises.readFile(abs);
      if (buf.subarray(0, 8000).includes(0)) return; // nhị phân
      const text = buf.toString("utf8");
      if (!text.toLowerCase().includes(needle)) return;
      const hits = [];
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < 20; i++) {
        const col = lines[i].toLowerCase().indexOf(needle);
        if (col < 0) continue;
        // Cắt bớt dòng dài, giữ đoạn quanh chỗ khớp.
        const from = Math.max(0, col - 60);
        hits.push({ line: i + 1, col: col + 1, text: lines[i].slice(from, from + 220), at: col - from });
      }
      total += hits.length;
      out.push({ rel, hits });
    } catch {}
  };
  for (let i = 0; i < files.length; i += 32) {
    if (seq !== grepSeq) return { files: [], truncated: false, stale: true };
    if (total >= 500 || Date.now() - started > 4000) {
      truncated = true;
      break;
    }
    await Promise.all(files.slice(i, i + 32).map(scan));
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files: out, truncated };
});

// ---------- Explorer ----------

const HIDDEN = new Set([".git", ".DS_Store"]);

// Đường dẫn tuyệt đối của rel trong project, chặn thoát ra ngoài thư mục project.
function projectFile(projectId, rel = "") {
  const p = store.project(projectId);
  if (!p) return null;
  const abs = path.resolve(p.path, rel);
  if (abs !== p.path && !abs.startsWith(p.path + path.sep)) return null;
  return abs;
}

ipcMain.handle("fs:list", async (_e, { projectId, rel }) => {
  const dir = projectFile(projectId, rel);
  if (!dir) return [];
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries
      .filter((d) => !HIDDEN.has(d.name))
      .map((d) => ({ name: d.name, dir: d.isDirectory() }))
      .sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name, undefined, { numeric: true }));
  } catch {
    return [];
  }
});

const MAX_EDIT_SIZE = 5 * 1024 * 1024;

ipcMain.handle("fs:read", async (_e, { projectId, rel }) => {
  const abs = projectFile(projectId, rel);
  if (!abs) return { error: "Đường dẫn không hợp lệ" };
  try {
    const st = await fs.promises.stat(abs);
    if (st.size > MAX_EDIT_SIZE) return { error: "File lớn hơn 5MB", tooLarge: true };
    const buf = await fs.promises.readFile(abs);
    // Có byte 0 trong 8KB đầu thì coi là file nhị phân (ảnh, binary…).
    if (buf.subarray(0, 8192).includes(0)) return { binary: true };
    return { content: buf.toString("utf8"), abs, mtime: st.mtimeMs };
  } catch (err) {
    return { error: String(err.message) };
  }
});

ipcMain.handle("fs:write", async (_e, { projectId, rel, content }) => {
  const abs = projectFile(projectId, rel);
  if (!abs) return { error: "Đường dẫn không hợp lệ" };
  try {
    await fs.promises.writeFile(abs, content, "utf8");
    return { ok: true, mtime: (await fs.promises.stat(abs)).mtimeMs };
  } catch (err) {
    return { error: String(err.message) };
  }
});

// Tên file/thư mục hợp lệ: không rỗng, không chứa ký tự cấm, không thoát ra ngoài project.
function checkNewPath(projectId, rel) {
  if (!rel || /[\0:]/.test(rel) || rel.split("/").some((part) => part === ".." || part === "")) return null;
  return projectFile(projectId, rel);
}

ipcMain.handle("fs:create", async (_e, { projectId, rel, dir }) => {
  const abs = checkNewPath(projectId, rel);
  if (!abs) return { error: "Tên không hợp lệ" };
  if (fs.existsSync(abs)) return { error: `"${rel}" đã tồn tại` };
  try {
    if (dir) await fs.promises.mkdir(abs, { recursive: true });
    else {
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, "", { flag: "wx" });
    }
    return { ok: true };
  } catch (err) {
    return { error: String(err.message) };
  }
});

ipcMain.handle("fs:rename", async (_e, { projectId, from, to }) => {
  const src = projectFile(projectId, from);
  const dst = checkNewPath(projectId, to);
  if (!src || !dst || src === store.project(projectId)?.path) return { error: "Tên không hợp lệ" };
  if (src === dst) return { ok: true };
  // Cho phép đổi hoa/thường (macOS không phân biệt) nhưng không ghi đè file khác.
  if (fs.existsSync(dst) && src.toLowerCase() !== dst.toLowerCase()) return { error: `"${to}" đã tồn tại` };
  try {
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.rename(src, dst);
    return { ok: true };
  } catch (err) {
    return { error: String(err.message) };
  }
});

// Xoá = chuyển vào Thùng rác của macOS (khôi phục được).
ipcMain.handle("fs:trash", async (_e, { projectId, rel }) => {
  const abs = projectFile(projectId, rel);
  if (!abs || abs === store.project(projectId)?.path) return { error: "Không thể xoá thư mục gốc của project" };
  try {
    await shell.trashItem(abs);
    return { ok: true };
  } catch (err) {
    return { error: String(err.message) };
  }
});

ipcMain.handle("fs:open", async (_e, { projectId, rel, target }) => {
  const abs = projectFile(projectId, rel);
  if (!abs) return;
  if (target === "finder") return shell.showItemInFolder(abs);
  openInVSCode(abs);
});

const CODE_CLI = IS_WIN
  ? [path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "bin", "code.cmd"), path.join(process.env.ProgramFiles ?? "", "Microsoft VS Code", "bin", "code.cmd")]
  : ["/opt/homebrew/bin/code", "/usr/local/bin/code", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"];

// CLI `code` tự mở file trong cửa sổ VSCode đang chứa project (nếu có).
function openInVSCode(target) {
  const code = CODE_CLI.find((c) => fs.existsSync(c));
  try {
    if (code && IS_WIN) spawn(code, [target], { shell: true, detached: true, stdio: "ignore", windowsHide: true }).unref();
    else if (code) execFileSync(code, [target]);
    else if (IS_WIN) spawn("code", [target], { shell: true, detached: true, stdio: "ignore", windowsHide: true }).unref();
    else execFileSync("open", ["-a", "Visual Studio Code", target]);
  } catch {
    shell.openPath(target);
  }
}

// ---------- Tài khoản Claude ----------

const claude = () => claudeBin(store.settings.claudePath) ?? "claude";
const hasClaude = () => !!claudeBin(store.settings.claudePath);
const MISSING = { loggedIn: false, missing: true, error: "Không tìm thấy Claude Code trên máy" };
const authState = { status: null, required: false, loggingIn: false, loginOutput: "" };
const sendAuth = () => send("auth:update", authState);

function refreshAuth() {
  if (!hasClaude()) {
    authState.status = MISSING;
    authState.required = true;
    sendAuth();
    return Promise.resolve(authState);
  }
  return new Promise((resolve) => {
    execFile(claude(), ["auth", "status", "--json"], { timeout: 20000 }, (err, stdout) => {
      try {
        authState.status = JSON.parse(stdout);
      } catch {
        authState.status = { loggedIn: false, error: String(err?.message ?? "Không đọc được trạng thái") };
      }
      if (!authState.status.loggedIn) authState.required = true;
      sendAuth();
      resolve(authState);
    });
  });
}

let loginProc = null;

// Chạy `claude auth login`: CLI tự mở trình duyệt; nếu không, mở URL nó in ra.
function startLogin({ console: useConsole } = {}) {
  if (loginProc) return;
  if (!hasClaude()) return refreshAuth();
  authState.loggingIn = true;
  authState.loginOutput = "";
  sendAuth();
  let opened = false;
  loginProc = spawn(claude(), ["auth", "login", useConsole ? "--console" : "--claudeai"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const onData = (buf) => {
    const text = buf.toString();
    authState.loginOutput = (authState.loginOutput + text).slice(-2000);
    const url = text.match(/https:\/\/\S+/)?.[0];
    if (url && !opened) {
      opened = true;
      shell.openExternal(url);
    }
    sendAuth();
  };
  loginProc.stdout.on("data", onData);
  loginProc.stderr.on("data", onData);
  // Không chạy được claude (vd. file bị xoá): báo lỗi thay vì làm sập app.
  const proc = loginProc;
  proc.on("error", (err) => {
    authState.loginOutput = String(err?.message ?? err);
    proc.emit("close");
  });
  proc.once("close", async () => {
    if (loginProc !== proc) return;
    loginProc = null;
    authState.loggingIn = false;
    await refreshAuth();
    if (authState.status?.loggedIn) authState.required = false;
    sendAuth();
  });
}

ipcMain.handle("auth:get", () => (authState.status ? authState : refreshAuth()));
ipcMain.handle("auth:refresh", async () => {
  await refreshAuth();
  if (authState.status?.loggedIn) authState.required = false;
  sendAuth();
  return authState;
});
ipcMain.handle("auth:login", (_e, opts) => startLogin(opts));
// Dán mã xác thực nếu trình duyệt hiện mã thay vì tự quay lại.
ipcMain.handle("auth:code", (_e, code) => loginProc?.stdin.write(code.trim() + "\n"));
ipcMain.handle("auth:cancel", () => loginProc?.kill());
ipcMain.handle("auth:logout", () => new Promise((resolve) => execFile(claude(), ["auth", "logout"], () => refreshAuth().then(resolve))));

ipcMain.handle("task:log", (_e, id) => {
  if (!store.task(id)) return [];
  const entries = store.log(id);
  // Task không chạy thì đọc xong bỏ khỏi RAM luôn.
  if (!agents.isBusy(id)) store.unloadLog(id);
  return entries;
});

ipcMain.handle("task:create", (_e, { projectId, prompt, permissionMode, model, effort, ultracode, web, attachments }) =>
  taskMeta(agents.createTask(projectId, prompt, permissionMode, { model, effort, ultracode: !!ultracode, web: !!web, attachments })),
);
ipcMain.handle("claude:meta", (_e, projectId) => agents.meta(projectId).catch((err) => ({ error: String(err?.message ?? err) })));

ipcMain.handle("task:rename", (_e, { taskId, title }) => {
  const t = store.task(taskId);
  if (t && title?.trim()) agents.updateTask(t, { title: title.trim().slice(0, 200) });
});
ipcMain.handle("task:send", (_e, { taskId, prompt, attachments, after }) => agents.send(taskId, prompt, attachments, { after }));
ipcMain.handle("task:stop", (_e, taskId) => agents.stop(taskId));
ipcMain.handle("task:delete", (_e, taskId) => agents.deleteTask(taskId));
ipcMain.handle("task:context", (_e, taskId) => agents.peekContext(taskId));
ipcMain.handle("task:set-mode", (_e, { taskId, ...patch }) => {
  const t = store.task(taskId);
  // Áp dụng từ lượt nhắn tiếp theo của task.
  const allowed = ["permissionMode", "model", "effort", "ultracode", "web"];
  if (t) agents.updateTask(t, Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k))));
});
ipcMain.handle("permission:respond", (_e, { requestId, decision }) => agents.respond(requestId, decision));
ipcMain.handle("question:answer", (_e, { requestId, answers }) => agents.answer(requestId, answers));

// Menu riêng: ⌘W đóng tab editor (thay vì đóng cửa sổ), ⌘S để editor tự xử lý.
function buildMenu() {
  const toRenderer = (channel) => () => send(channel);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
      {
        label: "File",
        submenu: [
          { label: "Lưu", accelerator: "CmdOrCtrl+S", click: toRenderer("menu:save") },
          { label: "Tìm file…", accelerator: "CmdOrCtrl+P", click: toRenderer("menu:search") },
          { label: "Tìm trong file…", accelerator: "CmdOrCtrl+Shift+F", click: toRenderer("menu:search") },
          { label: "Đóng tab", accelerator: "CmdOrCtrl+W", click: toRenderer("menu:close-tab") },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { label: "Bật/tắt Terminal", accelerator: "Ctrl+`", click: toRenderer("menu:toggle-terminal") },
          { type: "separator" },
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      process.platform === "darwin"
        ? { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] }
        : { label: "Window", submenu: [{ role: "minimize" }, { role: "quit", label: "Thoát" }] },
    ]),
  );
}

// Giao diện chạy qua app:// (thay vì file://) để Monaco tạo được web worker.
// Chỉ phục vụ file nằm trong thư mục app.
const APP_ROOT = path.join(__dirname, "..");
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

function registerAppProtocol() {
  protocol.handle("app", (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    const abs = path.normalize(path.join(APP_ROOT, rel));
    if (!abs.startsWith(APP_ROOT + path.sep)) return new Response("Forbidden", { status: 403 });
    return net.fetch(pathToFileURL(abs).toString());
  });
}

app.whenReady().then(() => {
  registerAppProtocol();
  buildMenu();
  createWindow();
  applyClaudeToken();
  refreshAuth();
  setInterval(refreshAuth, 10 * 60 * 1000);
  pm.start();
  app.on("browser-window-focus", () => {
    if (!loginProc) refreshAuth();
  });
});

app.on("activate", () => {
  if (!win) createWindow();
});

app.on("window-all-closed", () => {
  // Trên macOS giữ app chạy nền để task tiếp tục chạy.
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  loginProc?.kill();
  terminals.killAll();
  agents.stopAll();
  store.flush();
});
