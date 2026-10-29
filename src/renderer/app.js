const MODES = [
  ["acceptEdits", "Tự sửa file, hỏi khi chạy lệnh"],
  ["default", "Hỏi trước mọi thao tác"],
  ["auto", "Auto (Claude tự đánh giá)"],
  ["bypassPermissions", "Toàn quyền, không hỏi"],
  ["plan", "Chỉ lên kế hoạch"],
];

const STATUS_LABEL = {
  idle: "Chờ",
  running: "Đang chạy",
  waiting: "Cần duyệt",
  stopping: "Đang dừng",
  queued: "Đang chờ lượt",
  stopped: "Đã dừng",
  done: "Xong",
  error: "Lỗi",
};

const ACTIVE = new Set(["running", "waiting", "stopping", "queued"]);

// Màu trạng thái: xanh lá = xong, xanh dương = đang chạy, đỏ = lỗi,
// vàng = đang chờ người dùng (duyệt quyền hoặc chọn phương án Claude hỏi).
function statusTone(t) {
  switch (t.status) {
    case "done":
      return "done";
    case "running":
    case "stopping":
      return "running";
    case "queued":
      return "queued";
    case "error":
      return "error";
    case "waiting":
      return "warn";
    default:
      return "idle";
  }
}

function statusLabel(t) {
  if (t.status === "done" && t.warnings) return `Xong · ${t.warnings} thao tác bị từ chối`;
  if (t.status === "waiting" && t.waitingFor === "question") return "Đang hỏi bạn";
  if (t.status === "running" && t.turnDone) return t.background ? `Đang chạy nền (${t.background} lệnh)` : "Đang chạy nền";
  return STATUS_LABEL[t.status] ?? t.status;
}

const state = {
  projects: [],
  groups: [],
  settings: { maxConcurrent: 10 },
  tasks: [],
  view: { type: "overview" },
  collapsed: new Set(JSON.parse(localStorage.getItem("collapsed") || "[]")),
};

let currentView = null; // { update(), onEntry?(taskId, entry) }

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const projectOf = (task) => state.projects.find((p) => p.id === task.projectId);
const tasksOf = (projectId) =>
  state.tasks.filter((t) => t.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt);

// Mặc định: Auto. Máy đã lưu chế độ cũ thì chuyển sang Auto một lần, sau đó nhớ theo lựa chọn của người dùng.
if (!localStorage.getItem("modeDefaultAuto")) {
  localStorage.setItem("mode", "auto");
  localStorage.setItem("modeDefaultAuto", "1");
}
const lastMode = () => localStorage.getItem("mode") || "auto";

function modeSelect(value, onchange) {
  return h(
    "select",
    { onchange: (e) => onchange(e.target.value) },
    MODES.map(([v, label]) => h("option", { value: v, selected: v === value }, label)),
  );
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "vừa xong";
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return new Date(ts).toLocaleDateString("vi-VN");
}

const TRASH_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5"/></svg>';

const PENCIL_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">' +
  '<path d="M10.5 2.5l3 3L6 13H3v-3z M9 4l3 3"/></svg>';

function iconButton(svg, title, onClick) {
  const btn = h("button", {
    class: "row-btn icon",
    title,
    onclick: (e) => {
      e.stopPropagation();
      onClick();
    },
  });
  btn.innerHTML = svg;
  return btn;
}

// Đổi tên task tại chỗ. Giữ nguyên một ô input để sidebar render lại
// (do task khác cập nhật) không làm mất chữ đang gõ.
const renaming = { taskId: null, where: null, input: null };

function startRename(t, where = "sidebar") {
  const input = h("input", { class: "rename-input", value: t.title });
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    renaming.taskId = renaming.input = renaming.where = null;
    if (save && title && title !== t.title) {
      await api.renameTask({ taskId: t.id, title });
    }
    renderSidebar();
    currentView?.update();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) finish(true);
    if (e.key === "Escape") finish(false);
  });
  // Render lại làm input mất focus tạm thời; chỉ lưu khi người dùng thật sự rời đi.
  input.addEventListener("blur", () => setTimeout(() => document.activeElement !== input && finish(true), 0));
  input.addEventListener("click", (e) => e.stopPropagation());
  Object.assign(renaming, { taskId: t.id, where, input });
  renderSidebar();
  currentView?.update();
  input.focus();
  input.select();
}

const renameInput = () => renaming.input;

function restoreRenameFocus() {
  const input = renaming.input;
  if (input?.isConnected && document.activeElement !== input) {
    const { selectionStart, selectionEnd } = input;
    input.focus();
    input.setSelectionRange(selectionStart, selectionEnd);
  }
}

function trashButton(onDelete) {
  const btn = h("button", {
    class: "row-btn trash",
    title: "Xoá task",
    onclick: (e) => {
      e.stopPropagation();
      onDelete();
    },
  });
  btn.innerHTML = TRASH_ICON;
  return btn;
}

// Hộp xác nhận trong app. Trả về true nếu người dùng đồng ý.
function confirmDialog({ title, message, confirmText = "Đồng ý", cancelText = "Huỷ", danger = true }) {
  return new Promise((resolve) => {
    const close = (result) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") e.preventDefault(), close(false);
    };
    const cancelBtn = h("button", { onclick: () => close(false) }, cancelText);
    const okBtn = h("button", { class: danger ? "danger-solid" : "primary", onclick: () => close(true) }, confirmText);
    const overlay = h(
      "div",
      { class: "modal-overlay", onmousedown: (e) => e.target === overlay && close(false) },
      h(
        "div",
        { class: "modal" },
        h("div", { class: "modal-title" }, title),
        h("div", { class: "modal-body" }, message),
        h("div", { class: "modal-actions" }, cancelBtn, okBtn),
      ),
    );
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
    // Con trỏ ở nút Huỷ để lỡ nhấn Enter cũng không xoá nhầm.
    cancelBtn.focus();
  });
}

async function deleteTask(t) {
  const ok = await confirmDialog({
    title: "Xoá task?",
    message: [
      h("b", {}, t.title),
      ACTIVE.has(t.status) ? h("div", { class: "warn-text" }, "Task đang chạy sẽ bị dừng.") : null,
      h("div", { class: "hint" }, "Lịch sử hội thoại trong app sẽ bị xoá và không khôi phục được."),
    ],
    confirmText: "Xoá",
  });
  if (!ok) return;
  await api.deleteTask(t.id);
  state.tasks = state.tasks.filter((x) => x.id !== t.id);
  if (state.view.type === "task" && state.view.id === t.id) navigate({ type: "project", id: t.projectId });
  else navigate(state.view);
}

// ---------- markdown ----------

// Câu trả lời của Claude là markdown: render bằng marked rồi lọc qua DOMPurify
// (nội dung do model sinh ra, có thể chứa HTML bất kỳ).
function markdownBlock(text) {
  const el = h("div", { class: "text md" });
  try {
    el.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }), {
      FORBID_TAGS: ["style", "form", "input", "button", "iframe", "img"],
    });
  } catch {
    el.textContent = text;
  }
  for (const table of el.querySelectorAll("table")) table.replaceWith(h("div", { class: "table-wrap" }, table.cloneNode(true)));
  for (const pre of el.querySelectorAll("pre")) {
    const copy = h("button", { class: "copy-btn", title: "Sao chép" }, "Sao chép");
    copy.addEventListener("click", () => {
      navigator.clipboard.writeText(pre.querySelector("code")?.textContent ?? pre.textContent);
      copy.textContent = "Đã chép";
      setTimeout(() => (copy.textContent = "Sao chép"), 1200);
    });
    pre.append(copy);
  }
  return el;
}

