// Editor file dạng tab (Monaco, lõi editor của VSCode). Mỗi project có danh sách
// tab riêng; tab đầu tiên luôn là "Claude" (màn hình chat/task hiện tại).

const MONACO_BASE = "../../node_modules/monaco-editor/min/vs";

const ed = {
  monaco: null,
  loading: null,
  editor: null,
  projects: new Map(), // projectId -> { files: [file], active: rel | null }
};
// file = { rel, abs, model, savedAlt, viewState }

const edTabs = document.getElementById("editor-tabs");
const edHost = document.getElementById("editor-host");
const edMain = document.getElementById("main");
const edToolbar = h("div", { class: "ed-toolbar" });
const edMount = h("div", { class: "ed-mount" });
const edStatus = h("div", { class: "ed-status" });
edHost.append(edToolbar, edMount, edStatus);

const edProject = (pid) => {
  if (!ed.projects.has(pid)) ed.projects.set(pid, { files: [], active: null });
  return ed.projects.get(pid);
};
const isDirty = (f) => f.model.getAlternativeVersionId() !== f.savedAlt;

// Nạp Monaco lần đầu cần dùng (khoảng 25MB, không nạp lúc khởi động).
function loadMonaco() {
  if (ed.loading) return ed.loading;
  ed.loading = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${MONACO_BASE}/editor/editor.main.css`;
    document.head.append(css);
    const script = document.createElement("script");
    script.src = `${MONACO_BASE}/loader.js`;
    script.onerror = reject;
    script.onload = () => {
      window.require.config({ paths: { vs: MONACO_BASE } });
      window.require(["vs/editor/editor.main"], () => {
        const monaco = window.monaco;
        monaco.editor.defineTheme("ide-dark", {
          base: "vs-dark",
          inherit: true,
          rules: [],
          colors: { "editor.background": "#1a1a1a", "editorGutter.background": "#1a1a1a" },
        });
        ed.monaco = monaco;
        ed.editor = monaco.editor.create(edMount, {
          theme: "ide-dark",
          fontFamily: '"SF Mono", Menlo, Monaco, monospace',
          fontSize: 13,
          lineHeight: 20,
          automaticLayout: true,
          minimap: { enabled: true },
          scrollBeyondLastLine: false,
          renderWhitespace: "selection",
          bracketPairColorization: { enabled: true },
          smoothScrolling: true,
          tabSize: 2,
        });
        // ⌘S đi qua menu (menu:save); thêm Ctrl+S cho người quen phím Ctrl.
        ed.editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyS, () => saveActive());
        ed.editor.onDidChangeCursorPosition(() => renderStatus());
        resolve(monaco);
      }, reject);
    };
    document.head.append(script);
  });
  return ed.loading;
}

const activeFile = () => {
  const pid = viewProjectId();
  if (!pid) return null;
  const pe = edProject(pid);
  return pe.files.find((f) => f.rel === pe.active) ?? null;
};

// pos: { line, col, len } để nhảy tới và bôi đen chỗ khớp (từ ô tìm kiếm).
async function openInEditor(pid, rel, pos) {
  const pe = edProject(pid);
  let file = pe.files.find((f) => f.rel === rel);
  if (!file) {
    const [res, monaco] = await Promise.all([api.readFile({ projectId: pid, rel }), loadMonaco()]);
    if (res.binary || res.tooLarge) {
      // Ảnh, file nhị phân hoặc quá lớn thì mở bằng app ngoài.
      api.openFile({ projectId: pid, rel });
      return;
    }
    if (res.error) return alertDialog("Không mở được file", `${rel}\n${res.error}`);
    // Có thể đã có người mở cùng file trong lúc chờ đọc.
    file = pe.files.find((f) => f.rel === rel);
    if (!file) {
      const uri = monaco.Uri.file(res.abs);
      const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(res.content, undefined, uri);
      file = { rel, abs: res.abs, model, savedAlt: model.getAlternativeVersionId(), viewState: null };
      model.onDidChangeContent(() => renderEditorTabs());
      pe.files.push(file);
    }
  }
  activateTab(pid, rel);
  if (pos?.line && ed.editor) {
    const range = { startLineNumber: pos.line, startColumn: pos.col ?? 1, endLineNumber: pos.line, endColumn: (pos.col ?? 1) + (pos.len ?? 0) };
    ed.editor.setSelection(range);
    ed.editor.revealRangeInCenter(range);
    ed.editor.focus();
  }
}

function rememberViewState() {
  const f = activeFile();
  if (f && ed.editor) f.viewState = ed.editor.saveViewState();
}

function activateTab(pid, rel) {
  rememberViewState();
  edProject(pid).active = rel;
  syncEditor();
  if (rel) ed.editor?.focus();
}

async function saveActive() {
  const f = activeFile();
  if (!f) return;
  const pid = viewProjectId();
  await saveFile(pid, f);
}

async function saveFile(pid, f) {
  const alt = f.model.getAlternativeVersionId();
  const res = await api.writeFile({ projectId: pid, rel: f.rel, content: f.model.getValue() });
  if (res.error) return alertDialog("Không lưu được file", `${f.rel}\n${res.error}`), false;
  f.savedAlt = alt;
  renderEditorTabs();
  renderStatus("Đã lưu");
  window.refreshGit?.(pid);
  return true;
}

async function closeTab(pid, f) {
  if (isDirty(f)) {
    const choice = await choiceDialog({
      title: "Lưu thay đổi?",
      message: [h("b", {}, f.rel), h("div", { class: "hint" }, "Nếu không lưu, các thay đổi sẽ bị mất.")],
      buttons: [
        { label: "Huỷ", value: "cancel" },
        { label: "Không lưu", value: "discard", class: "danger" },
        { label: "Lưu", value: "save", class: "primary" },
      ],
    });
    if (choice === "cancel") return;
    if (choice === "save" && !(await saveFile(pid, f))) return;
  }
  const pe = edProject(pid);
  const i = pe.files.indexOf(f);
  pe.files.splice(i, 1);
  f.model.dispose();
  if (pe.active === f.rel) pe.active = (pe.files[i] ?? pe.files[i - 1])?.rel ?? null;
  syncEditor();
}

// Đóng lần lượt (mỗi file chưa lưu sẽ hỏi); bấm Huỷ ở file nào thì dừng ở đó.
async function closeTabs(pid, files) {
  for (const f of files) {
    if (!edProject(pid).files.includes(f)) continue;
    await closeTab(pid, f);
    if (edProject(pid).files.includes(f)) return;
  }
}

function tabMenu(e, pid, f) {
  e.preventDefault();
  const pe = edProject(pid);
  const i = pe.files.indexOf(f);
  const others = pe.files.filter((x) => x !== f);
  const right = pe.files.slice(i + 1);
  const saved = pe.files.filter((x) => !isDirty(x));
  const project = state.projects.find((p) => p.id === pid);
  showContextMenu(e.clientX, e.clientY, [
    { label: "Đóng", key: "⌘W", run: () => closeTab(pid, f) },
    { label: "Đóng các tab khác", disabled: !others.length, run: () => closeTabs(pid, others) },
    { label: "Đóng các tab bên phải", disabled: !right.length, run: () => closeTabs(pid, right) },
    { label: "Đóng các tab đã lưu", disabled: !saved.length, run: () => closeTabs(pid, saved) },
    { label: "Đóng tất cả", run: () => closeTabs(pid, [...pe.files]) },
    "-",
    { label: "Sao chép đường dẫn", run: () => navigator.clipboard.writeText(f.abs ?? `${project?.path}/${f.rel}`) },
    { label: "Sao chép đường dẫn tương đối", run: () => navigator.clipboard.writeText(f.rel) },
    "-",
    { label: "Hiện trong Explorer", run: () => revealInExplorer(pid, f.rel) },
    { label: "Hiện trong Finder", run: () => api.openFile({ projectId: pid, rel: f.rel, target: "finder" }) },
    { label: "Mở bằng VSCode", run: () => api.openFile({ projectId: pid, rel: f.rel }) },
  ]);
}

function renderEditorTabs() {
  const pid = viewProjectId();
  const pe = pid ? edProject(pid) : null;
  if (!pe || !pe.files.length) {
    edTabs.style.display = "none";
    return;
  }
  edTabs.style.display = "";
  const tab = (key, label, active, extra = {}) =>
    h(
      "div",
      {
        class: "ed-tab" + (active ? " active" : "") + (extra.cls ?? ""),
        title: extra.title ?? label,
        onclick: () => activateTab(pid, key),
        oncontextmenu: extra.menu ?? ((e) => e.preventDefault()),
      },
      extra.icon ?? null,
      h("span", { class: "name" }, label),
      extra.close ?? null,
    );
  edTabs.replaceChildren(
    tab(null, "Claude", pe.active === null, { icon: h("span", { class: "spark" }, "✻"), cls: " claude" }),
    ...pe.files.map((f) => {
      const dirty = isDirty(f);
      const close = h(
        "span",
        {
          class: "x" + (dirty ? " dirty" : ""),
          title: dirty ? "Chưa lưu" : "Đóng (⌘W)",
          onclick: (e) => {
            e.stopPropagation();
            closeTab(pid, f);
          },
        },
      );
      return tab(f.rel, f.rel.split("/").pop(), pe.active === f.rel, {
        icon: fileIcon(f.rel.split("/").pop()),
        close,
        title: f.rel,
        cls: window.gitTone?.(pid, f.rel, false) ?? "",
        menu: (e) => tabMenu(e, pid, f),
      });
    }),
  );
}

function renderStatus(flash) {
  const f = activeFile();
  if (!f || !ed.editor) return;
  const pos = ed.editor.getPosition();
  const lang = f.model.getLanguageId();
  edStatus.replaceChildren(
    h("span", {}, isDirty(f) ? "● Chưa lưu" : flash ?? "Đã lưu"),
    h("span", { class: "spacer" }),
    h("span", {}, pos ? `Dòng ${pos.lineNumber}, Cột ${pos.column}` : ""),
    h("span", {}, lang),
    h("span", {}, "UTF-8"),
  );
}

function syncEditor() {
  renderEditorTabs();
  const f = activeFile();
  if (!f || !ed.editor) {
    edHost.style.display = "none";
    edMain.style.display = "";
    return;
  }
  edMain.style.display = "none";
  edHost.style.display = "";
  const pid = viewProjectId();
  edToolbar.replaceChildren(
    h("span", { class: "crumbs" }, f.rel.split("/").join("  ›  ")),
    h("span", { class: "spacer" }),
    h("button", { title: "Chèn @file vào prompt", onclick: () => (activateTab(pid, null), insertMention(f.rel)) }, "@ Gửi cho Claude"),
    h("button", { onclick: () => api.openFile({ projectId: pid, rel: f.rel }) }, "VSCode"),
  );
  if (ed.editor.getModel() !== f.model) {
    ed.editor.setModel(f.model);
    if (f.viewState) ed.editor.restoreViewState(f.viewState);
  }
  renderStatus();
}

// Claude sửa file → cập nhật các tab chưa có thay đổi của người dùng.
async function editorRefreshFromDisk(pid) {
  const pe = ed.projects.get(pid);
  if (!pe) return;
  for (const f of pe.files) {
    if (isDirty(f)) continue;
    const res = await api.readFile({ projectId: pid, rel: f.rel });
    if (res.content == null || res.content === f.model.getValue()) continue;
    f.model.pushEditOperations([], [{ range: f.model.getFullModelRange(), text: res.content }], () => null);
    f.savedAlt = f.model.getAlternativeVersionId();
  }
  renderEditorTabs();
  renderStatus();
}

// Hộp thoại nhiều lựa chọn, trả về value của nút được bấm (Esc = nút đầu tiên).
function choiceDialog({ title, message, buttons }) {
  return new Promise((resolve) => {
    const close = (v) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") e.preventDefault(), close(buttons[0].value);
    };
    const btns = buttons.map((b) => h("button", { class: b.class ?? "", onclick: () => close(b.value) }, b.label));
    const overlay = h(
      "div",
      { class: "modal-overlay", onmousedown: (e) => e.target === overlay && close(buttons[0].value) },
      h("div", { class: "modal" }, h("div", { class: "modal-title" }, title), h("div", { class: "modal-body" }, message), h("div", { class: "modal-actions" }, btns)),
    );
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
    btns[btns.length - 1].focus();
  });
}

const alertDialog = (title, text) =>
  choiceDialog({ title, message: h("div", { style: "white-space:pre-wrap" }, text), buttons: [{ label: "OK", value: "ok", class: "primary" }] });

const hasDirtyFiles = () => [...ed.projects.values()].some((pe) => pe.files.some(isDirty));

api.on("menu:save", () => saveActive());
api.on("menu:close-tab", () => {
  const f = activeFile();
  if (f) closeTab(viewProjectId(), f);
});
api.on("menu:toggle-terminal", () => toggleTerminal());

// Đóng cửa sổ khi còn file chưa lưu thì hỏi trước.
let edAllowClose = false;
window.addEventListener("beforeunload", (e) => {
  if (edAllowClose || !hasDirtyFiles()) return;
  e.returnValue = false;
  choiceDialog({
    title: "Còn file chưa lưu",
    message: h("div", {}, "Một số file đang sửa chưa được lưu. Đóng cửa sổ sẽ mất các thay đổi này."),
    buttons: [
      { label: "Huỷ", value: "cancel" },
      { label: "Đóng, không lưu", value: "close", class: "danger" },
    ],
  }).then((v) => {
    if (v === "close") {
      edAllowClose = true;
      window.close();
    }
  });
});

window.openInEditor = openInEditor;
window.syncEditor = syncEditor;
window.editorRefreshFromDisk = editorRefreshFromDisk;
// Explorer đổi tên / xoá file → cập nhật các tab đang mở.
const underPath = (rel, base) => rel === base || rel.startsWith(base + "/");

window.editorDirtyUnder = (pid, base) => (ed.projects.get(pid)?.files ?? []).filter((f) => underPath(f.rel, base) && isDirty(f)).length;

window.editorHandleDelete = (pid, base) => {
  const pe = ed.projects.get(pid);
  if (!pe) return;
  for (const f of pe.files.filter((f) => underPath(f.rel, base))) {
    pe.files.splice(pe.files.indexOf(f), 1);
    if (pe.active === f.rel) pe.active = pe.files[0]?.rel ?? null;
    f.model.dispose();
  }
  syncEditor();
};

window.editorHandleRename = (pid, from, to) => {
  const pe = ed.projects.get(pid);
  if (!pe || !ed.monaco) return;
  for (const f of pe.files.filter((f) => underPath(f.rel, from))) {
    const rel = to + f.rel.slice(from.length);
    const abs = f.abs.slice(0, f.abs.length - f.rel.length) + rel;
    // URI của model không đổi được: tạo model mới, giữ nội dung và trạng thái chưa lưu.
    const dirty = isDirty(f);
    const model = ed.monaco.editor.createModel(f.model.getValue(), undefined, ed.monaco.Uri.file(abs));
    model.onDidChangeContent(() => renderEditorTabs());
    if (pe.active === f.rel) pe.active = rel;
    f.model.dispose();
    Object.assign(f, { rel, abs, model, savedAlt: dirty ? -1 : model.getAlternativeVersionId(), viewState: null });
  }
  syncEditor();
};

window.editorBeforeNavigate = rememberViewState;
window.editorShowChat = (pid) => {
  if (pid && ed.projects.has(pid)) edProject(pid).active = null;
};
syncEditor();
