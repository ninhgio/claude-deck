import electron from "electron";
import fs from "node:fs";
import path from "node:path";

const { safeStorage } = electron;

export const PM_URL = "https://project.aiservice.vn";
const API = process.env.CLAUDEDECK_PM_API || `${PM_URL}/api`; // biến môi trường chỉ để test
const REFRESH_MS = 60 * 60 * 1000; // tự kéo lại mỗi giờ

// Hạn của token (JWT) để báo trước khi hết hạn; token không phải JWT thì bỏ qua.
function tokenExpiry(token) {
  try {
    const exp = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).exp;
    return exp ? exp * 1000 : null;
  } catch {
    return null;
  }
}

// Gọn lại task từ /tasks/mine; chỉ giữ những gì dashboard cần.
function normalize(t) {
  const project = t.project ?? null;
  const code = t.code ?? null;
  return {
    id: t.id,
    code,
    title: t.title ?? t.name ?? code ?? "(không tên)",
    status: t.status?.name ?? (typeof t.status === "string" ? t.status : ""),
    statusColor: t.status?.color ?? null,
    category: t.status?.category ?? (typeof t.status === "string" ? t.status : null),
    priority: t.priority ?? null,
    typeId: t.taskTypeId ?? t.taskType?.id ?? null,
    type: t.taskType?.name ? { name: t.taskType.name, color: t.taskType.color ?? null } : null, // Loại công việc: Bug, Feature…
    endDate: t.endDate ?? t.dueDate ?? null,
    projectId: project?.id ?? t.projectId ?? null,
    projectName: project?.name ?? "Không có project",
    url: project?.key && code ? `${PM_URL}/projects/${project.key.toLowerCase()}/tasks?task=${code}` : PM_URL,
  };
}

// Kéo task "Cần làm" (TODO) của người dùng từ project.aiservice.vn về dashboard.
export class PmClient {
  constructor(store, dir, emit) {
    this.store = store;
    this.emit = emit;
    this.cacheFile = path.join(dir, "pm-cache.json");
    try {
      this.cache = JSON.parse(fs.readFileSync(this.cacheFile, "utf8"));
    } catch {
      this.cache = { tasks: [], fetchedAt: null, error: null };
    }
    this.loading = false;
  }

  decrypt(key) {
    const enc = this.store.settings[key];
    if (!enc) return null;
    try {
      return safeStorage.decryptString(Buffer.from(enc, "base64"));
    } catch {
      return null;
    }
  }

  token() {
    return this.decrypt("pmTokenEnc");
  }

  // Lưu cặp token (mã hoá bằng Keychain); không bao giờ lưu mật khẩu.
  saveTokens({ accessToken, refreshToken }, email) {
    const s = this.store.settings;
    if (accessToken) s.pmTokenEnc = safeStorage.encryptString(accessToken).toString("base64");
    else delete s.pmTokenEnc;
    if (refreshToken) s.pmRefreshEnc = safeStorage.encryptString(refreshToken).toString("base64");
    else if (!accessToken) delete s.pmRefreshEnc;
    if (email !== undefined) {
      if (email) s.pmEmail = email;
      else delete s.pmEmail;
    }
    this.store.save();
  }

  setToken(token) {
    token = token?.trim().replace(/^Bearer\s+/i, "") || null;
    this.saveTokens({ accessToken: token, refreshToken: null }, token ? this.store.settings.pmEmail ?? null : null);
    if (token) delete this.store.settings.pmRefreshEnc; // token dán tay không đi kèm refresh token
    this.store.save();
    if (!token) {
      this.cache = { tasks: [], fetchedAt: null, error: null };
      this.saveCache();
    }
    this.emit("pm:update", this.state());
    return token ? this.refresh() : this.state();
  }

  async login(email, password) {
    email = String(email ?? "").trim();
    if (!email || !password) return { error: "Nhập email và mật khẩu." };
    let res, body;
    try {
      res = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      body = await res.json().catch(() => null);
    } catch (err) {
      return { error: `Không kết nối được máy chủ PM: ${err?.message ?? err}` };
    }
    const data = body?.data;
    if (!res.ok || !data?.accessToken) {
      const msg = Array.isArray(body?.message) ? body.message.join(". ") : body?.message;
      return { error: msg || `Đăng nhập thất bại (${res.status}).` };
    }
    this.saveTokens(data, email);
    this.cache = { ...this.cache, error: null };
    await this.refresh();
    return this.state();
  }