// Bản rút gọn không ký hiệu markdown, dùng cho thẻ task.
const plainText = (s) =>
  s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, " ")
    .replace(/[*_`#>|]+/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

// Bấm link trong câu trả lời: URL web mở bằng trình duyệt, đường dẫn file mở trong editor.
document.addEventListener("click", (e) => {
  const a = e.target.closest?.(".md a[href]");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href");
  if (/^https?:\/\//.test(href)) return api.openUrl(href.replace(/^http:/, "https:"));
  const pid = viewProjectId();
  if (pid && !/^[a-z]+:/i.test(href)) window.openInEditor?.(pid, href.replace(/^\.\//, "").replace(/#.*$/, ""));
});

document.body.classList.add(`os-${api.platform}`);

let pmState = null; // task Cần làm trên PM (xem pmSection)

function navigate(view) {
  // Chuyển sang màn hình khác (task/project) thì quay về tab Claude.
  if (view.type !== state.view.type || view.id !== state.view.id) {
    window.editorBeforeNavigate?.();
    state.view = view;
    window.editorShowChat?.(viewProjectId());
  }
  state.view = view;
  renderSidebar();
  renderMain();
}

// ---------- sidebar ----------

function renderSidebar() {
  renderSidebarInner();
  restoreRenameFocus();
}

function renderSidebarInner() {
  const running = state.tasks.filter((t) => ACTIVE.has(t.status)).length;
  const waiting = state.tasks.filter((t) => t.status === "waiting").length;
  const badge = document.getElementById("running-count");
  badge.textContent = waiting ? `${waiting} chờ bạn` : running || "";
  badge.className = "badge" + (waiting ? " warn" : "");
  document.getElementById("nav-overview").classList.toggle("active", state.view.type === "overview");

  // Thứ tự: project đã ghim (tối đa 5) → project chưa vào nhóm → từng nhóm.
  const list = document.getElementById("project-list");
  const groupIds = new Set(state.groups.map((g) => g.id));
  const pinned = state.projects.filter((p) => p.pinnedAt).sort((a, b) => a.pinnedAt - b.pinnedAt);
  const rest = state.projects.filter((p) => !p.pinnedAt);
  const loose = rest.filter((p) => !groupIds.has(p.groupId));
  list.replaceChildren(
    ...(pinned.length ? [h("div", { class: "pin-title" }, "📌 Đã ghim"), ...pinned.map(projectNode), h("div", { class: "pin-sep" })] : []),
    ...loose.map(projectNode),
    ...state.groups.map((g) => groupNode(g, rest.filter((p) => p.groupId === g.id))),
  );
}

const MAX_PINNED = 5;

async function togglePin(p) {
  const res = await api.pinProject({ id: p.id, pinned: !p.pinnedAt });
  if (res.error) {
    return alertDialog("Không ghim được", `${res.error}\nBỏ ghim một project khác trước (chuột phải → Bỏ ghim).`);
  }
  if (res.pinnedAt) p.pinnedAt = res.pinnedAt;
  else delete p.pinnedAt;
  renderSidebar();
}

// Tổng hợp trạng thái nhiều task thành 1 badge: vàng nếu có task chờ bạn.
function activeBadge(tasks) {
  const active = tasks.filter((t) => ACTIVE.has(t.status)).length;
  if (!active) return null;
  return h("span", { class: "badge" + (tasks.some((t) => t.status === "waiting") ? " warn" : "") }, active);
}

// ----- kéo thả project vào nhóm / đổi thứ tự -----
let dragProjectId = null;

function dropTarget(el, onDrop) {
  el.addEventListener("dragover", (e) => {
    if (!dragProjectId) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.add("drop-over");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop-over"));
  el.addEventListener("drop", async (e) => {
    el.classList.remove("drop-over");
    if (!dragProjectId) return;
    e.preventDefault();
    e.stopPropagation();
    const id = dragProjectId;
    dragProjectId = null;
    await onDrop(id);
  });
}

async function moveProject(id, groupId, beforeId = null) {
  if (id === beforeId) return;
  await api.moveProject({ id, groupId, beforeId });
  const i = state.projects.findIndex((p) => p.id === id);
  const [p] = state.projects.splice(i, 1);
  p.groupId = groupId;
  const j = beforeId ? state.projects.findIndex((x) => x.id === beforeId) : -1;
  j >= 0 ? state.projects.splice(j, 0, p) : state.projects.push(p);
  renderSidebar();
}

function projectMenu(e, p) {
  e.preventDefault();
  e.stopPropagation();
  const pinnedCount = state.projects.filter((x) => x.pinnedAt).length;
  showContextMenu(e.clientX, e.clientY, [
    p.pinnedAt
      ? { label: "Bỏ ghim", run: () => togglePin(p) }
      : { label: "📌 Ghim lên đầu", key: `${pinnedCount}/${MAX_PINNED}`, run: () => togglePin(p) },
    "-",
    { label: "Task mới", run: () => navigate({ type: "project", id: p.id }) },
    { label: "Mở bằng VSCode", run: () => api.openProject({ id: p.id, app: "vscode" }) },
    { label: "Hiện trong Finder", run: () => api.openProject({ id: p.id, app: "finder" }) },
    "-",
    ...state.groups
      .filter((g) => g.id !== p.groupId)
      .map((g) => ({ label: `Chuyển vào ${g.icon ?? "📁"} ${g.name}`, run: () => moveProject(p.id, g.id) })),
    p.groupId && state.groups.some((g) => g.id === p.groupId) && { label: "Bỏ ra khỏi nhóm", run: () => moveProject(p.id, null) },
    { label: "Tạo nhóm mới với project này…", run: () => createGroupFlow(p.id) },
  ]);
}

function projectNode(p) {
  const tasks = tasksOf(p.id);
  const collapsed = state.collapsed.has(p.id);
  const head = h(
    "div",
    {
      class: "project-head" + (state.view.type === "project" && state.view.id === p.id ? " active" : ""),
      draggable: "true",
      onclick: () => navigate({ type: "project", id: p.id }),
      oncontextmenu: (e) => projectMenu(e, p),
      ondragstart: (e) => {
        dragProjectId = p.id;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", p.name);
      },
      ondragend: () => (dragProjectId = null),
    },
    h(
      "span",
      {
        class: "icon-btn",
        onclick: (e) => {
          e.stopPropagation();
          collapsed ? state.collapsed.delete(p.id) : state.collapsed.add(p.id);
          localStorage.setItem("collapsed", JSON.stringify([...state.collapsed]));
          renderSidebar();
        },
      },
      collapsed ? "▸" : "▾",
    ),
    h("span", { class: "name", title: p.path }, p.name),
    p.pinnedAt ? h("span", { class: "pin-mark", title: "Đã ghim · bấm để bỏ ghim", onclick: (e) => (e.stopPropagation(), togglePin(p)) }, "📌") : null,
    activeBadge(tasks),
    h(
      "button",
      {
        class: "row-btn",
        title: "Task mới",
        onclick: (e) => {
          e.stopPropagation();
          state.collapsed.delete(p.id);
          navigate({ type: "project", id: p.id });
        },
      },
      "＋",
    ),
  );
  // Thả project khác lên project này = xếp nó lên trên, cùng nhóm.
  dropTarget(head, (id) => moveProject(id, p.groupId ?? null, p.id));
  return h(
    "div",
    { class: "project" },
    head,
    collapsed
      ? null
      : tasks.map((t) =>
          h(
            "div",
            {
              class: "task-item" + (state.view.type === "task" && state.view.id === t.id ? " active" : ""),
              onclick: () => navigate({ type: "task", id: t.id }),
              title: t.title,
            },
            h("span", { class: `dot ${statusTone(t)}`, title: statusLabel(t) }),
            renaming.taskId === t.id ? renameInput(t) : h("span", { class: "title" }, t.title),
            renaming.taskId === t.id ? null : iconButton(PENCIL_ICON, "Đổi tên", () => startRename(t)),
            renaming.taskId === t.id ? null : trashButton(() => deleteTask(t)),
          ),
        ),
  );
}

function groupNode(g, projects) {
  const tasks = state.tasks.filter((t) => projects.some((p) => p.id === t.projectId));
  const toggle = () => {
    g.collapsed = !g.collapsed;
    api.updateGroup({ id: g.id, collapsed: g.collapsed });
    renderSidebar();
  };
  const head = h(
    "div",
    { class: "group-head", onclick: toggle, title: g.name },
    (() => {
      const chev = h("span", { class: "chev" + (g.collapsed ? "" : " open") });
      chev.innerHTML = CHEVRON;
      return chev;
    })(),
    h("span", { class: "group-icon" }, g.icon ?? "📁"),
    h("span", { class: "name" }, g.name),
    h("span", { class: "group-count" }, projects.length),
    activeBadge(tasks),
    h(
      "button",
      {
        class: "row-btn",
        title: "Thêm project vào nhóm",
        onclick: async (e) => {
          e.stopPropagation();
          const added = await api.addProject({ groupId: g.id });
          if (!added.length) return;
          state.projects.push(...added);
          g.collapsed = false;
          api.updateGroup({ id: g.id, collapsed: false });
          navigate({ type: "project", id: added[0].id });
        },
      },
      "＋",
    ),
    iconButton(PENCIL_ICON, "Sửa nhóm", () => editGroupFlow(g)),
    trashButton(() => deleteGroupFlow(g, projects)),
  );
  head.querySelector(".trash").title = "Xoá nhóm";
  head.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: "Thêm project vào nhóm…", run: () => head.querySelector(".row-btn").click() },
      { label: "Sửa tên / icon…", run: () => editGroupFlow(g) },
      "-",
      { label: "Xoá nhóm", danger: true, run: () => deleteGroupFlow(g, projects) },
    ]);
  });
  dropTarget(head, (id) => moveProject(id, g.id));
  return h(
    "div",
    { class: "group" + (g.collapsed ? " collapsed" : "") },
    head,
    g.collapsed ? null : h("div", { class: "group-body" }, projects.length ? projects.map(projectNode) : h("div", { class: "group-empty" }, "Kéo project vào đây")),
  );
}

// ----- hộp tạo / sửa nhóm: tên + icon -----
const GROUP_ICONS = [
  "📁", "🗂️", "💼", "🏢", "🏠", "🚀", "🛠️", "🧪", "🎨", "📊", "📈", "🌐",
  "📱", "💻", "🖥️", "🧩", "🧠", "💡", "🔥", "⭐", "🎯", "🐞", "🔒", "☁️",
  "🛒", "🎮", "📦", "📚", "📝", "🤖", "⚙️", "🌱", "💰", "🎬", "📷", "❤️",
];

function groupDialog({ title, name = "", icon = "📁", confirmText }) {
  return new Promise((resolve) => {
    let picked = icon;
    const input = h("input", { class: "group-name-input", value: name, placeholder: "Tên nhóm (vd. CafeF, Cá nhân, Khách hàng A)" });
    const preview = h("span", { class: "group-icon big" }, picked);
    const grid = h(
      "div",
      { class: "icon-grid" },
      GROUP_ICONS.map((ic) =>
        h(
          "button",
          {
            class: "icon-cell" + (ic === picked ? " on" : ""),
            onclick: () => {
              picked = ic;
              preview.textContent = ic;
              grid.querySelectorAll(".icon-cell").forEach((b) => b.classList.toggle("on", b.textContent === ic));
            },
          },
          ic,
        ),
      ),
    );
    const close = (v) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(v);
    };
    const ok = () => input.value.trim() && close({ name: input.value.trim(), icon: picked });
    const onKey = (e) => {
      if (e.key === "Escape") close(null);
      if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) ok();
    };
    const overlay = h(
      "div",
      { class: "modal-overlay", onmousedown: (e) => e.target === overlay && close(null) },
      h(
        "div",
        { class: "modal group-modal" },
        h("div", { class: "modal-title" }, title),
        h("div", { class: "modal-body" }, h("div", { class: "group-name-row" }, preview, input), h("div", { class: "hint" }, "Chọn icon"), grid),
        h("div", { class: "modal-actions" }, h("button", { onclick: () => close(null) }, "Huỷ"), h("button", { class: "primary", onclick: ok }, confirmText)),
      ),
    );
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}

async function createGroupFlow(withProjectId = null) {
  const res = await groupDialog({ title: "Tạo nhóm mới", confirmText: "Tạo nhóm" });
  if (!res) return;
  const g = await api.createGroup(res);
  state.groups.push(g);
  if (withProjectId) await moveProject(withProjectId, g.id);
  else renderSidebar();
}

async function editGroupFlow(g) {
  const res = await groupDialog({ title: "Sửa nhóm", name: g.name, icon: g.icon ?? "📁", confirmText: "Lưu" });
  if (!res) return;
  await api.updateGroup({ id: g.id, ...res });
  Object.assign(g, res);
  renderSidebar();
}

async function deleteGroupFlow(g, projects) {
  const ok = await confirmDialog({
    title: "Xoá nhóm?",
    message: [
      h("b", {}, `${g.icon ?? "📁"} ${g.name}`),
      h("div", {}, projects.length ? `${projects.length} project trong nhóm sẽ được chuyển ra ngoài, không bị xoá.` : "Nhóm đang trống."),
    ],
    confirmText: "Xoá nhóm",
  });
  if (!ok) return;
  await api.deleteGroup(g.id);
  state.groups = state.groups.filter((x) => x.id !== g.id);
  for (const p of state.projects) if (p.groupId === g.id) p.groupId = null;
  renderSidebar();
}

// ---------- composer ----------

// ---------- model / effort / slash command ----------

const EFFORT_LABEL = { low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };
const metaCache = new Map(); // projectId -> Promise<{ models, commands }>

function getMeta(projectId) {
  if (!metaCache.has(projectId)) {
    const p = api.claudeMeta(projectId).then((m) => {
      if (m?.error) metaCache.delete(projectId);
      return m?.error ? { models: [], commands: [] } : m;
    });
    metaCache.set(projectId, p);
  }
  return metaCache.get(projectId);
}

// Chip chỉ hiện tên ngắn: "Default (recommended)" -> "Default".
const modelName = (models, value) => {
  const name = models.find((m) => m.value === (value || "default"))?.name ?? (value && value !== "default" ? value : "Default");
  return name.replace(/\s*\(.*\)$/, "");
};

// Popover nổi phía trên ô nhập; đóng khi bấm ra ngoài.
function openPopover(anchorBox, content, cls = "") {
  closePopover();
  const pop = h("div", { class: `popover ${cls}` }, content);
  anchorBox.append(pop);
  const onDoc = (e) => {
    if (!pop.contains(e.target) && !e.target.closest?.(".chip-btn")) closePopover();
  };
  setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
  openPopover.current = { pop, onDoc };
  return pop;
}

function closePopover() {
  const cur = openPopover.current;
  if (!cur) return;
  cur.pop.remove();
  document.removeEventListener("mousedown", cur.onDoc);
  openPopover.current = null;
}

// Ô nhập prompt dùng chung.
// onSubmit(prompt, mode, projectId, { model, effort }) trả về promise.
function composer({ placeholder, showProjectPicker, projectId, showMode = true, card = false, onSubmit }) {
  let mode = lastMode();
  let model = localStorage.getItem("model") || "default";
  let effort = EFFORT_LABEL[localStorage.getItem("effort")] ? localStorage.getItem("effort") : null;
  let ultracode = localStorage.getItem("ultracode") === "1";
  let onModelChange = null; // task view: lưu vào task thay vì localStorage
  let busy = false;
  let onStop = null;

  const textarea = h("textarea", { placeholder, rows: 1 });
  // Mặc định 1 dòng; tự cao lên theo nội dung (Shift+Enter hoặc chữ dài tự xuống dòng).
  textarea.autosize = () => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 300)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 300 ? "auto" : "hidden";
  };
  const picker = showProjectPicker
    ? h(
        "select",
        { class: "chip-select", onchange: () => renderModelChip() },
        state.projects.map((p) => h("option", { value: p.id, selected: p.id === localStorage.getItem("lastProject") }, p.name)),
      )
    : null;
  const pid = () => (picker ? picker.value : projectId);
  const modeSlot = h("span", { class: "mode-slot" });
  const sendBtn = h("button", { class: "send", title: "Gửi (Enter)" });
  // Đang chạy: gửi chèn vào lượt hiện tại (mặc định) hoặc để dành tới khi Claude xong lượt.
  let afterTurn = false;
  let afterTouched = false; // người dùng tự bật/tắt thì không tự đoán theo chữ nữa
  const afterChip = h("button", {
    class: "chip-btn after-chip",
    title: "Bật: prompt chạy thành lượt riêng ngay sau khi Claude xong việc đang làm (có câu trả lời riêng). Tắt: chèn ngay vào việc đang làm. ⌥Enter để gửi sau lượt.",
    onclick: () => ((afterTouched = true), (afterTurn = !afterTurn), renderSend(), textarea.focus()),
  });
  const box = h("div", { class: "box" });

  // ----- bảng gợi ý: "/" lệnh & skill, "@" file trong project -----
  let palette = null; // { mode, list, items, index, start }
  const slashBtn = h(
    "button",
    {
      class: "chip-btn icon-chip",
      title: "Lệnh / skill (gõ / ở đầu ô nhập)",
      onclick: () => {
        if (!textarea.value.startsWith("/")) textarea.value = "/" + textarea.value;
        textarea.autosize();
        textarea.focus();
        textarea.setSelectionRange(1, 1);
        updatePalette();
      },
    },
    "/",
  );

  // ----- ngữ cảnh đã dùng (vòng tròn) + thời hạn prompt cache (đồng hồ), chỉ ở task view -----
  let ctxTask = null;
  let onCompact = null;
  const ctxTip = h("div", { class: "ctx-tip" });
  const ctxBtn = h("button", { class: "chip-btn icon-chip ctx-btn", onclick: () => !busy && ctxTask?.sessionId && onCompact?.() });
  const ctxWrap = h("span", { class: "ctx-wrap", style: "display:none" }, ctxBtn, ctxTip);
  const cacheChip = h("span", { class: "cache-chip", style: "display:none" });
  const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  function renderContext() {
    const c = ctxTask?.context;
    // Task đã có phiên thì luôn hiện vòng tròn để bấm nén, kể cả khi chưa đo được số.
    ctxWrap.style.display = c?.limit || ctxTask?.sessionId ? "" : "none";
    if (!c?.limit && ctxTask?.sessionId) {
      ctxBtn.className = "chip-btn icon-chip ctx-btn";
      ctxBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="2"/></svg>`;
      ctxTip.replaceChildren(
        h("div", {}, "Đang đo ngữ cảnh…"),
        h("div", { class: "muted" }, busy ? "Nén được sau khi Claude trả lời xong." : "Bấm để nén ngay (/compact)."),
      );
    }
    if (c?.limit) {
      const frac = Math.min(1, c.used / c.limit);
      const left = Math.max(0, Math.round((1 - frac) * 100));
      const tone = left <= 10 ? "err" : left <= 25 ? "warn" : "";
      const len = 2 * Math.PI * 6;
      ctxBtn.className = "chip-btn icon-chip ctx-btn " + tone;
      ctxBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="2"/><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="${(frac * len).toFixed(2)} ${len.toFixed(2)}" transform="rotate(-90 8 8)"/></svg>`;
      ctxTip.replaceChildren(
        h("div", {}, c.auto ? `Còn ${left}% ngữ cảnh trước khi tự động nén (auto-compact).` : `Còn ${left}% ngữ cảnh.`),
        h("div", { class: "muted" }, `${fmtTokens(c.used)} / ${fmtTokens(c.limit)} token`),
        h("div", { class: "muted" }, busy ? "Nén được sau khi Claude trả lời xong." : "Bấm để nén ngay (/compact)."),
      );
    }
    const end = ctxTask?.cacheAt ? ctxTask.cacheAt + (ctxTask.cacheTtl ?? 3600) * 1000 : 0;
    const mins = Math.ceil((end - Date.now()) / 60000);
    cacheChip.style.display = mins > 0 ? "" : "none";
    if (mins > 0) {
      cacheChip.innerHTML =
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.3 1.5"/></svg>';
      cacheChip.append(h("span", {}, `${mins}m`));
      cacheChip.title = `Prompt cache còn ${mins} phút: nhắn tiếp trong thời gian này Claude đọc lại ngữ cảnh nhanh và rẻ hơn. Hết hạn thì lượt sau phải nạp lại toàn bộ ngữ cảnh.`;
    }
  }
  // Cập nhật số phút của đồng hồ; composer bị gỡ khỏi màn hình thì dừng.
  let ctxShown = false;
  const ctxTimer = setInterval(() => {
    if (ctxWrap.isConnected) (ctxShown = true), renderContext();
    else if (ctxShown) clearInterval(ctxTimer);
  }, 20000);

  // Đang gõ "/lệnh" ở đầu ô, hoặc "@tênfile" ngay trước con trỏ?
  function trigger() {
    const v = textarea.value;
    const cmd = v.match(/^\/(\S*)$/);
    if (cmd) return { mode: "cmd", q: cmd[1].toLowerCase() };
    const caret = textarea.selectionStart;
    const at = v.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/);
    if (at) return { mode: "file", q: at[1], start: caret - at[1].length - 1 };
    return null;
  }

  async function updatePalette() {
    const t = trigger();
    if (!t) {
      if (palette) closePopover(), (palette = null);
      return;
    }
    let items, empty, row;
    if (t.mode === "cmd") {
      const { commands } = await getMeta(pid());
      items = commands
        .filter((c) => c.name.toLowerCase().includes(t.q) || c.description?.toLowerCase().includes(t.q))
        .sort((a, b) => b.name.toLowerCase().startsWith(t.q) - a.name.toLowerCase().startsWith(t.q))
        .slice(0, 50);
      empty = commands.length ? "Không có lệnh phù hợp" : "Đang tải danh sách lệnh…";
      row = (c) => [h("span", { class: "cmd-name" }, `/${c.name}`, c.hint ? h("span", { class: "cmd-hint" }, ` ${c.hint}`) : null), h("span", { class: "cmd-desc" }, c.description ?? "")];
    } else {
      items = await api.searchFiles({ projectId: pid(), q: t.q });
      empty = "Không tìm thấy file";
      row = (f) => {
        const name = f.split("/").pop();
        return [h("span", { class: "cmd-name file" }, fileIcon(name), name), h("span", { class: "cmd-desc" }, f)];
      };
    }
    // Người dùng có thể đã gõ tiếp trong lúc chờ kết quả.
    const now = trigger();
    if (!now || now.mode !== t.mode || now.q !== t.q) return;
    const list = h(
      "div",
      { class: "cmd-list" },
      h("div", { class: "pop-title" }, t.mode === "cmd" ? "Lệnh & skill" : "Thêm ngữ cảnh: file trong project"),
      items.length
        ? items.map((it, i) =>
            h("div", { class: "cmd-item", onmousedown: (e) => (e.preventDefault(), pick(it)), onmouseenter: () => highlight(i) }, row(it)),
          )
        : h("div", { class: "hint", style: "padding:8px 10px" }, empty),
    );
    if (!palette || !palette.list.isConnected) openPopover(box, list, "cmd-pop");
    else palette.list.replaceWith(list);
    palette = { mode: t.mode, list, items, index: 0, start: t.start };
    highlight(0);
  }

  function highlight(i) {
    if (!palette) return;
    palette.index = i;
    [...palette.list.querySelectorAll(".cmd-item")].forEach((el, j) => {
      el.classList.toggle("active", j === i);
      if (j === i) el.scrollIntoView({ block: "nearest" });
    });
  }

  function pick(it) {
    if (palette?.mode === "file") {
      const caret = textarea.selectionStart;
      const v = textarea.value;
      const insert = `@${it} `;
      textarea.value = v.slice(0, palette.start) + insert + v.slice(caret);
      textarea.setSelectionRange(palette.start + insert.length, palette.start + insert.length);
    } else {
      textarea.value = `/${it.name} `;
    }
    textarea.autosize();
    closePopover();
    palette = null;
    textarea.focus();
  }

  // Mở danh sách file (mục "Thêm ngữ cảnh" hoặc gõ @).
  function openFilePicker() {
    const caret = textarea.selectionStart ?? textarea.value.length;
    const v = textarea.value;
    const pad = caret > 0 && !/\s/.test(v[caret - 1]) ? " " : "";
    textarea.value = v.slice(0, caret) + pad + "@" + v.slice(caret);
    textarea.focus();
    textarea.setSelectionRange(caret + pad.length + 1, caret + pad.length + 1);
    textarea.autosize();
    updatePalette();
  }

  // ----- file đính kèm: nút +, dán ảnh, kéo thả -----
  let attachments = [];
  const attachBar = h("div", { class: "attach-bar" });

  function renderAttachments() {
    renderSend();
    attachBar.style.display = attachments.length ? "" : "none";
    attachBar.replaceChildren(
      ...attachments.map((a, i) =>
        h(
          "div",
          { class: "attach-chip", title: a.path ?? a.name },
          a.thumb ? h("img", { src: a.thumb, alt: "" }) : fileIcon(a.name),
          h("span", { class: "name" }, a.name),
          h("button", { class: "x", title: "Bỏ đính kèm", onclick: () => (attachments.splice(i, 1), renderAttachments()) }, "×"),
        ),
      ),
    );
  }

  function addAttachments(list) {
    for (const a of list ?? []) {
      if (a && !attachments.some((x) => (x.path && x.path === a.path) || (x.data && x.data === a.data))) attachments.push(a);
    }
    renderAttachments();
    textarea.focus();
  }

  textarea.addEventListener("paste", async (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    const out = [];
    for (const f of files) {
      const p = api.pathForFile(f);
      if (p) out.push(...(await api.attachPaths([p])));
      else if (f.type.startsWith("image/")) out.push(await api.attachImageData({ name: f.name || "Ảnh dán.png", type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) }));
    }
    addAttachments(out.filter(Boolean));
  });

  box.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    box.classList.add("dropping");
  });
  box.addEventListener("dragleave", (e) => !box.contains(e.relatedTarget) && box.classList.remove("dropping"));
  box.addEventListener("drop", async (e) => {
    box.classList.remove("dropping");
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    addAttachments(await api.attachPaths(files.map((f) => api.pathForFile(f)).filter(Boolean)));
  });

  let web = localStorage.getItem("web") === "1";
  const webChip = h("button", { class: "chip-btn web-chip", title: "Claude được tìm kiếm & đọc web không cần hỏi. Bấm để tắt.", onclick: () => setModelOpts({ web: false }) });

  const PLUS_ICONS = {
    upload: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M8 10.5V2.5M5 5.5l3-3 3 3"/><path d="M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10"/></svg>',
    context: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z"/><path d="M9.5 1.5V5H13M5.5 8.5h5M5.5 11h3"/></svg>',
    web: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14C6.2 12.3 5.4 10.3 5.4 8S6.2 3.7 8 2z"/></svg>',
  };
  const plusBtn = h("button", { class: "chip-btn icon-chip plus", title: "Đính kèm, ngữ cảnh, web" }, "+");
  plusBtn.addEventListener("click", () => {
    if (openPopover.current?.pop.classList.contains("plus-pop")) return closePopover();
    const item = (icon, label, run, extra) => {
      const ic = h("span", { class: "pm-icon" });
      ic.innerHTML = PLUS_ICONS[icon];
      return h("div", { class: "pm-item", onclick: () => (closePopover(), run()) }, ic, h("span", { class: "pm-label" }, label), extra ?? null);
    };
    openPopover(
      box,
      [
        item("upload", "Tải lên từ máy", async () => addAttachments(await api.pickAttachments()), h("span", { class: "pm-key" }, "⌘V / kéo thả")),
        item("context", "Thêm ngữ cảnh", openFilePicker, h("span", { class: "pm-key" }, "@")),
        item("web", "Duyệt web", () => setModelOpts({ web: !web }), h("input", { type: "checkbox", class: "switch", checked: web, onclick: (e) => e.preventDefault() })),
      ],
      "plus-pop",
    );
  });

  textarea.addEventListener("input", () => (textarea.autosize(), updatePalette(), renderSend()));
  textarea.addEventListener("click", () => palette && updatePalette());
  // Ô rộng ra / hẹp lại (kéo cột) thì số dòng tự xuống dòng thay đổi.
  let lastWidth = 0;
  new ResizeObserver(() => {
    if (textarea.clientWidth !== lastWidth) (lastWidth = textarea.clientWidth), textarea.autosize();
  }).observe(textarea);

  // ----- model + effort + ultracode (giống bảng chọn model của Claude Code) -----
  const modelBtn = h("button", { class: "chip-btn", title: "Model, effort, ultracode" });

  async function renderModelChip() {
    renderWebChip();
    const { models } = await getMeta(pid());
    modelBtn.replaceChildren(
      ...[
        h("span", {}, modelName(models, model)),
        effort && h("span", { class: "muted" }, ` ${EFFORT_LABEL[effort] ?? effort}`),
        ultracode && h("span", { class: "ultra-tag" }, " · Ultracode"),
      ].filter(Boolean),
    );
  }

  function setModelOpts(patch) {
    ({ model = model, effort = effort, ultracode = ultracode, web = web } = { model, effort, ultracode, web, ...patch });
    if (onModelChange) onModelChange({ model, effort, ultracode, web });
    else {
      localStorage.setItem("model", model);
      effort ? localStorage.setItem("effort", effort) : localStorage.removeItem("effort");
      localStorage.setItem("ultracode", ultracode ? "1" : "0");
      localStorage.setItem("web", web ? "1" : "0");
    }
    renderModelChip();
  }

  function renderWebChip() {
    webChip.style.display = web ? "" : "none";
    const ic = h("span", { class: "pm-icon" });
    ic.innerHTML = PLUS_ICONS.web;
    webChip.replaceChildren(ic, h("span", {}, "Web"));
  }

  function effortSlider(levels, onPick) {
    const current = levels.indexOf(effort);
    return h(
      "div",
      { class: "effort-slider", role: "slider" },
      h("div", { class: "track" }),
      levels.map((lv, i) =>
        h("button", {
          class: "stop" + (i === current ? " on" : ""),
          title: EFFORT_LABEL[lv] ?? lv,
          // Bấm lại nấc đang chọn thì về mức mặc định của model.
          onclick: (e) => (e.stopPropagation(), onPick(i === current ? null : lv)),
        }),
      ),
    );
  }

  async function renderModelPopover() {
    const { models } = await getMeta(pid());
    const list = models.length ? models : [{ value: "default", name: "Default (recommended)", description: "", efforts: [] }];
    const current = list.find((m) => m.value === model) ?? list[0];
    const levels = current?.efforts?.length ? current.efforts : [];
    const content = [
      h("div", { class: "pop-title" }, "Chọn model"),
      h(
        "div",
        { class: "model-list" },
        list.map((m) =>
          h(
            "div",
            {
              class: "model-item" + (m.value === model ? " active" : ""),
              onclick: () => {
                // Giữ effort nếu model mới hỗ trợ mức đó.
                setModelOpts({ model: m.value, effort: effort && (m.efforts ?? []).includes(effort) ? effort : null });
                closePopover();
              },
            },
            h("div", { class: "model-text" }, h("div", { class: "name" }, m.name), m.description ? h("div", { class: "desc" }, m.description) : null),
            h("span", { class: "check" }, m.value === model ? "✓" : ""),
          ),
        ),
      ),
      h("div", { class: "pop-sep" }),
      levels.length
        ? h(
            "div",
            { class: "pop-row" },
            h("span", {}, "Effort ", h("span", { class: "muted" }, `(${effort ? EFFORT_LABEL[effort] : "Mặc định"})`)),
            effortSlider(levels, (lv) => (setModelOpts({ effort: lv }), refresh())),
          )
        : h("div", { class: "pop-row muted" }, "Model này không chỉnh được effort"),
      h(
        "label",
        { class: "pop-row", title: "Điều phối nhiều agent chạy song song cho task lớn (tốn nhiều token hơn)" },
        h("span", {}, "Ultracode"),
        h("input", {
          type: "checkbox",
          class: "switch",
          checked: ultracode,
          onchange: (e) => setModelOpts({ ultracode: e.target.checked }),
        }),
      ),
    ];
    return content;
  }

  async function refresh() {
    const pop = openPopover.current?.pop;
    if (!pop?.classList.contains("model-pop")) return;
    const scroll = pop.querySelector(".model-list")?.scrollTop ?? 0;
    pop.replaceChildren(...(await renderModelPopover()));
    pop.querySelector(".model-list").scrollTop = scroll;
  }

  modelBtn.addEventListener("click", async () => {
    if (openPopover.current?.pop.classList.contains("model-pop")) return closePopover();
    const pop = openPopover(box, await renderModelPopover(), "model-pop");
    pop.querySelector(".model-item.active")?.scrollIntoView({ block: "nearest" });
  });

  // ----- gửi -----
  // Đang chạy vẫn gửi được: prompt được chèn vào lượt đang chạy (hoặc gửi ngay sau khi xong).
  const submit = async (forceAfter = false) => {
    // Chỉ đính kèm file mà không gõ gì thì vẫn gửi được.
    const prompt = textarea.value.trim() || (attachments.length ? "Xem file đính kèm." : "");
    const p = pid();
    if (!prompt || (showProjectPicker && !p)) return;
    const files = attachments;
    const after = busy && (afterTurn || forceAfter);
    attachments = [];
    afterTurn = false;
    afterTouched = false;
    renderAttachments();
    if (picker) localStorage.setItem("lastProject", p);
    if (showMode) localStorage.setItem("mode", mode);
    textarea.value = "";
    textarea.autosize();
    renderSend();
    closePopover();
    palette = null;
    await onSubmit(prompt, mode, p, { model: model === "default" ? null : model, effort, ultracode, web, attachments: files, after });
  };

  // Đang chạy: ô trống thì nút là ■ Dừng, gõ chữ (hoặc đính kèm) thì nút thành ↑ Gửi.
  const hasDraft = () => !!textarea.value.trim() || attachments.length > 0;
  const showStop = () => busy && !hasDraft();
  // Câu kiểu "xong thì…", "sau đó…" là việc để sau: tự bật "Sau lượt" (người dùng vẫn tắt được).
  const AFTER_HINT = /^\s*(xong (thì|rồi|xuôi)|làm xong|khi (nào )?xong|sau (đó|khi)|cuối cùng|rồi sau đó)/i;
  const renderSend = () => {
    if (busy && !afterTouched) afterTurn = AFTER_HINT.test(textarea.value);
    const stop = showStop();
    sendBtn.textContent = stop ? "■" : "↑";
    sendBtn.classList.toggle("stop", stop);
    sendBtn.title = stop ? "Dừng" : busy ? (afterTurn ? "Gửi khi Claude xong lượt (Enter)" : "Chèn vào việc Claude đang làm (Enter)") : "Gửi (Enter)";
    afterChip.style.display = busy && hasDraft() ? "" : "none";
    afterChip.classList.toggle("on", afterTurn);
    afterChip.textContent = afterTurn ? "⏭ Sau lượt" : "↳ Chèn ngay";
  };
  sendBtn.addEventListener("click", () => (showStop() ? onStop?.() : submit()));

  textarea.addEventListener("keydown", (e) => {
    const composing = e.isComposing || e.keyCode === 229;
    if (palette && !composing) {
      if (e.key === "ArrowDown") return e.preventDefault(), highlight(Math.min(palette.index + 1, palette.items.length - 1));
      if (e.key === "ArrowUp") return e.preventDefault(), highlight(Math.max(palette.index - 1, 0));
      if ((e.key === "Enter" || e.key === "Tab") && palette.items.length) return e.preventDefault(), pick(palette.items[palette.index]);
      if (e.key === "Escape") return e.preventDefault(), closePopover(), (palette = null);
    }
    // Enter gửi, Shift + Enter xuống dòng. Bỏ qua Enter khi bộ gõ (Telex/VNI) đang ghép chữ.
    if (e.key === "Enter" && !e.shiftKey && !composing) {
      e.preventDefault();
      submit(e.altKey);
    }
  });

  const setMode = (value, onchange) => {
    const sel = modeSelect(value, onchange);
    sel.classList.add("chip-select");
    modeSlot.replaceChildren(sel);
  };
  if (showMode) setMode(mode, (v) => (mode = v));
  renderSend();
  renderModelChip();

  renderAttachments();
  box.append(
    attachBar,
    textarea,
    h(
      "div",
      { class: "row" },
      plusBtn,
      slashBtn,
      ctxWrap,
      cacheChip,
      picker,
      modeSlot,
      modelBtn,
      webChip,
      h("span", { class: "spacer" }),
      h("span", { class: "hint" }, "Enter gửi · Shift+Enter xuống dòng"),
      afterChip,
      sendBtn,
    ),
  );
  const el = h("div", { class: "composer" + (card ? " inline" : "") }, box);
  el.focus = () => textarea.focus();
  el.textarea = textarea;
  el.setMode = setMode;
  // Task view: hiển thị model/effort của task, đổi thì lưu vào task.
  el.setModelOptions = (m, e, u, w, onchange) => {
    if (model === (m || "default") && effort === (e ?? null) && ultracode === !!u && web === !!w && onModelChange) return;
    model = m || "default";
    effort = e ?? null;
    ultracode = !!u;
    web = !!w;
    onModelChange = onchange;
    renderModelChip();
  };
  el.setBusy = (value, stop) => {
    busy = value;
    onStop = stop;
    textarea.placeholder = busy ? "Claude đang làm việc… nhắn thêm để bổ sung, hoặc bấm ■ để dừng" : placeholder;
    renderSend();
    renderContext();
  };
  el.setContext = (t, compact) => {
    ctxTask = t;
    onCompact = compact;
    renderContext();
  };
  return el;
}

// Trạng thái prompt gửi lúc Claude đang chạy (xem AgentManager.setDelivery).
const DELIVERY = {
  pending: ["Đang chờ Claude đọc…", "wait"],
  later: ["Sẽ chạy khi Claude xong lượt hiện tại", "wait"],
  delivered: ["✓ Claude đã nhận", "ok"],
  cancelled: ["Không gửi: task đã dừng", "err"],
};
function deliveryNote(d) {
  const [text, tone] = DELIVERY[d] ?? [];
  return text ? h("div", { class: `delivery ${tone}` }, text) : null;
}

function taskCard(t, showProject = true) {
  return h(
    "div",
    { class: "task-card", onclick: () => navigate({ type: "task", id: t.id }) },
    h(
      "div",
      { class: "top" },
      h("span", { class: `dot ${statusTone(t)}` }),
      statusLabel(t),
      showProject ? ` · ${projectOf(t)?.name ?? ""}` : "",
      ` · ${timeAgo(t.updatedAt)}`,
    ),
    h("div", { class: "title" }, t.title),
    t.lastText ? h("div", { class: "last" }, plainText(t.lastText)) : null,
  );
}

function taskSections(tasks, showProject) {
  const active = tasks.filter((t) => ACTIVE.has(t.status));
  const rest = tasks.filter((t) => !ACTIVE.has(t.status));
  if (!tasks.length) return [h("div", { class: "empty" }, "Chưa có task nào.")];
  return [
    active.length ? h("h2", {}, `Đang chạy (${active.length})`) : null,
    active.length ? h("div", { class: "task-grid" }, active.map((t) => taskCard(t, showProject))) : null,
    rest.length ? h("h2", {}, "Gần đây") : null,
    rest.length ? h("div", { class: "task-grid" }, rest.slice(0, 60).map((t) => taskCard(t, showProject))) : null,
  ];
}

// ---------- explorer ----------

const DIM = new Set(["node_modules", "dist", "build", ".next", ".nuxt", ".cache", "coverage", "vendor", "__pycache__", ".venv"]);

const explorer = {
  projectId: null,
  expanded: new Map(), // projectId -> Set(rel)
  hidden: localStorage.getItem("explorerHidden") === "1",
  timer: null,

  scheduleRefresh() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => renderExplorer(true), 400);
  },
};

const viewProjectId = () => {
  const v = state.view;
  if (v.type === "project") return v.id;
  if (v.type === "task") return state.tasks.find((t) => t.id === v.id)?.projectId ?? null;
  return null;
};

// Chèn @đường-dẫn vào ô nhập của màn hình hiện tại.
function insertMention(rel) {
  const ta = currentView?.composer?.textarea;
  if (!ta || ta.disabled) return;
  const text = `@${rel} `;
  const { selectionStart: a, selectionEnd: b, value } = ta;
  const pad = a > 0 && !/\s/.test(value[a - 1]) ? " " : "";
  ta.value = value.slice(0, a) + pad + text + value.slice(b);
  ta.autosize?.();
  ta.focus();
  ta.selectionStart = ta.selectionEnd = a + pad.length + text.length;
}

// Icon file theo đuôi, kiểu Seti của VSCode: [ký hiệu, màu].
const FILE_ICONS = {
  js: ["JS", "#cbcb41"], mjs: ["JS", "#cbcb41"], cjs: ["JS", "#cbcb41"], jsx: ["⚛", "#519aba"],
  ts: ["TS", "#519aba"], tsx: ["⚛", "#519aba"], json: ["{}", "#cbcb41"], md: ["M↓", "#519aba"],
  css: ["#", "#519aba"], scss: ["#", "#f55385"], html: ["<>", "#e37933"], vue: ["V", "#8dc149"],
  py: ["py", "#519aba"], go: ["go", "#519aba"], rs: ["rs", "#e37933"], php: ["php", "#a074c4"],
  java: ["J", "#cc3e44"], swift: ["sw", "#e37933"], sh: ["$", "#8dc149"], yml: ["!", "#a074c4"],
  yaml: ["!", "#a074c4"], svg: ["◇", "#a074c4"], png: ["▣", "#a074c4"], jpg: ["▣", "#a074c4"],
  gif: ["▣", "#a074c4"], webp: ["▣", "#a074c4"], lock: ["🔒", "#888"], env: ["⚙", "#cbcb41"],
  sql: ["db", "#f55385"], txt: ["≡", "#888"],
};

function fileIcon(name) {
  const lower = name.toLowerCase();
  const ext = lower.startsWith(".env") ? "env" : lower.includes(".") ? lower.split(".").pop() : "";
  const [glyph, color] = FILE_ICONS[ext] ?? ["≡", "#8a8a8a"];
  return h("span", { class: "ficon", style: `color:${color}` }, glyph);
}

const CHEVRON =
  '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

const INDENT = 8;

// ---------- explorer: tạo / đổi tên / xoá file, menu chuột phải ----------

const SEARCH_ICON_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/></svg>';
const EX_ICONS = {
  newFile:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h3.5"/><path d="M9.5 1.5 13 5v2.5M9.5 1.5V5H13"/><path d="M12 9.5v5M9.5 12h5"/></svg>',
  newFolder:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M8 13.5H2.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3.6l1.4 1.6h6a1 1 0 0 1 1 1V8"/><path d="M12 9.5v5M9.5 12h5"/></svg>',
  refresh:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M12.5 1.8v2.8H9.7"/></svg>',
  collapse:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M5.5 8h5"/></svg>',
  search: SEARCH_ICON_SVG,
  hide: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
};

function exButton(icon, title, onClick) {
  const b = h("button", { class: "icon-btn ex-btn", title, onclick: onClick });
  b.innerHTML = EX_ICONS[icon];
  return b;
}

const parentOf = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const baseName = (rel) => rel.split("/").pop();
const joinRel = (dir, name) => (dir ? `${dir}/${name}` : name);

// Thư mục đích khi tạo mới: thư mục đang chọn, hoặc thư mục chứa file đang chọn.
function newItemParent() {
  if (!explorer.selected) return "";
  return explorer.selectedDir ? explorer.selected : parentOf(explorer.selected);
}

function expandTo(open, rel) {
  let cur = "";
  for (const part of rel.split("/").filter(Boolean)) {
    cur = joinRel(cur, part);
    open.add(cur);
  }
}

// Ô nhập tên trong cây (tạo mới / đổi tên). Giữ nguyên một element để
// cây render lại (Claude sửa file…) không làm mất chữ đang gõ.
function treeInput(initial, onCommit, selectEnd) {
  const input = h("input", { class: "tree-input", value: initial, spellcheck: "false" });
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    explorer.edit = null;
    if (commit && input.value.trim() && input.value.trim() !== initial) await onCommit(input.value.trim());
    renderExplorer(true);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) finish(true);
    if (e.key === "Escape") finish(false);
  });
  // Cây render lại sẽ gỡ input khỏi DOM tạm thời: chỉ coi là "rời đi" khi input vẫn đang hiển thị.
  input.addEventListener("blur", () =>
    setTimeout(() => !explorer.rendering && input.isConnected && document.activeElement !== input && finish(true), 0),
  );
  input.addEventListener("click", (e) => e.stopPropagation());
  input.selectRange = () => input.setSelectionRange(0, selectEnd ?? initial.length);
  return input;
}

function startCreate(dir, parent = newItemParent()) {
  const projectId = explorer.projectId;
  if (!projectId) return;
  if (explorer.hidden) {
    explorer.hidden = false;
    localStorage.setItem("explorerHidden", "0");
  }
  expandTo(explorer.expanded.get(projectId) ?? new Set(), parent);
  const input = treeInput("", async (name) => {
    const rel = joinRel(parent, name.replace(/^\/+|\/+$/g, ""));
    const res = await api.createPath({ projectId, rel, dir });
    if (res.error) return alertDialog(dir ? "Không tạo được thư mục" : "Không tạo được file", res.error);
    explorer.selected = rel;
    explorer.selectedDir = dir;
    const open = explorer.expanded.get(projectId);
    expandTo(open, dir ? rel : parentOf(rel));
    if (!dir) window.openInEditor?.(projectId, rel);
    refreshGit(projectId);
  });
  explorer.edit = { mode: "create", parent, dir, input };
  renderExplorer(true);
}

function startRenamePath(rel, isDir) {
  const projectId = explorer.projectId;
  const name = baseName(rel);
  const dot = name.lastIndexOf(".");
  const input = treeInput(
    name,
    async (newName) => {
      const to = joinRel(parentOf(rel), newName);
      const res = await api.renamePath({ projectId, from: rel, to });
      if (res.error) return alertDialog("Không đổi tên được", res.error);
      // Cập nhật các thư mục đang mở và lựa chọn theo đường dẫn mới.
      const open = explorer.expanded.get(projectId);
      for (const p of [...open]) {
        if (p === rel || p.startsWith(rel + "/")) {
          open.delete(p);
          open.add(to + p.slice(rel.length));
        }
      }
      explorer.selected = to;
      window.editorHandleRename?.(projectId, rel, to);
      refreshGit(projectId);
    },
    !isDir && dot > 0 ? dot : undefined,
  );
  explorer.edit = { mode: "rename", rel, input };
  renderExplorer(true);
}

async function deletePath(rel, isDir) {
  const projectId = explorer.projectId;
  const dirtyOpen = window.editorDirtyUnder?.(projectId, rel) ?? 0;
  const ok = await confirmDialog({
    title: isDir ? "Xoá thư mục?" : "Xoá file?",
    message: [
      h("b", {}, rel),
      isDir ? h("div", {}, "Thư mục và toàn bộ nội dung bên trong sẽ được chuyển vào Thùng rác.") : h("div", {}, "File sẽ được chuyển vào Thùng rác."),
      dirtyOpen ? h("div", { class: "warn-text" }, `${dirtyOpen} file đang mở có thay đổi chưa lưu sẽ bị mất.`) : null,
      h("div", { class: "hint" }, "Có thể khôi phục lại từ Thùng rác của macOS."),
    ],
    confirmText: "Chuyển vào Thùng rác",
  });
  if (!ok) return;
  const res = await api.trashPath({ projectId, rel });
  if (res.error) return alertDialog("Không xoá được", res.error);
  window.editorHandleDelete?.(projectId, rel);
  if (explorer.selected === rel || explorer.selected?.startsWith(rel + "/")) explorer.selected = null;
  refreshGit(projectId);
  renderExplorer(true);
  refreshGit(projectId);
}

// Mở các thư mục cha và chọn file trong Explorer (từ menu tab editor).
function revealInExplorer(projectId, rel) {
  if (!explorer.expanded.has(projectId)) explorer.expanded.set(projectId, new Set());
  const open = explorer.expanded.get(projectId);
  for (let dir = parentOf(rel); dir; dir = parentOf(dir)) open.add(dir);
  explorer.selected = rel;
  if (explorer.hidden) {
    explorer.hidden = false;
    localStorage.setItem("explorerHidden", "0");
  }
  renderExplorer(true);
}

// Menu chuột phải.
function showContextMenu(x, y, items) {
  closeContextMenu();
  const menu = h(
    "div",
    { class: "ctx-menu" },
    items.filter(Boolean).map((it) =>
      it === "-"
        ? h("div", { class: "ctx-sep" })
        : h(
            "div",
            {
              class: "ctx-item" + (it.danger ? " danger" : "") + (it.disabled ? " disabled" : ""),
              onclick: () => {
                if (it.disabled) return;
                closeContextMenu();
                it.run();
              },
            },
            h("span", {}, it.label),
            it.key ? h("span", { class: "ctx-key" }, it.key) : null,
          ),
    ),
  );
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 6)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 6)}px`;
  const onDoc = (e) => !menu.contains(e.target) && closeContextMenu();
  const onKey = (e) => e.key === "Escape" && closeContextMenu();
  setTimeout(() => {
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
  }, 0);
  showContextMenu.current = { menu, onDoc, onKey };
}

function closeContextMenu() {
  const cur = showContextMenu.current;
  if (!cur) return;
  cur.menu.remove();
  document.removeEventListener("mousedown", cur.onDoc);
  document.removeEventListener("keydown", cur.onKey);
  showContextMenu.current = null;
}

function entryMenu(ev, projectId, rel, isDir) {
  ev.preventDefault();
  ev.stopPropagation();
  explorer.selected = rel;
  explorer.selectedDir = isDir;
  renderExplorer(true);
  const project = state.projects.find((p) => p.id === projectId);
  const parent = isDir ? rel : parentOf(rel);
  showContextMenu(ev.clientX, ev.clientY, [
    { label: "Tạo file mới…", run: () => startCreate(false, parent) },
    { label: "Tạo thư mục mới…", run: () => startCreate(true, parent) },
    "-",
    !isDir && { label: "Mở trong editor", run: () => window.openInEditor(projectId, rel) },
    !isDir && { label: "Mở bằng VSCode", run: () => api.openFile({ projectId, rel }) },
    { label: "Hiện trong Finder", run: () => api.openFile({ projectId, rel, target: "finder" }) },
    { label: "Chèn @ vào prompt", key: "⌘ bấm", run: () => insertMention(rel) },
    "-",
    { label: "Sao chép đường dẫn", run: () => navigator.clipboard.writeText(`${project.path}/${rel}`) },
    { label: "Sao chép đường dẫn tương đối", run: () => navigator.clipboard.writeText(rel) },
    "-",
    { label: "Đổi tên…", key: "↩", run: () => startRenamePath(rel, isDir) },
    { label: "Xoá", key: "⌘⌫", danger: true, run: () => deletePath(rel, isDir) },
  ]);
}

function rootMenu(ev) {
  if (ev.target.closest(".tree-row")) return;
  ev.preventDefault();
  explorer.selected = null;
  renderExplorer(true);
  showContextMenu(ev.clientX, ev.clientY, [
    { label: "Tạo file mới…", run: () => startCreate(false, "") },
    { label: "Tạo thư mục mới…", run: () => startCreate(true, "") },
    "-",
    { label: "Làm mới", run: () => renderExplorer(true) },
  ]);
}

// Phím tắt khi cây đang được focus (giống VSCode trên macOS).
function treeKeydown(e) {
  if (explorer.edit || !explorer.selected) return;
  if (e.key === "Enter") {
    e.preventDefault();
    startRenamePath(explorer.selected, explorer.selectedDir);
  } else if ((e.key === "Backspace" && e.metaKey) || e.key === "Delete") {
    e.preventDefault();
    deletePath(explorer.selected, explorer.selectedDir);
  }
}

function editRow(depth, dir, input) {
  const twisty = h("span", { class: "twisty" });
  if (dir) twisty.innerHTML = CHEVRON;
  return h("div", { class: "tree-row editing", style: `padding-left:${4 + depth * INDENT}px` }, twisty, dir ? null : fileIcon(input.value || "x"), input);
}

function restoreTreeInputFocus() {
  const input = explorer.edit?.input;
  if (!input?.isConnected || document.activeElement === input) return;
  input.focus();
  if (!input.dataset.selected) {
    input.selectRange();
    input.dataset.selected = "1";
  }
}

async function treeNodes(projectId, rel, depth, open) {
  const entries = await api.listDir({ projectId, rel });
  const out = [];
  const edit = explorer.edit;
  if (edit?.mode === "create" && edit.parent === rel) out.push(editRow(depth, edit.dir, edit.input));
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    const isOpen = e.dir && open.has(childRel);
    if (edit?.mode === "rename" && edit.rel === childRel) {
      out.push(editRow(depth, e.dir, edit.input));
      if (isOpen) {
        const children = await treeNodes(projectId, childRel, depth + 1, open);
        out.push(h("div", { class: "tree-group", style: `--guide:${4 + depth * INDENT + 11}px` }, ...children));
      }
      continue;
    }
    const twisty = h("span", { class: "twisty" + (isOpen ? " open" : "") });
    if (e.dir) twisty.innerHTML = CHEVRON;
    const row = h(
      "div",
      {
        class:
          "tree-row" +
          (DIM.has(e.name) || e.name.startsWith(".") ? " dim" : "") +
          gitTone(projectId, childRel, e.dir) +
          (explorer.selected === childRel ? " selected" : ""),
        style: `padding-left:${4 + depth * INDENT}px`,
        title: childRel + "\n⌘ + bấm: chèn vào prompt · ⌥ + bấm: mở bằng VSCode · Chuột phải: thêm thao tác",
        onclick: (ev) => {
          explorer.selected = childRel;
          explorer.selectedDir = e.dir;
          if (ev.metaKey) return insertMention(childRel), renderExplorer(true);
          if (!e.dir) {
            if (ev.altKey) api.openFile({ projectId, rel: childRel });
            else window.openInEditor(projectId, childRel);
            return renderExplorer(true);
          }
          isOpen ? open.delete(childRel) : open.add(childRel);
          renderExplorer(true);
        },
        oncontextmenu: (ev) => entryMenu(ev, projectId, childRel, e.dir),
      },
      twisty,
      e.dir ? null : fileIcon(e.name),
      h("span", { class: "fname" }, e.name),
    );
    out.push(row);
    if (isOpen) {
      const children = await treeNodes(projectId, childRel, depth + 1, open);
      // Đường kẻ dọc thụt lề như VSCode.
      out.push(h("div", { class: "tree-group", style: `--guide:${4 + depth * INDENT + 11}px` }, ...children));
    }
  }
  return out;
}

