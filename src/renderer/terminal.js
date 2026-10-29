// Panel terminal ở dưới (giống VSCode). Mỗi project có danh sách tab riêng;
// xterm của mọi project được giữ trong DOM (ẩn đi) nên chuyển màn hình không mất nội dung.

const THEME = {
  background: "#181818",
  foreground: "#cccccc",
  cursor: "#d97757",
  cursorAccent: "#181818",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

const termState = {
  open: localStorage.getItem("termOpen") === "1",
  height: Number(localStorage.getItem("termHeight")) || 280,
  projects: new Map(), // projectId -> { list: [entry], active: id, counter }
  byId: new Map(), // id -> entry
  early: new Map(), // id -> data đến trước khi entry sẵn sàng
};

const termPanel = document.getElementById("terminal-panel");
const termTabs = h("div", { class: "term-tabs" });
const termBody = h("div", { class: "term-body" });
const termResizer = h("div", { class: "term-resizer" });
termPanel.append(termResizer, termTabs, termBody);

const projectTerms = (pid) => {
  if (!termState.projects.has(pid)) termState.projects.set(pid, { list: [], active: null, counter: 0 });
  return termState.projects.get(pid);
};

const activeEntry = () => {
  const pid = viewProjectId();
  if (!pid) return null;
  const pt = projectTerms(pid);
  return pt.list.find((e) => e.id === pt.active) ?? null;
};

function fitActive() {
  const e = activeEntry();
  if (!e || !termState.open || termPanel.style.display === "none") return;
  try {
    e.fit.fit();
  } catch {}
}

async function newTerminal(pid = viewProjectId()) {
  if (!pid) return;
  const pt = projectTerms(pid);
  const el = h("div", { class: "term-host" });
  termBody.append(el);

  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, Monaco, monospace',
    fontSize: 12.5,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    theme: THEME,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  try {
    fit.fit();
  } catch {}

  const res = await api.termCreate({ projectId: pid, cols: term.cols, rows: term.rows });
  if (!res || res.error) {
    term.dispose();
    el.remove();
    if (res?.error) alertDialog("Không mở được terminal", res.error);
    return;
  }

  pt.counter += 1;
  const entry = { id: res.id, projectId: pid, title: `${res.shell} ${pt.counter}`, term, fit, el, exited: false };
  termState.byId.set(entry.id, entry);
  pt.list.push(entry);
  pt.active = entry.id;

  const early = termState.early.get(entry.id);
  if (early) term.write(early);
  termState.early.delete(entry.id);

  term.onData((data) => {
    if (entry.exited) return closeTerminal(entry);
    api.termWrite(entry.id, data);
  });
  term.onResize(({ cols, rows }) => api.termResize(entry.id, cols, rows));
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    if (e.ctrlKey && e.key === "`") return false; // để phím tắt bật/tắt panel hoạt động
    if (e.metaKey && e.key === "k") {
      term.clear();
      return false;
    }
    return true;
  });
  // Đổi tên tab theo tiêu đề shell đặt (ví dụ khi chạy lệnh).
  term.onTitleChange((title) => {
    if (title) entry.shellTitle = title;
    renderTerminal();
  });

  renderTerminal();
  term.focus();
}

// Đóng terminal đang chạy = tắt luôn tiến trình (vd npm run dev) nên phải hỏi trước.
async function confirmCloseTerminal(entry) {
  if (entry.exited) return closeTerminal(entry);
  const ok = await confirmDialog({
    title: "Đóng terminal?",
    message: [
      h("b", {}, entry.title),
      h("div", {}, "Shell và mọi lệnh đang chạy trong terminal này (vd. server dev) sẽ bị tắt."),
    ],
    confirmText: "Đóng terminal",
  });
  if (ok) closeTerminal(entry);
  else entry.term.focus();
}