  // Đổi refresh token lấy access token mới. Trả true nếu thành công.
  async renew() {
    const refreshToken = this.decrypt("pmRefreshEnc");
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${API}/auth/refresh`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return false;
      const data = (await res.json())?.data;
      if (!data?.accessToken) return false;
      this.saveTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken ?? refreshToken });
      return true;
    } catch {
      return false;
    }
  }

  // Biến môi trường cho task Claude (skill gọi API PM). Rỗng nếu chưa đăng nhập.
  env() {
    const token = this.token();
    return token ? { PM_TOKEN: token, PM_API_URL: API } : {};
  }

  state() {
    const token = this.token();
    return {
      ...this.cache,
      hasToken: !!token,
      tokenExpiresAt: token ? tokenExpiry(token) : null,
      canRenew: !!this.store.settings.pmRefreshEnc,
      email: token ? this.store.settings.pmEmail ?? null : null,
      loading: this.loading,
      url: PM_URL,
    };
  }

  saveCache() {
    const tmp = this.cacheFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.cache));
    fs.renameSync(tmp, this.cacheFile);
  }

  async refresh() {
    if (!this.token() || this.loading) return this.state();
    this.loading = true;
    this.emit("pm:update", this.state());
    try {
      // Token sắp/đã hết hạn thì làm mới trước; bị từ chối thì làm mới rồi thử lại một lần.
      const exp = tokenExpiry(this.token());
      // Làm mới sớm (còn dưới 2 giờ) để token đưa cho task Claude không hết hạn giữa chừng.
      if (exp && exp - Date.now() < 2 * 3600_000) await this.renew();
      const get = (p = "/tasks/mine") => fetch(`${API}${p}`, { headers: { Accept: "application/json", Authorization: `Bearer ${this.token()}` } });
      let res = await get();
      if ((res.status === 401 || res.status === 403) && (await this.renew())) res = await get();
      if (res.status === 401 || res.status === 403) throw new Error("Phiên đăng nhập PM đã hết hạn. Đăng nhập lại trong ⚙ Cài đặt.");
      if (!res.ok) throw new Error(`Máy chủ PM trả lỗi ${res.status}`);
      const body = await res.json();
      const data = body?.data ?? body;
      const list = Array.isArray(data) ? data : (data?.items ?? []);
      const tasks = list.map(normalize).filter((t) => t.category === "TODO");
      await this.fillTypes(tasks, get);
      this.cache = { tasks, fetchedAt: Date.now(), error: null };
    } catch (err) {
      this.cache = { ...this.cache, error: String(err?.message ?? err) };
    } finally {
      this.loading = false;
      this.saveCache();
      this.emit("pm:update", this.state());
    }
    return this.state();
  }

  // /tasks/mine chỉ có taskTypeId: lấy tên + màu loại công việc theo từng project. Lỗi thì bỏ qua (không hiện tag).
  async fillTypes(tasks, get) {
    const pids = [...new Set(tasks.filter((t) => !t.type && t.typeId && t.projectId).map((t) => t.projectId))];
    const types = new Map();
    await Promise.all(
      pids.map(async (pid) => {
        try {
          const res = await get(`/projects/${encodeURIComponent(pid)}/task-types`);
          if (!res.ok) return;
          const body = await res.json();
          const data = body?.data ?? body;
          for (const x of Array.isArray(data) ? data : (data?.items ?? [])) if (x?.id && x.name) types.set(x.id, { name: x.name, color: x.color ?? null });
        } catch {}
      }),
    );
    for (const t of tasks) if (!t.type && t.typeId) t.type = types.get(t.typeId) ?? null;
  }

  // Kéo khi mở app nếu dữ liệu đã cũ, rồi mỗi giờ một lần.
  start() {
    const stale = !this.cache.fetchedAt || Date.now() - this.cache.fetchedAt > REFRESH_MS;
    if (stale) this.refresh();
    setInterval(() => this.refresh(), REFRESH_MS);
  }
}