async function renderExplorer(keepScroll = false) {
  explorer.rendering = (explorer.rendering ?? 0) + 1;
  try {
    await renderExplorerInner(keepScroll);
  } finally {
    explorer.rendering--;
    restoreTreeInputFocus();
  }
}

async function renderExplorerInner(keepScroll) {
  const el = document.getElementById("explorer");
  const projectId = viewProjectId();
  const project = state.projects.find((p) => p.id === projectId);
  explorer.projectId = projectId;

  if (!project) {
    el.style.display = "none";
    return;
  }
  el.style.display = "";
  el.classList.toggle("collapsed", explorer.hidden);

  const toggle = () => {
    explorer.hidden = !explorer.hidden;
    localStorage.setItem("explorerHidden", explorer.hidden ? "1" : "0");
    renderExplorer();
  };

  if (explorer.hidden) {
    el.replaceChildren(h("button", { class: "explorer-toggle", title: "Hiện Explorer", onclick: toggle }, "‹"));
    return;
  }

  if (!explorer.expanded.has(projectId)) explorer.expanded.set(projectId, new Set());
  const open = explorer.expanded.get(projectId);

  // Giữ nguyên cây cũ cho tới khi tải xong cây mới (tránh nháy khi làm mới).
  const prev = el.querySelector(".tree");
  const sameProject = prev?.dataset.project === projectId;
  const scroll = keepScroll && sameProject ? prev.scrollTop : 0;
  const tree = sameProject ? prev : h("div", { class: "tree", tabindex: "0", onkeydown: treeKeydown, oncontextmenu: rootMenu });
  tree.dataset.project = projectId;

  el.replaceChildren(
    h(
      "div",
      { class: "explorer-head" },
      h("span", { class: "title", title: project.path }, project.name),
      exButton("search", "Tìm file theo tên hoặc nội dung (⌘P)", () => openFileSearch()),
      exButton("newFile", "Tạo file mới", () => startCreate(false)),
      exButton("newFolder", "Tạo thư mục mới", () => startCreate(true)),
      exButton("refresh", "Làm mới", () => renderExplorer(true)),
      exButton("collapse", "Thu gọn tất cả", () => (open.clear(), renderExplorer())),
      exButton("hide", "Ẩn Explorer", toggle),
    ),
    tree,
    gitBar,
    explorerResizer,
  );
  renderGit(projectId);
  refreshGit(projectId);

  const nodes = await treeNodes(projectId, "", 0, open);
  if (explorer.projectId !== projectId) return; // đã chuyển project trong lúc tải
  tree.replaceChildren(...(nodes.length ? nodes : [h("div", { class: "hint", style: "padding:8px 12px" }, "Thư mục trống")]));
  tree.scrollTop = scroll;
  restoreTreeInputFocus();
  explorer.edit?.input.scrollIntoView({ block: "nearest" });
}