function closeTerminal(entry) {
  const pt = projectTerms(entry.projectId);
  if (!entry.exited) api.termKill(entry.id);
  entry.term.dispose();
  entry.el.remove();
  termState.byId.delete(entry.id);
  const i = pt.list.indexOf(entry);
  pt.list.splice(i, 1);
  if (pt.active === entry.id) pt.active = (pt.list[i] ?? pt.list[i - 1])?.id ?? null;
  // Đóng tab cuối thì ẩn panel, giống VSCode.
  if (!pt.list.length && entry.projectId === viewProjectId()) setTerminalOpen(false);
  else renderTerminal();
}

function setTerminalOpen(open) {
  termState.open = open;
  localStorage.setItem("termOpen", open ? "1" : "0");
  renderTerminal();
  if (open) {
    const pid = viewProjectId();
    if (pid && !projectTerms(pid).list.length) newTerminal(pid);
    else activeEntry()?.term.focus();
  }
}

function toggleTerminal() {
  setTerminalOpen(!termState.open);
}

const TRASH =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5"/></svg>';

function renderTerminal() {
  const pid = viewProjectId();
  const project = state.projects.find((p) => p.id === pid);
  if (!project || !termState.open) {
    termPanel.style.display = "none";
    return;
  }
  termPanel.style.display = "";
  termPanel.style.height = `${termState.height}px`;

  const pt = projectTerms(pid);
  for (const e of termState.byId.values()) e.el.style.display = e.projectId === pid && e.id === pt.active ? "" : "none";

  const killBtn = h("button", { class: "icon-btn", title: "Đóng terminal", onclick: () => activeEntry() && confirmCloseTerminal(activeEntry()) });
  killBtn.innerHTML = TRASH;

  termTabs.replaceChildren(
    h("span", { class: "term-label" }, "Terminal"),
    ...pt.list.map((e) =>
      h(
        "div",
        {
          class: "term-tab" + (e.id === pt.active ? " active" : "") + (e.exited ? " exited" : ""),
          title: e.shellTitle || e.title,
          onclick: () => {
            pt.active = e.id;
            renderTerminal();
            e.term.focus();
          },
        },
        h("span", { class: "name" }, e.title),
        h(
          "span",
          {
            class: "x",
            title: "Đóng",
            onclick: (ev) => {
              ev.stopPropagation();
              confirmCloseTerminal(e);
            },
          },
          "×",
        ),
      ),
    ),
    h("span", { class: "spacer" }),
    h("span", { class: "term-cwd", title: project.path }, project.name),
    h("button", { class: "icon-btn", title: "Terminal mới (⌃⇧`)", onclick: () => newTerminal(pid) }, "＋"),
    killBtn,
    h("button", { class: "icon-btn", title: "Ẩn panel (⌃`)", onclick: () => setTerminalOpen(false) }, "⌄"),
  );

  requestAnimationFrame(fitActive);
}

// Kéo mép trên để đổi chiều cao panel.
termResizer.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const startY = e.clientY;
  const startH = termState.height;
  document.body.classList.add("resizing");
  const move = (ev) => {
    termState.height = Math.max(120, Math.min(window.innerHeight - 180, startH + startY - ev.clientY));
    termPanel.style.height = `${termState.height}px`;
    fitActive();
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    document.body.classList.remove("resizing");
    localStorage.setItem("termHeight", String(termState.height));
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
});

new ResizeObserver(() => fitActive()).observe(termBody);

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && (e.key === "`" || e.code === "Backquote")) {
    e.preventDefault();
    if (e.shiftKey) {
      if (!termState.open) setTerminalOpen(true);
      newTerminal();
    } else toggleTerminal();
  }
});

api.on("term:data", ({ id, data }) => {
  const e = termState.byId.get(id);
  if (e) e.term.write(data);
  else termState.early.set(id, (termState.early.get(id) ?? "") + data);
});

api.on("term:exit", ({ id, exitCode }) => {
  const e = termState.byId.get(id);
  if (!e) return;
  e.exited = true;
  e.term.write(`\r\n\x1b[90m[Tiến trình đã kết thúc (mã ${exitCode}). Nhấn phím bất kỳ để đóng.]\x1b[0m`);
  renderTerminal();
});

// Gọi từ app.js mỗi khi đổi màn hình.
window.syncTerminal = renderTerminal;
window.toggleTerminal = toggleTerminal;
renderTerminal();