// ---------- git (góc dưới cột phải) ----------

const gitBar = h("div", { class: "git-bar" });
const gitCache = new Map(); // projectId -> status | null

const GIT_ICONS = {
  gitlab:
    '<svg width="14" height="14" viewBox="0 0 24 24"><path fill="#e24329" d="M12 21.4 15.7 10H8.3z"/><path fill="#fc6d26" d="M12 21.4 8.3 10H3.1z"/><path fill="#fca326" d="M3.1 10 2 13.4c-.1.3 0 .7.3.9L12 21.4z"/><path fill="#e24329" d="M3.1 10h5.2L6.1 3.1c-.1-.4-.6-.4-.7 0z"/><path fill="#fc6d26" d="M12 21.4 15.7 10h5.2z"/><path fill="#fca326" d="m20.9 10 1.1 3.4c.1.3 0 .7-.3.9L12 21.4z"/><path fill="#e24329" d="M20.9 10h-5.2l2.2-6.9c.1-.4.6-.4.7 0z"/></svg>',
  github:
    '<svg width="14" height="14" viewBox="0 0 16 16"><path fill="#ccc" d="M8 0C3.6 0 0 3.6 0 8c0 3.5 2.3 6.5 5.5 7.6.4.1.5-.2.5-.4v-1.4c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.3 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8.6-.2 1.3-.3 2-.3s1.4.1 2 .3c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.7-3.6 3.9.3.3.5.8.5 1.5v2.2c0 .2.1.5.6.4C13.7 14.5 16 11.5 16 8c0-4.4-3.6-8-8-8z"/></svg>',
  branch:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-6.5 4"/></svg>',
};

function svgSpan(svg, cls = "") {
  const el = h("span", { class: `svg ${cls}` });
  el.innerHTML = svg;
  return el;
}

function renderGit(projectId) {
  const st = gitCache.get(projectId);
  if (!st) {
    gitBar.style.display = "none";
    return;
  }
  gitBar.style.display = "";
  const dirty = st.changed + st.staged + st.untracked;
  const providerName = { gitlab: "GitLab", github: "GitHub", bitbucket: "Bitbucket" }[st.provider];
  const parts = [
    st.provider && GIT_ICONS[st.provider]
      ? h(
          "span",
          {
            class: "git-provider" + (st.remoteUrl ? " link" : ""),
            title: st.remoteUrl ? `Mở trên ${providerName}: ${st.remoteUrl}` : "",
            onclick: () => st.remoteUrl && api.openUrl(st.remoteUrl),
          },
          svgSpan(GIT_ICONS[st.provider]),
        )
      : null,
    h(
      "span",
      {
        class: "git-branch" + (st.remoteUrl ? " link" : ""),
        title: `Nhánh: ${st.branch}${st.upstream ? `\nUpstream: ${st.upstream}` : "\nChưa có upstream"}${st.detached ? "\n(detached HEAD)" : ""}`,
        onclick: () => st.remoteUrl && !st.detached && api.openUrl(`${st.remoteUrl}/-/tree/${encodeURIComponent(st.branch)}`.replace("/-/tree/", st.provider === "gitlab" ? "/-/tree/" : "/tree/")),
      },
      svgSpan(GIT_ICONS.branch, "muted"),
      h("span", { class: "name" }, st.branch),
    ),
    h("span", { class: "spacer" }),
    st.conflicts ? h("span", { class: "git-pill err", title: "File đang xung đột" }, `⚠ ${st.conflicts}`) : null,
    dirty
      ? h(
          "span",
          {
            class: "git-pill warn",
            title: [st.staged && `${st.staged} đã stage`, st.changed && `${st.changed} đã sửa`, st.untracked && `${st.untracked} file mới`].filter(Boolean).join(" · "),
          },
          `● ${dirty}`,
        )
      : h("span", { class: "git-pill ok", title: "Không có thay đổi" }, "✓"),
    st.ahead ? h("span", { class: "git-pill", title: `${st.ahead} commit chưa push` }, `↑${st.ahead}`) : null,
    st.behind ? h("span", { class: "git-pill", title: `${st.behind} commit chưa pull` }, `↓${st.behind}`) : null,
  ];
  gitBar.replaceChildren(...parts.filter(Boolean));
}

async function refreshGit(projectId = explorer.projectId) {
  if (!projectId) return;
  const [st, files] = await Promise.all([api.gitStatus(projectId), api.gitFiles(projectId)]);
  gitCache.set(projectId, st);
  if (explorer.projectId === projectId) renderGit(projectId);
  // Màu file trong cây đổi thì vẽ lại cây (và tab editor).
  const key = JSON.stringify(files);
  if (gitFileKey.get(projectId) !== key) {
    gitFileKey.set(projectId, key);
    gitFiles.set(projectId, indexGitFiles(files));
    if (explorer.projectId === projectId) renderExplorer(true);
    window.syncEditor?.();
  }
}

// ----- màu file theo git (kiểu WebStorm) -----
// xanh lá = đã sửa / đã git add (cần commit), đỏ = chưa git add, cam = xung đột, vàng nâu mờ = bị ignore.
const gitFiles = new Map(); // projectId -> { files, dirs, ignored }
const gitFileKey = new Map();
const GIT_RANK = { U: 3, M: 2, "?": 1 };

function indexGitFiles(data) {
  if (!data) return null;
  const files = new Map(Object.entries(data.files));
  const dirs = new Map();
  for (const [f, code] of files) {
    // Thư mục mang màu "nặng" nhất trong các file bên trong.
    let d = f;
    while (d.includes("/")) {
      d = d.slice(0, d.lastIndexOf("/"));
      if ((GIT_RANK[dirs.get(d)] ?? 0) < GIT_RANK[code]) dirs.set(d, code);
    }
  }
  const ignored = data.ignored.map((p) => p.replace(/\/$/, ""));
  return { files, dirs, ignored };
}

function gitTone(projectId, rel, isDir) {
  const g = gitFiles.get(projectId);
  if (!g) return "";
  const code = isDir ? g.dirs.get(rel) : g.files.get(rel);
  if (code === "M") return " git-mod";
  if (code === "?") return " git-new";
  if (code === "U") return " git-conflict";
  if (g.ignored.some((p) => rel === p || rel.startsWith(p + "/"))) return " git-ignored";
  return "";
}
window.gitTone = gitTone;

setInterval(() => refreshGit(), 30000);
window.addEventListener("focus", () => refreshGit());

// ---------- views ----------

function overviewView(main) {
  if (!state.projects.length) {
    main.append(
      h("div", { class: "header" }, h("h1", {}, "Tổng quan")),
      h(
        "div",
        { class: "content" },
        h(
          "div",
          { class: "empty" },
          h("p", {}, "Chưa có project nào."),
          h("button", { class: "primary", onclick: addProject }, "＋ Thêm project"),
        ),
      ),
    );
    return { update() {} };
  }

  const list = h("div");
  const comp = composer({
    placeholder: "Giao việc cho Claude… (chọn project bên dưới)",
    showProjectPicker: true,
    onSubmit: async (prompt, mode, projectId, opts) => {
      await api.createTask({ projectId, prompt, permissionMode: mode, ...opts });
      comp.focus();
    },
  });
  comp.classList.add("dock");
  const counter = h("span", { class: "sub" });
  const pm = pmSection();
  main.append(h("div", { class: "header" }, h("h1", {}, "Tổng quan ", counter)), h("div", { class: "content" }, pm.el, list), comp);
  const update = () => {
    pm.update(); // nút Xử lý/Mở task phụ thuộc trạng thái task
    const running = state.tasks.filter((t) => ACTIVE.has(t.status) && t.status !== "queued").length;
    const queued = state.tasks.filter((t) => t.status === "queued").length;
    counter.textContent = `· Đang chạy ${running}/${state.settings.maxConcurrent}` + (queued ? ` · ${queued} đang chờ lượt` : "");
    const all = [...state.tasks].sort((a, b) => b.updatedAt - a.updatedAt);
    list.replaceChildren(...taskSections(all, true).filter(Boolean));
  };
  update();
  comp.focus();
  return { update, updatePm: pm.update, composer: comp };
}

function projectView(main, id) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return navigate({ type: "overview" });

  const list = h("div");
  const comp = composer({
    placeholder: `Giao việc mới cho ${p.name}…`,
    projectId: p.id,
    onSubmit: async (prompt, mode, _pid, opts) => {
      const t = await api.createTask({ projectId: p.id, prompt, permissionMode: mode, ...opts });
      navigate({ type: "task", id: t.id });
    },
  });

  const title = h("h1", {}, p.name, " ", h("span", { class: "sub project-path" }, p.path));
  const rename = () => {
    const input = h("input", { value: p.name });
    const save = async () => {
      const name = input.value.trim();
      if (name && name !== p.name) {
        await api.renameProject({ id: p.id, name });
        p.name = name;
      }
      navigate(state.view);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save();
      if (e.key === "Escape") navigate(state.view);
    });
    input.addEventListener("blur", save);
    title.replaceChildren(input);
    input.focus();
    input.select();
  };
  const remove = async () => {
    const n = tasksOf(p.id).length;
    const ok = await confirmDialog({
      title: "Xoá project khỏi app?",
      message: [
        h("b", {}, p.name),
        h("div", { class: "hint" }, p.path),
        h("div", {}, `Các file trên máy vẫn được giữ nguyên.${n ? ` ${n} task của project này sẽ bị xoá.` : ""}`),
      ],
      confirmText: "Xoá project",
    });
    if (!ok) return;
    await api.removeProject(p.id);
    state.projects = state.projects.filter((x) => x.id !== p.id);
    state.tasks = state.tasks.filter((t) => t.projectId !== p.id);
    navigate({ type: "overview" });
  };

  main.append(
    h(
      "div",
      { class: "header" },
      title,
      h("button", { onclick: () => api.openProject({ id: p.id, app: "vscode" }) }, "VSCode"),
      h("button", { onclick: () => api.openProject({ id: p.id, app: "finder" }) }, "Finder"),
      h("button", { title: "Bật/tắt terminal (⌃`)", onclick: () => toggleTerminal() }, "Terminal"),
      h("button", { onclick: rename }, "Đổi tên"),
      h("button", { class: "danger", onclick: remove }, "Xoá"),
    ),
    h("div", { class: "content" }, list),
    comp,
  );
  comp.classList.add("dock");
  const update = () => list.replaceChildren(...taskSections(tasksOf(p.id), false).filter(Boolean));
  update();
  comp.focus();
  return { update, composer: comp };
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });

const basename = (p) => (typeof p === "string" ? p.split("/").pop() : "");

// Nhãn hiển thị cạnh tên tool (giống panel Claude Code).
function toolLabel(name, input = {}) {
  if (input.description) return input.description;
  if (input.file_path) return basename(input.file_path);
  if (input.pattern) return input.pattern;
  if (input.url) return input.url;
  if (input.prompt) return String(input.prompt).split("\n")[0];
  return "";
}

// Nội dung dòng IN.
function toolInput(name, input = {}) {
  if (typeof input.command === "string") return input.command;
  if (name === "Edit" && input.file_path) return `${input.file_path}\n- ${input.old_string ?? ""}\n+ ${input.new_string ?? ""}`;
  if (name === "Write" && input.file_path) return `${input.file_path}\n${input.content ?? ""}`;
  if (input.file_path) return input.file_path;
  return JSON.stringify(input, null, 2);
}

function tlItem(dotClass, ...body) {
  return h("div", { class: "tl-item" }, h("span", { class: `tl-dot ${dotClass}` }), h("div", { class: "tl-body" }, ...body));
}

function ioRow(label, text, cls = "") {
  const pre = h("pre", {}, text);
  const row = h("div", { class: `io ${cls}` }, h("span", { class: "io-label" }, label), pre);
  row.addEventListener("click", () => row.classList.toggle("open"));
  return row;
}

function permissionBox(e) {
  if (e.state !== "pending") {
    return h("div", { class: `perm-done ${e.state}` }, e.state === "allowed" ? "Đã cho phép" : "Đã từ chối");
  }
  const respond = (decision) => api.respondPermission({ requestId: e.requestId, decision });
  return h(
    "div",
    { class: "perm" },
    h("div", {}, "Cho phép Claude dùng ", h("b", {}, e.name), "?"),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "primary", onclick: () => respond("allow") }, "Cho phép"),
      h("button", { onclick: () => respond("always") }, "Luôn cho phép trong phiên"),
      h("button", { class: "danger", onclick: () => respond("deny") }, "Từ chối"),
    ),
  );
}

// Câu hỏi AskUserQuestion: mỗi câu là một nhóm phương án bấm chọn được, kèm ô "Khác…".
function questionBox(e) {
  if (e.state !== "pending") {
    return h(
      "div",
      { class: "q-done" },
      e.state === "answered"
        ? e.questions.map((q) => h("div", {}, h("span", { class: "q-head" }, q.header || q.question), " ", h("b", {}, e.answers?.[q.question] ?? "—")))
        : h("div", { class: "muted" }, "Đã bỏ qua câu hỏi"),
    );
  }
  const picks = e.questions.map(() => new Set());
  const others = e.questions.map(() => "");
  const submitBtn = h("button", { class: "primary", disabled: true }, "Gửi trả lời");
  const refresh = () => {
    submitBtn.disabled = !e.questions.every((_, i) => picks[i].size || others[i].trim());
  };
  const groups = e.questions.map((q, qi) => {
    const optEls = [];
    const toggle = (label) => {
      if (q.multiSelect) picks[qi].has(label) ? picks[qi].delete(label) : picks[qi].add(label);
      else {
        const was = picks[qi].has(label);
        picks[qi].clear();
        if (!was) picks[qi].add(label);
        otherInput.value = others[qi] = "";
      }
      optEls.forEach((el) => el.classList.toggle("on", picks[qi].has(el.dataset.label)));
      refresh();
    };
    for (const o of q.options ?? []) {
      const el = h(
        "div",
        { class: "q-opt", "data-label": o.label, onclick: () => toggle(o.label) },
        h("span", { class: q.multiSelect ? "q-mark box" : "q-mark" }),
        h("div", { class: "q-text" }, h("div", { class: "q-label" }, o.label), o.description ? h("div", { class: "q-desc" }, o.description) : null),
      );
      optEls.push(el);
    }
    const otherInput = h("input", { class: "q-other", placeholder: "Khác… (tự nhập câu trả lời)" });
    otherInput.addEventListener("input", () => {
      others[qi] = otherInput.value;
      if (!q.multiSelect && otherInput.value.trim()) {
        picks[qi].clear();
        optEls.forEach((el) => el.classList.remove("on"));
      }
      refresh();
    });
    otherInput.addEventListener("keydown", (ev) => ev.key === "Enter" && !ev.isComposing && !submitBtn.disabled && submitBtn.click());
    return h(
      "div",
      { class: "q-group" },
      h("div", { class: "q-title" }, q.header ? h("span", { class: "q-head" }, q.header) : null, h("span", {}, q.question)),
      q.multiSelect ? h("div", { class: "hint" }, "Chọn được nhiều phương án") : null,
      h("div", { class: "q-opts" }, optEls),
      otherInput,
    );
  });
  submitBtn.addEventListener("click", () => {
    const answers = {};
    e.questions.forEach((q, i) => {
      const vals = [...picks[i]];
      if (others[i].trim()) vals.push(others[i].trim());
      answers[q.question] = vals.join(", ");
    });
    api.answerQuestion({ requestId: e.requestId, answers });
  });
  return h(
    "div",
    { class: "q-box" },
    groups,
    h(
      "div",
      { class: "actions" },
      submitBtn,
      h("button", { onclick: () => api.respondPermission({ requestId: e.requestId, decision: "deny" }) }, "Bỏ qua"),
    ),
  );
}

function taskView(main, id) {
  const task = () => state.tasks.find((t) => t.id === id);
  if (!task()) return navigate({ type: "overview" });

  const header = h("div", { class: "header" });
  const tl = h("div", { class: "tl" });
  const working = h("div", { class: "working" }, h("span", { class: "spark" }, "✻"), " Đang làm việc…");
  const content = h("div", { class: "content" }, h("div", { class: "log" }, tl, working));

  const nodes = new Map(); // entry.id -> element
  const tools = new Map(); // toolUseId -> { item, card, permSlot }

  const comp = composer({
    placeholder: "Nhắn tiếp cho Claude…",
    projectId: task().projectId,
    showMode: false,
    onSubmit: (prompt, _mode, _pid, { attachments, after }) => api.sendToTask({ taskId: id, prompt, attachments, after }),
  });
  comp.classList.add("dock");

  main.append(header, content, comp);

  const nearBottom = () => content.scrollHeight - content.scrollTop - content.clientHeight < 80;
  const scrollDown = () => (content.scrollTop = content.scrollHeight);

  const put = (entryId, el, moved = false) => {
    const old = nodes.get(entryId);
    if (old && moved) old.remove();
    if (old && !moved) old.replaceWith(el);
    else tl.append(el);
    nodes.set(entryId, el);
  };

  const addEntry = (e) => {
    switch (e.kind) {
      case "user":
        return put(
          e.id,
          h(
            "div",
            { class: "tl-user" },
            h("div", { class: "time" }, fmtTime(e.at)),
            h(
              "div",
              { class: "bubble" },
              e.attachments?.length
                ? h(
                    "div",
                    { class: "attach-bar in-bubble" },
                    e.attachments.map((a) =>
                      h("div", { class: "attach-chip", title: a.path ?? a.name }, a.thumb ? h("img", { src: a.thumb, alt: "" }) : fileIcon(a.name), h("span", { class: "name" }, a.name)),
                    ),
                  )
                : null,
              e.text,
            ),
            deliveryNote(e.delivery),
          ),
          e.moved,
        );
      case "text":
        return put(e.id, tlItem("", markdownBlock(e.text)));
      case "thinking": {
        const d = h("details", { class: "thinking" }, h("summary", {}, "Đã suy nghĩ"), h("div", { class: "text" }, e.text));
        return put(e.id, tlItem("muted", d));
      }
      case "tool": {
        if (tools.has(e.toolUseId)) return;
        const isQ = e.name === "AskUserQuestion";
        const card = h("div", { class: "card" + (isQ ? " hidden" : "") }, isQ ? null : ioRow("IN", toolInput(e.name, e.input)));
        const permSlot = h("div");
        const item = tlItem(
          "pending",
          isQ
            ? h("div", { class: "tool-title" }, h("b", {}, "Claude hỏi bạn"))
            : h("div", { class: "tool-title" }, h("b", {}, e.name), " ", h("span", {}, toolLabel(e.name, e.input))),
          card,
          permSlot,
        );
        tools.set(e.toolUseId, { item, card, permSlot });
        return put(e.id, item);
      }
      case "tool_result": {
        const t = tools.get(e.toolUseId);
        if (!t) return;
        t.card.querySelector(".io.out")?.remove();
        if (e.text) t.card.append(ioRow("OUT", e.text, "out" + (e.isError ? " err" : "")));
        t.item.querySelector(".tl-dot").className = `tl-dot ${e.isError ? "err" : "ok"}`;
        return;
      }
      case "question": {
        const t = e.toolUseId && tools.get(e.toolUseId);
        const box = questionBox(e);
        if (t) {
          t.permSlot.replaceChildren(box);
          t.item.querySelector(".tl-dot").className = `tl-dot ${e.state === "pending" ? "warn" : e.state === "answered" ? "ok" : ""}`;
          return;
        }
        return put(e.id, tlItem(e.state === "pending" ? "warn" : "ok", h("div", { class: "tool-title" }, h("b", {}, "Claude hỏi bạn")), box));
      }
      case "permission": {
        const t = e.toolUseId && tools.get(e.toolUseId);
        if (t) {
          t.permSlot.replaceChildren(permissionBox(e));
          if (e.state === "pending") t.item.querySelector(".tl-dot").className = "tl-dot warn";
          else if (e.state === "denied") t.item.querySelector(".tl-dot").className = "tl-dot err";
          return;
        }
        return put(
          e.id,
          tlItem(e.state === "pending" ? "warn" : "", h("div", { class: "tool-title" }, h("b", {}, e.name), " ", toolLabel(e.name, e.input)), permissionBox(e)),
        );
      }
      case "result":
        return put(
          e.id,
          tlItem(
            e.ok ? "ok" : e.stopped ? "muted" : "err",
            h(
              "div",
              { class: "result" + (e.ok || e.stopped ? "" : " fail") },
              e.ok ? "Hoàn thành" : e.stopped ? "Đã dừng" : `Lỗi: ${e.text}`,
              e.durationMs != null ? ` · ${(e.durationMs / 1000).toFixed(1)}s` : "",
              e.turns != null ? ` · ${e.turns} lượt` : "",
              e.costUsd ? ` · $${e.costUsd.toFixed(4)}` : "",
            ),
          ),
        );
      case "compact":
        return put(
          e.id,
          tlItem(
            "muted",
            h(
              "div",
              { class: "result" },
              e.trigger === "auto" ? "Đã tự động nén ngữ cảnh" : "Đã nén ngữ cảnh",
              e.preTokens ? ` · ${Math.round(e.preTokens / 1000)}k${e.postTokens != null ? ` → ${Math.round(e.postTokens / 1000)}k` : ""} token` : "",
            ),
          ),
        );
      case "error":
        return put(e.id, tlItem("err", h("div", { class: "result fail" }, "Lỗi: ", e.text)));
    }
  };

  const update = () => {
    const t = task();
    if (!t) return;
    const p = projectOf(t);
    const busy = ACTIVE.has(t.status);
    header.replaceChildren(
      h(
        "div",
        { class: "title-block" },
        renaming.taskId === t.id && renaming.where === "header"
          ? renameInput(t)
          : h("h1", { class: "editable", title: "Bấm để đổi tên", onclick: () => startRename(t, "header") }, t.title),
        h(
          "div",
          { class: "sub" },
          h("span", { class: `chip ${statusTone(t)}` }, statusLabel(t)),
          ` ${p?.name ?? ""}`,
          t.costUsd ? ` · $${t.costUsd.toFixed(4)}` : "",
        ),
      ),
      h("button", { title: "Bật/tắt terminal (⌃`)", onclick: () => toggleTerminal() }, "Terminal"),
      h("button", { onclick: () => api.openProject({ id: t.projectId, app: "vscode" }) }, "VSCode"),
      h(
        "button",
        {
          class: "danger",
          onclick: () => deleteTask(t),
        },
        "Xoá",
      ),
    );
    working.style.display = busy ? "" : "none";
    working.lastChild.textContent =
      t.status === "waiting"
        ? t.waitingFor === "question"
          ? " Claude đang chờ bạn chọn phương án…"
          : " Đang chờ bạn duyệt…"
        : t.status === "queued"
          ? ` Đang chờ lượt: đã có ${state.settings.maxConcurrent} task chạy cùng lúc (đổi trong ⚙ Cài đặt)`
          : t.turnDone
            ? " Claude đã trả lời xong, đang chờ lệnh chạy nền… (bấm ■ để dừng hẳn)"
            : " Đang làm việc…";
    comp.setBusy(busy, () => api.stopTask(id));
    comp.setContext(t, () => api.sendToTask({ taskId: id, prompt: "/compact", attachments: [] }));
    comp.setMode(t.permissionMode, (permissionMode) => api.setTaskMode({ taskId: id, permissionMode }));
    comp.setModelOptions(t.model, t.effort, t.ultracode, t.web, ({ model, effort, ultracode, web }) =>
      api.setTaskMode({ taskId: id, model: model === "default" ? null : model, effort, ultracode, web }),
    );
    restoreRenameFocus();
  };

  api.getLog(id).then((entries) => {
    entries.forEach(addEntry);
    scrollDown();
  });
  update();
  comp.focus();
  if (!task().context && !ACTIVE.has(task().status)) api.taskContext(id);

  return {
    update,
    composer: comp,
    onEntry(taskId, entry) {
      if (taskId !== id) return;
      const stick = nearBottom();
      addEntry(entry);
      if (stick) scrollDown();
    },
  };
}

function renderMain() {
  const main = document.getElementById("main");
  main.replaceChildren();
  const v = state.view;
  currentView =
    (v.type === "project" && projectView(main, v.id)) ||
    (v.type === "task" && taskView(main, v.id)) ||
    (v.type === "overview" && overviewView(main)) ||
    currentView;
  renderExplorer();
  window.syncTerminal?.();
  window.syncEditor?.();
}

// ---------- tài khoản Claude ----------

const PLAN = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise", free: "Free" };
let auth = { status: null, required: false, loggingIn: false, loginOutput: "" };
let accountMenuOpen = false;

function authLabel(st) {
  if (!st) return ["Đang kiểm tra…", ""];
  if (st.missing) return ["Chưa có Claude Code", "Cài Claude Code hoặc nhập đường dẫn"];
  if (!st.loggedIn) return ["Chưa đăng nhập", ""];
  if (st.authMethod === "oauth_token" || (st.authMethod === "api_key" && !st.email)) {
    let host = "";
    try {
      host = state.settings.claudeBaseUrl ? new URL(state.settings.claudeBaseUrl).host : "";
    } catch {}
    return [st.email || "Đăng nhập bằng token", [st.authMethod === "api_key" ? "API key" : "Auth token", host].filter(Boolean).join(" · ")];
  }
  const who = st.email || st.orgName || "Đã đăng nhập";
  const how =
    st.authMethod === "claude.ai"
      ? `Claude ${PLAN[st.subscriptionType] ?? st.subscriptionType ?? ""}`.trim()
      : st.apiProvider && st.apiProvider !== "firstParty"
        ? st.apiProvider
        : "API key (Console)";
  return [who, how];
}

function loginPanel() {
  const code = h("input", { placeholder: "Dán mã từ trình duyệt (nếu có)…" });
  return h(
    "div",
    { class: "login-panel" },
    h("div", {}, "Đang chờ bạn đăng nhập trên trình duyệt…"),
    h(
      "div",
      { class: "row" },
      code,
      h("button", { onclick: () => code.value.trim() && api.sendAuthCode(code.value) }, "Gửi mã"),
      h("button", { onclick: () => api.cancelLogin() }, "Huỷ"),
    ),
  );
}

function renderAccount() {
  const st = auth.status;
  const bad = auth.required || (st && !st.loggedIn);
  const [who, how] = authLabel(st);
  const el = document.getElementById("account");

  const menu = accountMenuOpen
    ? h(
        "div",
        { class: "account-menu" },
        st?.orgName ? h("div", { class: "hint" }, st.orgName) : null,
        h("button", { onclick: () => api.login({}) }, bad ? "Đăng nhập" : "Đăng nhập lại"),
        st?.loggedIn
          ? h(
              "button",
              {
                onclick: async () => {
                  const ok = await confirmDialog({
                    title: "Đổi tài khoản?",
                    message: [
                      h("div", {}, "Đăng xuất ", h("b", {}, st.email ?? "tài khoản hiện tại"), " rồi đăng nhập tài khoản khác."),
                      h("div", { class: "warn-text" }, "Các task đang chạy có thể bị lỗi."),
                    ],
                    confirmText: "Đăng xuất",
                  });
                  if (!ok) return;
                  await api.logout();
                  api.login({});
                },
              },
              "Đổi tài khoản",
            )
          : null,
        h("button", { onclick: () => api.login({ console: true }) }, "Đăng nhập bằng API (Console)"),
        h("button", { onclick: () => ((accountMenuOpen = false), renderAccount(), settingsDialog({ focusToken: true })) }, "Dùng token được cấp…"),
        h("button", { onclick: () => api.refreshAuth() }, "Kiểm tra lại"),
      )
    : null;

  el.replaceChildren(
    ...[
      menu,
      auth.loggingIn ? loginPanel() : null,
      state.appVersion ? h("div", { class: "app-version" }, `ClaudeDeck v${state.appVersion}`) : null,
      h(
        "div",
        { class: "account-row" },
        h(
        "div",
        {
          class: "account-box" + (bad ? " bad" : ""),
          onclick: () => {
            accountMenuOpen = !accountMenuOpen;
            renderAccount();
          },
        },
        h("span", { class: "avatar" }, (st?.email || "?")[0].toUpperCase()),
        h("div", { class: "who" }, h("div", { class: "email" }, who), h("div", { class: "plan" }, bad && st?.loggedIn ? "Cần đăng nhập lại" : how)),
        h("span", { class: `dot ${bad ? "error" : st ? "done" : ""}` }),
        ),
        h("button", { class: "icon-btn gear", title: "Cài đặt", onclick: (e) => (e.stopPropagation(), settingsDialog()) }, "⚙"),
      ),
    ].filter(Boolean),
  );

  const banner = document.getElementById("auth-banner");
  if (st?.missing) {
    banner.replaceChildren(
      h(
        "span",
        {},
        "Không tìm thấy Claude Code trên máy. Cài Claude Code (",
        h("code", {}, api.platform === "win32" ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash"),
        api.platform === "win32" ? " trong PowerShell" : " trong Terminal",
        ") rồi bấm Kiểm tra lại, hoặc nhập đường dẫn tới claude trong Cài đặt.",
      ),
      h("button", { class: "primary", onclick: () => settingsDialog() }, "Mở Cài đặt"),
      h("button", { onclick: () => api.refreshAuth() }, "Kiểm tra lại"),
    );
    banner.style.display = "";
  } else if (bad && !auth.loggingIn) {
    banner.replaceChildren(
      h("span", {}, st?.loggedIn ? "Phiên đăng nhập Claude đã hết hạn hoặc bị từ chối." : "Chưa đăng nhập Claude, task sẽ không chạy được."),
      h("button", { class: "primary", onclick: () => api.login({}) }, "Đăng nhập lại"),
      h("button", { onclick: () => settingsDialog({ focusToken: true }) }, "Dùng token"),
      h("button", { onclick: () => api.refreshAuth() }, "Kiểm tra lại"),
    );
    banner.style.display = "";
  } else {
    banner.style.display = "none";
  }
}

document.addEventListener("click", (e) => {
  // Bỏ qua click làm render lại chính menu (phần tử đã bị gỡ khỏi DOM).
  if (accountMenuOpen && e.target.isConnected && !e.target.closest("#account")) {
    accountMenuOpen = false;
    renderAccount();
  }
});

api.on("auth:update", (a) => {
  auth = a;
  if (a.loggingIn) accountMenuOpen = false;
  renderAccount();
});
api.getAuth().then((a) => {
  auth = a;
  renderAccount();
});
renderAccount();

// ---------- cài đặt ----------

const TOKEN_KINDS = [
  ["ANTHROPIC_AUTH_TOKEN", "Auth token (ANTHROPIC_AUTH_TOKEN)"],
  ["ANTHROPIC_API_KEY", "API key (ANTHROPIC_API_KEY)"],
  ["CLAUDE_CODE_OAUTH_TOKEN", "OAuth token từ claude setup-token (CLAUDE_CODE_OAUTH_TOKEN)"],
];

function settingsDialog({ focusPm = false, focusToken = false } = {}) {
  const input = h("input", { type: "number", min: 1, max: 50, value: state.settings.maxConcurrent });
  const claudeInput = h("input", { type: "text", class: "pm-token", value: state.settings.claudePath ?? "", placeholder: "Để trống: tự tìm Claude Code trên máy", spellcheck: "false" });
  const claudeInfo = h("div", { class: "hint" }, "Đang kiểm tra…");
  const checkClaudePath = async () => {
    claudeInfo.className = "hint";
    claudeInfo.textContent = "Đang kiểm tra…";
    const r = await api.checkClaude(claudeInput.value);
    const where = { custom: "đường dẫn đã nhập", bundled: "bản đóng gói kèm app", installed: "bản cài trên máy" }[r.source] ?? "";
    claudeInfo.className = "hint " + (r.error ? "err-text" : "ok-text");
    claudeInfo.textContent = r.error ? (r.path ? `${r.path}: ${r.error}` : r.error) : `✓ ${r.version} · ${where}: ${r.path}`;
  };
  checkClaudePath();
  // Đăng nhập Claude bằng token được cấp (không cần tài khoản claude.ai).
  const hasTok = !!state.settings.hasClaudeToken;
  const tokKind = h("select", { class: "pm-token" }, TOKEN_KINDS.map(([v, label]) => h("option", { value: v, selected: v === (state.settings.claudeTokenKind ?? "ANTHROPIC_AUTH_TOKEN") }, label)));
  const tokInput = h("input", { type: "password", class: "pm-token", placeholder: hasTok ? "Đã lưu token · để trống để giữ, nhập để thay" : "Dán token", autocomplete: "off", spellcheck: "false" });
  const tokBase = h("input", { type: "text", class: "pm-token", value: state.settings.claudeBaseUrl ?? "", placeholder: "Base URL (ANTHROPIC_BASE_URL) · để trống nếu dùng thẳng Anthropic", spellcheck: "false" });
  const tokMsg = h("div", { class: "hint" }, hasTok ? "✓ Đang dùng token đã lưu." : "");
  if (hasTok) tokMsg.className = "hint ok-text";
  const tokSave = async () => {
    tokMsg.className = "hint";
    tokMsg.textContent = "Đang thử token với Claude…";
    const r = await api.setClaudeToken({ kind: tokKind.value, token: tokInput.value, baseUrl: tokBase.value });
    state.settings = r.settings;
    if (r.error) {
      tokMsg.className = "hint err-text";
      tokMsg.textContent = r.error;
      return;
    }
    tokInput.value = "";
    tokInput.placeholder = "Đã lưu token · để trống để giữ, nhập để thay";
    tokMsg.className = "hint ok-text";
    tokMsg.textContent = "✓ Token dùng được, đã lưu.";
    renderTokClear();
  };
  const tokClearSlot = h("span");
  const renderTokClear = () =>
    tokClearSlot.replaceChildren(
      ...(state.settings.hasClaudeToken
        ? [h(
            "button",
            {
              class: "danger small",
              onclick: async () => {
                const ok = await confirmDialog({ title: "Xoá token Claude?", message: "App sẽ quay về tài khoản Claude đăng nhập trên máy (nếu có).", confirmText: "Xoá token" });
                if (!ok) return;
                state.settings = await api.clearClaudeToken();
                tokMsg.className = "hint";
                tokMsg.textContent = "Đã xoá token.";
                tokInput.placeholder = "Dán token";
                renderTokClear();
              },
            },
            "Xoá token",
          )]
        : []),
    );
  renderTokClear();
  // Tài khoản PM: đăng nhập bằng email/mật khẩu để app tự lấy token (không lưu mật khẩu).
  const pmEmail = h("input", { type: "email", class: "pm-token", placeholder: "Email", value: state.settings.pmEmail ?? "", autocomplete: "username", spellcheck: "false" });
  const pmPass = h("input", { type: "password", class: "pm-token", placeholder: "Mật khẩu", autocomplete: "current-password" });
  const pmInput = h("input", { type: "password", class: "pm-token", placeholder: "Dán token (pm_access_token)", autocomplete: "off", spellcheck: "false" });
  const pmMsg = h("div", { class: "hint" });
  const pmBox = h("div", { class: "pm-account" });
  const pmLogin = async () => {
    pmMsg.className = "hint";
    pmMsg.textContent = "Đang đăng nhập…";
    const r = await api.pmLogin({ email: pmEmail.value, password: pmPass.value });
    pmPass.value = "";
    if (r?.error) {
      pmMsg.className = "hint err-text";
      pmMsg.textContent = r.error;
      return pmPass.focus();
    }
    pmState = r;
    pmMsg.textContent = "";
    renderPm();
  };
  const renderPm = () => {
    if (pmState?.hasToken) {
      const exp = pmState.tokenExpiresAt ? ` · token hết hạn ${new Date(pmState.tokenExpiresAt).toLocaleString("vi-VN")}` : "";
      pmBox.replaceChildren(
        h(
          "div",
          { class: "pm-signed" },
          h("span", { class: "ok-text" }, `✓ Đã đăng nhập${pmState.email ? ` · ${pmState.email}` : ""}`),
          h(
            "button",
            {
              class: "danger small",
              onclick: async () => {
                const ok = await confirmDialog({ title: "Đăng xuất tài khoản PM?", message: "Dashboard sẽ không kéo được task cho đến khi bạn đăng nhập lại.", confirmText: "Đăng xuất" });
                if (!ok) return;
                pmState = await api.pmSetToken(null);
                renderPm();
              },
            },
            "Đăng xuất",
          ),
        ),
        h("div", { class: "hint" }, (pmState.canRenew ? "App tự làm mới phiên khi token hết hạn" : "Token dán tay, hết hạn thì cần đăng nhập lại") + exp + "."),
      );
      return;
    }
    const manual = h("details", { class: "pm-manual" }, h("summary", {}, "Hoặc dán token thủ công (tài khoản đăng nhập bằng Google)"), pmInput);
    pmBox.replaceChildren(
      pmEmail,
      pmPass,
      h("div", { class: "pm-signed" }, h("button", { class: "primary small", onclick: pmLogin }, "Đăng nhập"), pmMsg),
      manual,
    );
  };
  renderPm();
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const save = async () => {
    const n = Number(input.value);
    if (!Number.isFinite(n) || n < 1) return input.focus();
    state.settings = await api.setSettings({ maxConcurrent: n, claudePath: claudeInput.value.trim() || null });
    if (pmInput.value.trim()) api.pmSetToken(pmInput.value);
    close();
    renderSidebar();
    currentView?.update();
  };
  const onKey = (e) => {
    // Đang mở hộp xác nhận (vd. xoá token) phía trên thì để nó tự xử lý phím.
    if ([...document.querySelectorAll(".modal-overlay")].pop() !== overlay) return;
    if (e.key === "Escape") close();
    if (e.key !== "Enter") return;
    // Enter trong ô email/mật khẩu là đăng nhập, không phải Lưu.
    if (e.target === tokInput || e.target === tokBase) {
      e.preventDefault();
      return tokSave();
    }
    if (e.target === pmEmail || e.target === pmPass) {
      e.preventDefault();
      return pmLogin();
    }
    save();
  };
  const overlay = h(
    "div",
    { class: "modal-overlay", onmousedown: (e) => e.target === overlay && close() },
    h(
      "div",
      { class: "modal" },
      h("div", { class: "modal-title" }, "Cài đặt"),
      h(
        "div",
        { class: "modal-body" },
        h("label", { class: "field" }, h("span", {}, "Số task chạy cùng lúc tối đa"), input),
        h(
          "div",
          { class: "hint" },
          "Mỗi task đang chạy tốn khoảng 300MB RAM. Task vượt giới hạn sẽ xếp hàng và tự chạy khi có task xong. Mặc định: 10.",
        ),
        h("label", { class: "field pm-field" }, h("span", {}, "Đường dẫn Claude Code"), h("button", { class: "small", onclick: checkClaudePath }, "Kiểm tra")),
        claudeInput,
        claudeInfo,
        h("label", { class: "field pm-field" }, h("span", {}, "Đăng nhập Claude bằng token"), tokClearSlot),
        tokKind,
        tokInput,
        tokBase,
        h("div", { class: "pm-signed" }, h("button", { class: "primary small", onclick: tokSave }, "Lưu & kiểm tra"), tokMsg),
        h("div", { class: "hint" }, "Dùng khi bạn không có tài khoản claude.ai mà được cấp token. Token được mã hoá bằng Keychain và thay cho đăng nhập tài khoản."),
        h("label", { class: "field pm-field" }, h("span", {}, "Tài khoản project.aiservice.vn")),
        pmBox,
        h("div", { class: "hint" }, "Dùng để kéo task Cần làm về Tổng quan. App không lưu mật khẩu, chỉ lưu token đã mã hoá bằng Keychain của máy."),
        h(
          "label",
          { class: "pm-share" },
          h("input", {
            type: "checkbox",
            checked: !!state.settings.pmShareEnv,
            onchange: async (e) => (state.settings = await api.setSettings({ pmShareEnv: e.target.checked })),
          }),
          h("span", {}, "Cho Claude dùng token PM trong task (biến ", h("code", {}, "$PM_TOKEN"), ", ", h("code", {}, "$PM_API_URL"), ")"),
        ),
        h(
          "div",
          { class: "hint" },
          "Skill/lệnh gọi API PM bằng header Authorization: Bearer $PM_TOKEN. Áp dụng cho task bắt đầu hoặc gửi tiếp sau khi bật. Claude và mọi lệnh nó chạy đều đọc được token này.",
        ),
      ),
      h(
        "div",
        { class: "modal-actions" },
        h("button", { onclick: close }, "Huỷ"),
        h("button", { class: "primary", onclick: save }, "Lưu"),
      ),
    ),
  );
  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  if (focusToken) tokInput.focus();
  else if (focusPm) (pmState?.hasToken ? input : pmEmail.value ? pmPass : pmEmail).focus();
  else {
    input.focus();
    input.select();
  }
}

// ---------- dashboard: task "Cần làm" kéo từ project.aiservice.vn ----------

const PM_PRIORITY = { CRITICAL: ["Khẩn cấp", "err"], HIGH: ["Cao", "warn"], MEDIUM: ["Trung bình", ""], LOW: ["Thấp", "muted"] };

function fmtDay(ts) {
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function pmDueChip(endDate) {
  if (!endDate) return null;
  const due = new Date(endDate);
  if (Number.isNaN(due.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(due.getFullYear(), due.getMonth(), due.getDate()) - today) / 86400000);
  const [text, tone] =
    days < 0 ? [`Quá hạn ${-days} ngày`, "err"] : days === 0 ? ["Hôm nay", "warn"] : days === 1 ? ["Ngày mai", "warn"] : [`Hạn ${fmtDay(due)}`, ""];
  return h("span", { class: `pm-due ${tone}`, title: `Hạn: ${due.toLocaleDateString("vi-VN")}` }, text);
}

// Prompt giao cho Claude theo loại công việc trên PM.
function pmPrompt(t) {
  const id = t.code ?? t.title;
  const type = t.type?.name ?? "";
  if (/bug/i.test(type)) return `Fix bug ${id}`;
  if (/feature/i.test(type) || !type) return `Thực hiện feature ${id}`;
  return `Thực hiện ${type.toLowerCase()} ${id}`;
}

// Project trong app ứng với project trên PM: đã chọn thì nhớ, chưa chọn thì đoán theo tên.
function pmLocalProject(g) {
  const saved = state.settings.pmProjectMap?.[g.key];
  if (saved && state.projects.some((p) => p.id === saved)) return saved;
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const n = norm(g.name);
  return (n && state.projects.find((p) => norm(p.name) === n || norm(p.name).includes(n) || n.includes(norm(p.name)))?.id) || "";
}

// Mục "Việc cần làm" trên cùng trang Tổng quan.
function pmSection() {
  const head = h("div", { class: "pm-head" });
  const content = h("div");
  const el = h("section", { class: "pm-dash" }, head, content);

  const update = () => {
    const s = pmState;
    head.replaceChildren(
      h("h2", {}, "Việc cần làm · PM"),
      h("span", { class: "sub" }, s?.fetchedAt ? `Cập nhật ${fmtTime(s.fetchedAt)} ${fmtDay(s.fetchedAt)} · tự làm mới mỗi giờ` : ""),
      h("span", { class: "spacer" }),
      s?.hasToken ? h("button", { class: "small", disabled: s.loading, onclick: () => api.pmRefresh() }, s.loading ? "Đang tải…" : "↻ Làm mới") : null,
      h("button", { class: "small", onclick: () => api.openUrl(s?.url ?? "https://project.aiservice.vn") }, "Mở trang PM"),
    );

    if (!s) return content.replaceChildren(h("div", { class: "pm-note" }, "Đang tải…"));
    if (!s.hasToken)
      return content.replaceChildren(
        h(
          "div",
          { class: "pm-note" },
          "Chưa đăng nhập project.aiservice.vn để kéo task. ",
          h("a", { href: "#", onclick: (e) => (e.preventDefault(), settingsDialog({ focusPm: true })) }, "Đăng nhập trong Cài đặt"),
        ),
      );

    const nodes = [];
    if (s.error) nodes.push(h("div", { class: "pm-error" }, s.error, " ", h("a", { href: "#", onclick: (e) => (e.preventDefault(), settingsDialog({ focusPm: true })) }, "Mở Cài đặt")));
    const expSoon = !s.canRenew && s.tokenExpiresAt && s.tokenExpiresAt - Date.now() < 3 * 86400000;
    if (expSoon && !s.error)
      nodes.push(h("div", { class: "pm-error warn" }, s.tokenExpiresAt < Date.now() ? "Token đã hết hạn." : `Token hết hạn lúc ${new Date(s.tokenExpiresAt).toLocaleString("vi-VN")}.`, " Đăng nhập lại trong ⚙ Cài đặt."));

    // Chia theo project; project có việc quá hạn/sắp hạn lên trước.
    const groups = new Map();
    for (const t of s.tasks) {
      const key = t.projectId ?? t.projectName;
      if (!groups.has(key)) groups.set(key, { key, name: t.projectName, tasks: [] });
      groups.get(key).tasks.push(t);
    }
    const dueOf = (t) => (t.endDate ? new Date(t.endDate).getTime() || Infinity : Infinity);
    const PRI = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    for (const g of groups.values()) g.tasks.sort((a, b) => dueOf(a) - dueOf(b) || (PRI[a.priority] ?? 9) - (PRI[b.priority] ?? 9));
    const sorted = [...groups.values()].sort((a, b) => dueOf(a.tasks[0]) - dueOf(b.tasks[0]) || a.name.localeCompare(b.name, "vi"));

    if (!s.tasks.length && !s.error) nodes.push(h("div", { class: "pm-note" }, s.fetchedAt ? "Không có task nào ở trạng thái Cần làm 🎉" : "Đang tải…"));
    for (const g of sorted) {
      const picker = h(
        "select",
        {
          class: "chip-select pm-local",
          title: "Project trong ClaudeDeck sẽ xử lý các task này",
          onchange: async () => {
            picker.classList.remove("need");
            state.settings = await api.setSettings({ pmProjectMap: { [g.key]: picker.value || null } });
            update();
          },
        },
        h("option", { value: "" }, "— Chọn project xử lý —"),
        state.projects.map((p) => h("option", { value: p.id }, p.name)),
      );
      picker.value = pmLocalProject(g);
      const run = async (t) => {
        const projectId = picker.value;
        if (!projectId) {
          picker.classList.add("need");
          return picker.focus();
        }
        // Lưu lựa chọn đoán theo tên để lần sau không phải chọn lại.
        if (state.settings.pmProjectMap?.[g.key] !== projectId) state.settings = await api.setSettings({ pmProjectMap: { [g.key]: projectId } });
        const model = localStorage.getItem("model");
        const effort = localStorage.getItem("effort");
        const task = await api.createTask({
          projectId,
          prompt: pmPrompt(t),
          permissionMode: lastMode(),
          model: model && model !== "default" ? model : null,
          effort: EFFORT_LABEL[effort] ? effort : null,
        });
        navigate({ type: "task", id: task.id });
      };
      nodes.push(
        h(
          "section",
          { class: "pm-group" },
          h(
            "div",
            { class: "pm-group-head" },
            h("span", { class: "name" }, g.name),
            h("span", { class: "count" }, String(g.tasks.length)),
            h("span", { class: "spacer" }),
            picker,
          ),
          g.tasks.map((t) => {
            const [pLabel, pTone] = PM_PRIORITY[t.priority] ?? [t.priority, ""];
            const prompt = pmPrompt(t);
            // Đã giao task này rồi (cùng prompt, cùng project) thì mở lại thay vì tạo task mới.
            const existing = state.tasks.filter((x) => x.projectId === picker.value && x.title === prompt).sort((a, b) => b.updatedAt - a.updatedAt)[0];
            const action = existing
              ? h(
                  "button",
                  { class: "small pm-run", title: "Mở task Claude đã giao cho việc này", onclick: (e) => (e.stopPropagation(), navigate({ type: "task", id: existing.id })) },
                  ACTIVE.has(existing.status) ? "Đang xử lý ↗" : "Mở task ↗",
                )
              : h("button", { class: "small primary pm-run", title: `Giao cho Claude: "${prompt}"`, onclick: (e) => (e.stopPropagation(), run(t)) }, "Xử lý");
            return h(
              "div",
              { class: "pm-task", title: "Mở task trên project.aiservice.vn", onclick: () => api.openUrl(t.url) },
              t.code ? h("span", { class: "pm-code" }, t.code) : null,
              t.type ? h("span", { class: "pm-type", style: t.type.color ? `--c:${t.type.color}` : "" }, t.type.name) : null,
              h("span", { class: "pm-title" }, t.title),
              t.priority ? h("span", { class: `pm-pri ${pTone}` }, pLabel) : null,
              pmDueChip(t.endDate),
              h("span", { class: "pm-status", style: t.statusColor ? `--c:${t.statusColor}` : "" }, t.status),
              action,
            );
          }),
        ),
      );
    }
    content.replaceChildren(...nodes);
  };

  update();
  return { el, update };
}

api.on("pm:update", (s) => {
  pmState = s;
  if (state.view.type === "overview") currentView?.updatePm?.();
});
api.pmGet().then((s) => {
  pmState = s;
  if (state.view.type === "overview") currentView?.updatePm?.();
});

// ---------- tìm kiếm file (⌘P / ⌘⇧F): theo tên file và nội dung ----------

let fileSearchOpen = null;

function openFileSearch() {
  const pid = viewProjectId();
  if (!pid) return alertDialog("Tìm kiếm file", "Mở một project hoặc task trước để tìm file trong project đó.");
  if (fileSearchOpen) return fileSearchOpen.input.select();
  const project = state.projects.find((p) => p.id === pid);
  const input = h("input", { class: "fs-input", placeholder: `Tìm theo tên file hoặc nội dung trong ${project?.name ?? "project"}…`, spellcheck: "false" });
  const list = h("div", { class: "fs-list" });
  const box = h("div", { class: "fs-box" }, h("div", { class: "fs-row" }, input), list);
  const overlay = h("div", { class: "fs-overlay", onmousedown: (e) => e.target === overlay && close() }, box);
  let items = []; // [{ el, open }]
  let index = 0;
  let seq = 0;
  let timer = null;

  const close = () => {
    clearTimeout(timer);
    overlay.remove();
    fileSearchOpen = null;
  };
  const highlight = (i) => {
    if (!items.length) return;
    index = Math.max(0, Math.min(items.length - 1, i));
    items.forEach((it, j) => it.el.classList.toggle("active", j === index));
    items[index].el.scrollIntoView({ block: "nearest" });
  };
  const choose = (it) => {
    close();
    it.open();
  };
  const item = (el, open) => {
    const it = { el, open };
    el.addEventListener("mousedown", (e) => (e.preventDefault(), choose(it)));
    el.addEventListener("mousemove", () => highlight(items.indexOf(it)));
    items.push(it);
    return el;
  };
  const mark = (text, at, len) => [text.slice(0, at), h("mark", {}, text.slice(at, at + len)), text.slice(at + len)];
  const nameMark = (rel, q) => {
    const base = baseName(rel);
    const i = q ? base.toLowerCase().indexOf(q.toLowerCase()) : -1;
    return i >= 0 ? mark(base, i, q.length) : [base];
  };

  const render = (q, names, grep) => {
    items = [];
    const nodes = [];
    if (!q) nodes.push(h("div", { class: "fs-empty" }, "Gõ tên file hoặc đoạn chữ cần tìm trong các file."));
    if (names.length) {
      nodes.push(h("div", { class: "fs-section" }, "Tên file"));
      for (const rel of names)
        nodes.push(
          item(
            h("div", { class: "fs-item" }, fileIcon(baseName(rel)), h("span", { class: "fs-name" }, ...nameMark(rel, q)), h("span", { class: "fs-path" }, parentOf(rel))),
            () => openInEditor(pid, rel),
          ),
        );
    }
    if (grep === null && q.trim().length >= 2) nodes.push(h("div", { class: "fs-empty" }, "Đang tìm trong nội dung…"));
    if (grep?.files.length) {
      const count = grep.files.reduce((n, f) => n + f.hits.length, 0);
      nodes.push(h("div", { class: "fs-section" }, `Nội dung · ${count} kết quả trong ${grep.files.length} file${grep.truncated ? " (đã dừng bớt, gõ cụ thể hơn)" : ""}`));
      for (const f of grep.files) {
        nodes.push(h("div", { class: "fs-file" }, fileIcon(baseName(f.rel)), h("span", { class: "fs-name" }, baseName(f.rel)), h("span", { class: "fs-path" }, parentOf(f.rel))));
        for (const hit of f.hits)
          nodes.push(
            item(
              h("div", { class: "fs-item fs-hit" }, h("span", { class: "fs-line" }, String(hit.line)), h("span", { class: "fs-text" }, ...mark(hit.text, hit.at, q.length))),
              () => openInEditor(pid, f.rel, { line: hit.line, col: hit.col, len: q.length }),
            ),
          );
      }
    }
    if (q && !names.length && grep && !grep.files.length) nodes.push(h("div", { class: "fs-empty" }, "Không tìm thấy kết quả."));
    list.replaceChildren(...nodes);
    highlight(0);
  };

  const search = () => {
    const q = input.value;
    const my = ++seq;
    const namesP = api.searchFiles({ projectId: pid, q: q.trim() }).then((r) => (q.trim() ? r.slice(0, 20) : []));
    namesP.then((names) => my === seq && render(q, names, q.trim().length >= 2 ? null : undefined));
    if (q.trim().length >= 2)
      Promise.all([namesP, api.grepFiles({ projectId: pid, q })]).then(([names, grep]) => my === seq && !grep.stale && render(q, names, grep));
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(search, 180);
  });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown") return e.preventDefault(), highlight(index + 1);
    if (e.key === "ArrowUp") return e.preventDefault(), highlight(index - 1);
    if (e.key === "Enter") return e.preventDefault(), items[index] && choose(items[index]);
    if (e.key === "Escape") return e.preventDefault(), close();
  });

  document.body.append(overlay);
  fileSearchOpen = { input };
  render("", [], undefined);
  input.focus();
}

api.on("menu:search", () => openFileSearch());

// ---------- kéo đổi độ rộng cột trái / phải ----------

const COLUMNS = {
  left: { cssVar: "--sidebar-w", key: "sidebarW", def: 260, min: 180, max: 480 },
  right: { cssVar: "--explorer-w", key: "explorerW", def: 280, min: 180, max: 600 },
};

function setColumnWidth(col, w) {
  const c = COLUMNS[col];
  w = Math.round(Math.max(c.min, Math.min(c.max, w)));
  document.documentElement.style.setProperty(c.cssVar, `${w}px`);
  return w;
}

function makeResizer(el, col) {
  const c = COLUMNS[col];
  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const target = col === "left" ? document.getElementById("sidebar") : document.getElementById("explorer");
    const startW = target.getBoundingClientRect().width;
    let w = startW;
    el.classList.add("active");
    document.body.classList.add("col-resizing");
    const move = (ev) => {
      const dx = ev.clientX - startX;
      w = setColumnWidth(col, col === "left" ? startW + dx : startW - dx);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      el.classList.remove("active");
      document.body.classList.remove("col-resizing");
      localStorage.setItem(c.key, String(w));
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  el.addEventListener("dblclick", () => {
    setColumnWidth(col, c.def);
    localStorage.removeItem(c.key);
  });
  const saved = Number(localStorage.getItem(c.key));
  if (saved) setColumnWidth(col, saved);
}

makeResizer(document.getElementById("resize-left"), "left");
// Cột phải render lại liên tục nên giữ một thanh kéo cố định và gắn lại mỗi lần render.
const explorerResizer = h("div", { class: "col-resizer", id: "resize-right", title: "Kéo để đổi độ rộng · Bấm đúp để về mặc định" });
makeResizer(explorerResizer, "right");

// ---------- actions & events ----------

async function addProject() {
  const added = await api.addProject();
  if (!added.length) return;
  state.projects.push(...added);
  navigate({ type: "project", id: added[0].id });
}

document.getElementById("add-project").addEventListener("click", (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  showContextMenu(r.left, r.bottom + 4, [
    { label: "Thêm project…", run: addProject },
    { label: "Tạo nhóm mới…", run: () => createGroupFlow() },
  ]);
});
// Thả project vào vùng trống của danh sách = bỏ ra khỏi nhóm.
dropTarget(document.getElementById("project-list"), (id) => moveProject(id, null));
document.getElementById("nav-overview").addEventListener("click", () => navigate({ type: "overview" }));

api.on("task:update", (meta) => {
  const i = state.tasks.findIndex((t) => t.id === meta.id);
  if (i >= 0) state.tasks[i] = meta;
  else state.tasks.push(meta);
  renderSidebar();
  currentView?.update();
});

api.on("task:entry", ({ taskId, entry }) => {
  currentView?.onEntry?.(taskId, entry);
  // Claude vừa chạy xong một tool (có thể đã sửa file) → làm mới explorer.
  if (entry.kind === "tool_result" && state.tasks.find((t) => t.id === taskId)?.projectId === explorer.projectId) {
    explorer.scheduleRefresh();
    window.editorRefreshFromDisk?.(explorer.projectId);
    refreshGit();
  }
});

// Cập nhật "x phút trước" định kỳ.
setInterval(() => {
  if (state.view.type !== "task") currentView?.update();
}, 30000);

api.getState().then((s) => {
  state.projects = s.projects;
  state.tasks = s.tasks;
  state.groups = s.groups ?? [];
  state.settings = s.settings;
  state.appVersion = s.appVersion;
  navigate({ type: "overview" });
});
