// Pocket Sync web UI — plain DOM, no build step, WebKit-safe.
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  tab: "library",
  books: [],
  lists: [],
  devices: [],
  profiles: [],
  settings: null,
  status: null,
  selection: new Set(),
  activeList: null,
  filterList: "",
  query: "",
  logs: [],
  logLevel: "info",
  follow: true,
  progress: new Map(), // bookId -> percent
};

// --- helpers ---------------------------------------------------------------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

async function api(method, path, body, isForm) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    if (isForm) init.body = body;
    else {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text };
  }
  if (!res.ok) throw new Error((json && json.error) || `HTTP ${res.status}`);
  return json;
}

function toast(message, kind) {
  const el = h("div", { class: `toast ${kind || ""}`, text: message });
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 9000 : 4500);
}

const fmtBytes = (n) => {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${v.toFixed(1)} ${u[i]}`;
};

const fmtDate = (iso) => {
  if (!iso) return "never";
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString();
};

// --- data loading ----------------------------------------------------------

async function refreshAll() {
  await Promise.all([loadStatus(), loadBooks(), loadLists(), loadDevices(), loadProfiles()]);
}

async function loadStatus() {
  try {
    state.status = await api("GET", "/api/status");
    renderStatus();
  } catch (err) {
    $("#status").textContent = String(err);
  }
}

async function loadBooks() {
  const params = new URLSearchParams();
  if (state.query) params.set("query", state.query);
  if (state.filterList) params.set("list", state.filterList);
  state.books = await api("GET", `/api/library?${params}`);
  renderLibrary();
}

async function loadLists() {
  state.lists = await api("GET", "/api/lists");
  renderListPickers();
  renderLists();
}

async function loadDevices() {
  state.devices = await api("GET", "/api/devices");
  renderDevices();
}

async function loadProfiles() {
  state.profiles = await api("GET", "/api/profiles");
  renderProfiles();
}

async function loadSettings() {
  state.settings = await api("GET", "/api/settings");
  renderSettings();
}

// --- status bar ------------------------------------------------------------

function renderStatus() {
  const s = state.status;
  if (!s) return;
  const online = s.devicesOnline;
  $("#status").textContent =
    `${s.books} book${s.books === 1 ? "" : "s"} · ${online}/${s.devices} device${
      s.devices === 1 ? "" : "s"
    } online · ` +
    (s.syncing ? "syncing…" : `last sync ${fmtDate(s.lastSync)}`) +
    (s.autoSyncEnabled ? "" : " · auto-sync paused");
  const dot = $("#health-dot");
  dot.className = "dot " + (s.syncing ? "warn" : online > 0 ? "ok" : "");
  renderBanners(s.deps);
}

// Setup problems belong in front of the user, not buried in the log.
function renderBanners(deps) {
  const wrap = $("#banners");
  wrap.textContent = "";
  if (!deps) return;

  if (deps.engine && !deps.engine.ok) {
    wrap.appendChild(
      h(
        "div",
        { class: "banner error" },
        h("strong", { text: "Resampling unavailable." }),
        h("span", { text: deps.engine.error || "The image engine did not start." }),
        h("span", { text: "Books can still be sent unoptimized." }),
      ),
    );
  }

  if (deps.calibre && !deps.calibre.convert) {
    wrap.appendChild(
      h(
        "div",
        { class: "banner" },
        h("strong", { text: "Calibre not found." }),
        h("span", {
          text: "EPUB files work as normal; MOBI, PDF, DOCX and others need Calibre to convert.",
        }),
        h("a", {
          href: "https://calibre-ebook.com/download",
          target: "_blank",
          rel: "noreferrer",
          text: "Install Calibre",
        }),
        h("span", { class: "spacer" }),
        h("button", {
          text: "Re-check",
          onclick: async (e) => {
            e.target.disabled = true;
            await api("GET", "/api/health?recheck=1");
            await loadStatus();
            toast("Re-checked dependencies", "ok");
          },
        }),
      ),
    );
  }
}

// --- library ---------------------------------------------------------------

function renderLibrary() {
  const grid = $("#book-grid");
  grid.textContent = "";
  $("#library-empty").classList.toggle("hidden", state.books.length > 0);

  for (const book of state.books) {
    const selected = state.selection.has(book.id);
    const card = h(
      "div",
      { class: `card ${selected ? "selected" : ""}` },
      h("input", {
        type: "checkbox",
        checked: selected,
        title: "Select",
        onchange: (e) => {
          e.stopPropagation();
          if (e.target.checked) state.selection.add(book.id);
          else state.selection.delete(book.id);
          renderLibrary();
        },
      }),
      h(
        "div",
        { class: "cover", onclick: () => showBook(book.id) },
        book.hasCover
          ? h("img", { src: `/api/books/${book.id}/cover`, alt: "", loading: "lazy" })
          : h("span", { class: "placeholder", text: "📖" }),
      ),
      h(
        "div",
        { class: "meta", onclick: () => showBook(book.id) },
        h("div", { class: "title", text: book.title }),
        h("div", { class: "author", text: book.author }),
        h(
          "div",
          { class: "badges" },
          h("span", { class: "badge", text: book.original_ext.toUpperCase() }),
          book.onDevices > 0
            ? h("span", {
              class: "badge on-device",
              text: `on ${book.onDevices} device${book.onDevices === 1 ? "" : "s"}`,
            })
            : null,
          state.progress.has(book.id)
            ? h("span", {
              class: "badge",
              text: `sending ${Math.round(state.progress.get(book.id) * 100)}%`,
            })
            : null,
        ),
      ),
    );
    grid.appendChild(card);
  }
  renderSelectionBar();
}

function renderSelectionBar() {
  const n = state.selection.size;
  const has = n > 0;
  $("#selection-info").textContent = has ? `${n} selected` : "";
  for (const id of ["#add-to-list", "#delete-selected", "#list-target"]) {
    $(id).classList.toggle("hidden", !has);
  }
  $("#remove-from-list").classList.toggle("hidden", !has || !state.filterList);
}

async function showBook(id) {
  const book = await api("GET", `/api/books/${id}`);
  const drawer = $("#book-detail");
  drawer.textContent = "";
  drawer.classList.remove("hidden");
  drawer.append(
    h("button", { text: "Close", onclick: () => drawer.classList.add("hidden") }),
    h("h2", { text: book.title }),
    book.hasCover ? h("img", { class: "cover-large", src: `/api/books/${id}/cover`, alt: "" }) : "",
    h(
      "dl",
      {},
      h("dt", { text: "Author" }),
      h("dd", { text: book.author }),
      book.series ? h("dt", { text: "Series" }) : "",
      book.series
        ? h("dd", { text: `${book.series}${book.series_index ? ` #${book.series_index}` : ""}` })
        : "",
      h("dt", { text: "Added" }),
      h("dd", { text: new Date(book.added_at).toLocaleString() }),
      h("dt", { text: "Source" }),
      h("dd", { text: `${book.original_ext.toUpperCase()} · ${fmtBytes(book.size_bytes)}` }),
      h("dt", { text: "EPUB" }),
      h("dd", { text: book.epubSize ? fmtBytes(book.epubSize) : "—" }),
      h("dt", { text: "Lists" }),
      h("dd", { text: book.lists.map((l) => l.name).join(", ") || "—" }),
      h("dt", { text: "Devices" }),
      h(
        "dd",
        {},
        book.devices.length
          ? book.devices.map((d) =>
            h("div", { text: `${d.name || d.device_id} · ${fmtDate(d.synced_at)}` })
          )
          : h("span", { text: "—" }),
      ),
    ),
    h(
      "div",
      { class: "toolbar", style: "margin-top:12px" },
      h("button", {
        text: "Re-send on next sync",
        onclick: async () => {
          await api("POST", `/api/books/${id}/resend`);
          toast("Marked for re-send", "ok");
          drawer.classList.add("hidden");
          loadBooks();
        },
      }),
      h("button", {
        class: "danger",
        text: "Delete",
        onclick: async () => {
          if (!confirm(`Delete “${book.title}” from the library?`)) return;
          await api("DELETE", `/api/books/${id}`);
          drawer.classList.add("hidden");
          toast("Deleted", "ok");
          loadBooks();
        },
      }),
    ),
  );
}

// --- uploads ---------------------------------------------------------------

async function uploadFiles(files) {
  const queue = $("#upload-queue");
  for (const file of files) {
    const bar = h("div", { class: "progress" }, h("div", {}));
    const row = h(
      "div",
      { class: "upload-row" },
      h("span", { class: "name", text: file.name }),
      bar,
      h("span", { class: "muted", text: "uploading…" }),
    );
    queue.appendChild(row);
    const fill = bar.firstChild;
    const label = row.lastChild;
    try {
      fill.style.width = "35%";
      const form = new FormData();
      form.append("file", file, file.name);
      const book = await api("POST", "/api/books", form, true);
      fill.style.width = "100%";
      label.textContent = book.converted ? "converted ✓" : "added ✓";
      setTimeout(() => row.remove(), 2500);
    } catch (err) {
      fill.style.width = "100%";
      fill.style.background = "var(--danger)";
      label.textContent = String(err.message || err);
      toast(`${file.name}: ${err.message || err}`, "error");
    }
  }
  loadBooks();
  loadStatus();
}

// --- lists -----------------------------------------------------------------

function renderListPickers() {
  const filter = $("#list-filter");
  const target = $("#list-target");
  const keep = filter.value;
  filter.textContent = "";
  target.textContent = "";
  filter.appendChild(h("option", { value: "", text: "All books" }));
  for (const l of state.lists) {
    filter.appendChild(h("option", { value: l.id, text: `${l.name} (${l.count})` }));
    target.appendChild(h("option", { value: l.id, text: l.name }));
  }
  filter.value = keep;
}

function renderLists() {
  const index = $("#list-index");
  index.textContent = "";
  for (const l of state.lists) {
    index.appendChild(
      h(
        "li",
        {
          class: state.activeList === l.id ? "active" : "",
          onclick: () => {
            state.activeList = l.id;
            renderLists();
            renderListMembers();
          },
        },
        h("span", { text: l.name }),
        h("span", { class: "muted", text: String(l.count) }),
      ),
    );
  }
  renderListMembers();
}

async function renderListMembers() {
  const table = $("#list-members");
  const list = state.lists.find((l) => l.id === state.activeList);
  $("#list-title").textContent = list ? list.name : "Select a list";
  $("#rename-list").classList.toggle("hidden", !list);
  $("#delete-list").classList.toggle("hidden", !list);
  table.textContent = "";
  if (!list) return;

  const books = await api("GET", `/api/library?list=${encodeURIComponent(list.id)}`);
  table.appendChild(
    h(
      "tr",
      {},
      h("th", { text: "Title" }),
      h("th", { text: "Author" }),
      h("th", { text: "" }),
    ),
  );
  for (const b of books) {
    table.appendChild(
      h(
        "tr",
        {},
        h("td", { text: b.title }),
        h("td", { text: b.author }),
        h(
          "td",
          {},
          h("button", {
            text: "Remove",
            onclick: async () => {
              await api("DELETE", `/api/lists/${list.id}/items`, { bookIds: [b.id] });
              await loadLists();
            },
          }),
        ),
      ),
    );
  }
}

// --- devices ---------------------------------------------------------------

function renderDevices() {
  const wrap = $("#device-list");
  wrap.textContent = "";
  if (!state.devices.length) {
    wrap.appendChild(
      h("p", {
        class: "empty",
        text:
          "No devices yet. Wake the reader on the same Wi-Fi, or add its IP under Settings → Discovery → manual hosts.",
      }),
    );
    return;
  }

  for (const d of state.devices) {
    const rule = d.rule;
    const sel = (id, opts, value) =>
      h(
        "select",
        { id },
        opts.map((o) => h("option", { value: o[0], text: o[1], selected: o[0] === value })),
      );

    const sourceSel = sel(
      "",
      [["library", "Entire library"], ["list", "A list"]],
      rule.source_type,
    );
    const listSel = sel(
      "",
      [["", "— choose —"], ...state.lists.map((l) => [l.id, l.name])],
      rule.source_list_id || "",
    );
    const modeSel = sel(
      "",
      [["add_new", "Add new only"], ["mirror", "Mirror (delete removed)"]],
      rule.mode,
    );
    const profileSel = sel(
      "",
      [["", "None (send as converted)"], ...state.profiles.map((p) => [p.id, p.name])],
      rule.profile_id || "",
    );
    const enabled = h("input", { type: "checkbox", checked: !!rule.enabled });
    const auto = h("input", { type: "checkbox", checked: !!rule.auto_on_connect });

    const saveRule = async () => {
      await api("PUT", `/api/devices/${d.id}/rule`, {
        source_type: sourceSel.value,
        source_list_id: listSel.value || null,
        mode: modeSel.value,
        profile_id: profileSel.value || null,
        enabled: enabled.checked ? 1 : 0,
        auto_on_connect: auto.checked ? 1 : 0,
      });
      toast("Sync rule saved", "ok");
      loadDevices();
    };

    const card = h(
      "div",
      { class: "device" },
      h(
        "header",
        {},
        h("span", { class: `dot ${d.state.online ? "ok" : ""}` }),
        h("h3", { text: d.name || d.model || d.id }),
        h("span", {
          class: `badge ${d.state.online ? "online" : "offline"}`,
          text: d.state.online ? "online" : "offline",
        }),
        d.model ? h("span", { class: "badge", text: d.model }) : null,
        h("span", {
          class: "muted",
          text: `${d.state.host || d.last_ip || "?"} · seen ${fmtDate(d.last_seen)}` +
            (d.id_strategy === "ip" ? " · identity: address" : ` · identity: ${d.id_strategy}`),
        }),
        h("span", { class: "spacer" }),
        h("button", {
          text: d.state.syncing ? "Syncing…" : "Sync now",
          disabled: d.state.syncing || !d.state.online,
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              const r = await api("POST", `/api/devices/${d.id}/sync`);
              toast(`${d.name || d.id}: ${r.message}`, r.failed ? "error" : "ok");
            } catch (err) {
              toast(String(err.message || err), "error");
            }
            loadDevices();
            loadBooks();
          },
        }),
        h("button", {
          text: "Rename",
          onclick: async () => {
            const name = prompt("Device name", d.name || "");
            if (name === null) return;
            await api("PATCH", `/api/devices/${d.id}`, { name });
            loadDevices();
          },
        }),
        h("button", {
          class: "danger",
          text: "Forget",
          onclick: async () => {
            if (!confirm("Forget this device and its sync history?")) return;
            await api("DELETE", `/api/devices/${d.id}`);
            loadDevices();
          },
        }),
      ),
      h(
        "div",
        { class: "rule" },
        field("Source", sourceSel),
        field("List", listSel),
        field("Mode", modeSel),
        field("Resampling", profileSel),
        h("label", { class: "check" }, enabled, "Enabled"),
        h("label", { class: "check" }, auto, "Auto-sync on connect"),
        h("button", { class: "primary", text: "Save rule", onclick: saveRule }),
      ),
      d.state.lastSyncResult
        ? h("p", { class: "muted", text: `Last sync: ${d.state.lastSyncResult}` })
        : null,
      h(
        "details",
        {},
        h("summary", { class: "muted", text: `On device (${d.contentCount})` }),
        h("div", { id: `contents-${d.id}` }, h("p", { class: "muted", text: "Loading…" })),
      ),
    );

    card.querySelector("details").addEventListener("toggle", async (e) => {
      if (!e.target.open) return;
      const target = $(`#contents-${d.id}`);
      target.textContent = "";
      try {
        const contents = await api("GET", `/api/devices/${d.id}/contents`);
        const table = h(
          "table",
          { class: "table" },
          h(
            "tr",
            {},
            h("th", { text: "File" }),
            h("th", { text: "Book" }),
            h("th", { text: "Size" }),
            h("th", { text: "Synced" }),
          ),
        );
        for (const row of contents.files) {
          table.appendChild(
            h(
              "tr",
              {},
              h("td", { text: row.path }),
              h("td", { text: row.title || (row.managed ? "(deleted from library)" : "—") }),
              h("td", { text: fmtBytes(row.size) }),
              h("td", { text: row.synced_at ? fmtDate(row.synced_at) : "—" }),
            ),
          );
        }
        target.appendChild(table);
        if (contents.error) target.appendChild(h("p", { class: "muted", text: contents.error }));
      } catch (err) {
        target.appendChild(h("p", { class: "muted", text: String(err.message || err) }));
      }
    });

    wrap.appendChild(card);
  }
}

const field = (label, control) =>
  h("div", { class: "field" }, h("label", { text: label }), control);

// --- settings + profiles ---------------------------------------------------

function renderSettings() {
  const form = $("#settings-form");
  const s = state.settings;
  if (!s) return;
  form.textContent = "";

  const rows = [
    ["h", "Paths"],
    ["text", "calibrePath", "ebook-convert path"],
    ["text", "ebookMetaPath", "ebook-meta path"],
    ["text", "pythonPath", "Python for the engine"],
    ["h", "Web UI"],
    ["number", "webPort", "Browser port (restart to apply)"],
    ["text", "webHost", "Bind address"],
    ["h", "Discovery"],
    ["check", "discovery.enabled", "UDP discovery enabled"],
    ["text", "discovery.manualHosts", "Manual hosts (comma separated)"],
    ["number", "discovery.intervalSec", "Scan interval (s)"],
    ["number", "discovery.timeoutSec", "Scan timeout (s)"],
    ["number", "discovery.debounceSec", "Connect debounce (s)"],
    ["check", "discovery.hotspotFallback", "Try hotspot 192.168.4.1"],
    ["h", "Transfer"],
    ["text", "upload.path", "Device folder"],
    ["number", "upload.chunkSize", "Chunk size (max 2048)"],
    ["number", "upload.retries", "Upload retries"],
    ["number", "upload.retryDelaySec", "Retry delay (s)"],
    ["number", "upload.bookCooldownSec", "Cooldown between books (s)"],
    ["number", "upload.socketTimeoutSec", "Socket timeout (s)"],
    ["check", "upload.webdavFallback", "WebDAV fallback if uploads fail"],
    ["h", "Behaviour"],
    ["check", "autoSyncEnabled", "Auto-sync on connect"],
    ["check", "startAtLogin", "Start Pocket Sync at login"],
    ["select", "logLevel", "Log level", ["debug", "info", "warn", "error"]],
  ];

  for (const row of rows) {
    if (row[0] === "h") {
      form.appendChild(h("h3", { text: row[1] }));
      continue;
    }
    const [type, path, label, opts] = row;
    const value = path.split(".").reduce((o, k) => (o || {})[k], s);
    let input;
    if (type === "check") {
      input = h("input", { type: "checkbox", checked: !!value, "data-path": path });
    } else if (type === "select") {
      input = h(
        "select",
        { "data-path": path },
        opts.map((o) => h("option", { value: o, text: o, selected: o === value })),
      );
    } else {
      input = h("input", {
        type,
        "data-path": path,
        value: Array.isArray(value) ? value.join(", ") : String(value ?? ""),
      });
    }
    form.appendChild(h("label", { text: label }));
    form.appendChild(input);
  }
}

async function saveSettings() {
  const patch = {};
  for (const input of $$("#settings-form [data-path]")) {
    const path = input.getAttribute("data-path");
    let value;
    if (input.type === "checkbox") value = input.checked;
    else if (input.type === "number") value = Number(input.value);
    else if (path === "discovery.manualHosts") {
      value = input.value.split(",").map((s) => s.trim()).filter(Boolean);
    } else value = input.value;
    const keys = path.split(".");
    let target = patch;
    for (const k of keys.slice(0, -1)) target = target[k] = target[k] || {};
    target[keys[keys.length - 1]] = value;
  }
  state.settings = await api("PUT", "/api/settings", patch);
  toast("Settings saved", "ok");
  $("#settings-note").textContent =
    "Port and bind-address changes take effect after restarting the app.";
  loadStatus();
}

function renderProfiles() {
  const wrap = $("#profiles");
  wrap.textContent = "";
  for (const p of state.profiles) {
    const name = h("input", { value: p.name });
    const model = h(
      "select",
      {},
      ["X4", "X3"].map((m) => h("option", { value: m, text: m, selected: m === p.device_model })),
    );
    const quality = h("input", { type: "number", min: "1", max: "100", value: p.jpeg_quality });
    const gray = h("input", { type: "checkbox", checked: !!p.grayscale });
    const crop = h("input", { type: "checkbox", checked: !!p.auto_crop });
    const split = h("input", { type: "checkbox", checked: !!p.split_text });
    wrap.appendChild(
      h(
        "div",
        { class: "pane", style: "margin-bottom:10px" },
        h(
          "div",
          { class: "rule" },
          field("Name", name),
          field("Device", model),
          field("JPEG quality", quality),
        ),
        h(
          "div",
          { class: "rule", style: "margin-top:8px" },
          h("label", { class: "check" }, gray, "Grayscale"),
          h("label", { class: "check" }, crop, "Auto-crop margins"),
          h("label", { class: "check" }, split, "Split text + strip fonts"),
          h("span", { class: "spacer" }),
          h("button", {
            class: "primary",
            text: "Save",
            onclick: async () => {
              await api("PUT", `/api/profiles/${p.id}`, {
                name: name.value,
                device_model: model.value,
                jpeg_quality: Number(quality.value),
                grayscale: gray.checked ? 1 : 0,
                auto_crop: crop.checked ? 1 : 0,
                split_text: split.checked ? 1 : 0,
              });
              toast("Profile saved", "ok");
              loadProfiles();
            },
          }),
          h("button", {
            class: "danger",
            text: "Delete",
            onclick: async () => {
              if (!confirm(`Delete profile “${p.name}”?`)) return;
              await api("DELETE", `/api/profiles/${p.id}`);
              loadProfiles();
            },
          }),
        ),
      ),
    );
  }
}

// --- logs ------------------------------------------------------------------

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function appendLog(e) {
  state.logs.push(e);
  if (state.logs.length > 2000) state.logs.shift();
  if (state.tab !== "logs") return;
  if (LEVELS[e.level] < LEVELS[state.logLevel]) return;
  const view = $("#log-view");
  view.appendChild(
    h(
      "div",
      { class: `log-line ${e.level}` },
      h("span", { class: "ts", text: new Date(e.ts).toLocaleTimeString() }),
      h("span", { class: "ev", text: e.event }),
      h("span", { text: e.message }),
    ),
  );
  while (view.childElementCount > 2000) view.firstChild.remove();
  if (state.follow) view.scrollTop = view.scrollHeight;
}

function renderLogs() {
  const view = $("#log-view");
  view.textContent = "";
  for (const e of state.logs) {
    if (LEVELS[e.level] < LEVELS[state.logLevel]) continue;
    view.appendChild(
      h(
        "div",
        { class: `log-line ${e.level}` },
        h("span", { class: "ts", text: new Date(e.ts).toLocaleTimeString() }),
        h("span", { class: "ev", text: e.event }),
        h("span", { text: e.message }),
      ),
    );
  }
  if (state.follow) view.scrollTop = view.scrollHeight;
}

// --- live events -----------------------------------------------------------

function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    appendLog(e);
    if (e.event === "sync.progress" && e.bookId && e.detail) {
      state.progress.set(e.bookId, e.detail.percent || 0);
      if (state.tab === "library") renderLibrary();
    }
    if (
      ["sync.done", "sync.start", "device.connected", "device.lost", "device.new"].includes(e.event)
    ) {
      state.progress.clear();
      loadStatus();
      loadDevices();
      if (e.event === "sync.done") loadBooks();
    }
    if (e.event === "ingest.done") {
      loadBooks();
      loadStatus();
    }
  };
  es.onerror = () => {
    $("#health-dot").className = "dot err";
    setTimeout(() => {
      es.close();
      connectEvents();
    }, 3000);
  };
}

// --- wiring ----------------------------------------------------------------

function selectTab(tab) {
  state.tab = tab;
  for (const b of $$("#tabs button")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const v of $$(".view")) v.classList.toggle("active", v.id === `view-${tab}`);
  if (tab === "settings" && !state.settings) loadSettings();
  if (tab === "logs") renderLogs();
  if (tab === "devices") loadDevices();
}

function init() {
  $("#tabs").addEventListener("click", (e) => {
    if (e.target.dataset.tab) selectTab(e.target.dataset.tab);
  });

  $("#search").addEventListener(
    "input",
    debounce(() => {
      state.query = $("#search").value;
      loadBooks();
    }, 250),
  );

  $("#list-filter").addEventListener("change", () => {
    state.filterList = $("#list-filter").value;
    loadBooks();
  });

  $("#upload-btn").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", (e) => {
    uploadFiles(Array.from(e.target.files));
    e.target.value = "";
  });

  const dz = $("#dropzone");
  for (const type of ["dragenter", "dragover"]) {
    dz.addEventListener(type, (e) => {
      e.preventDefault();
      dz.classList.add("hot");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    dz.addEventListener(type, (e) => {
      e.preventDefault();
      dz.classList.remove("hot");
    });
  }
  dz.addEventListener("drop", (e) => uploadFiles(Array.from(e.dataTransfer.files)));
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => e.preventDefault());

  $("#add-to-list").addEventListener("click", async () => {
    const listId = $("#list-target").value;
    if (!listId) return toast("Create a list first", "error");
    await api("POST", `/api/lists/${listId}/items`, { bookIds: [...state.selection] });
    toast(`Added ${state.selection.size} book(s)`, "ok");
    state.selection.clear();
    loadLists();
    loadBooks();
  });

  $("#remove-from-list").addEventListener("click", async () => {
    await api("DELETE", `/api/lists/${state.filterList}/items`, { bookIds: [...state.selection] });
    state.selection.clear();
    loadLists();
    loadBooks();
  });

  $("#delete-selected").addEventListener("click", async () => {
    if (!confirm(`Delete ${state.selection.size} book(s) from the library?`)) return;
    for (const id of state.selection) await api("DELETE", `/api/books/${id}`);
    state.selection.clear();
    toast("Deleted", "ok");
    loadBooks();
    loadStatus();
  });

  $("#create-list").addEventListener("click", async () => {
    const name = $("#new-list-name").value.trim();
    if (!name) return;
    await api("POST", "/api/lists", { name });
    $("#new-list-name").value = "";
    loadLists();
  });

  $("#rename-list").addEventListener("click", async () => {
    const list = state.lists.find((l) => l.id === state.activeList);
    const name = prompt("List name", list.name);
    if (!name) return;
    await api("PUT", `/api/lists/${list.id}`, { name });
    loadLists();
  });

  $("#delete-list").addEventListener("click", async () => {
    const list = state.lists.find((l) => l.id === state.activeList);
    if (!confirm(`Delete list “${list.name}”? Books stay in the library.`)) return;
    await api("DELETE", `/api/lists/${list.id}`);
    state.activeList = null;
    loadLists();
  });

  $("#discover-now").addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Scanning…";
    try {
      await api("POST", "/api/devices/discover");
      await loadDevices();
      toast(`${state.devices.filter((d) => d.state.online).length} device(s) online`, "ok");
    } catch (err) {
      toast(String(err.message || err), "error");
    }
    e.target.disabled = false;
    e.target.textContent = "Scan for devices";
  });

  $("#save-settings").addEventListener("click", saveSettings);
  $("#new-profile").addEventListener("click", async () => {
    const name = prompt("Profile name", "New profile");
    if (!name) return;
    await api("POST", "/api/profiles", { name });
    loadProfiles();
  });

  $("#log-level").addEventListener("change", (e) => {
    state.logLevel = e.target.value;
    renderLogs();
  });
  $("#log-follow").addEventListener("change", (e) => (state.follow = e.target.checked));
  $("#clear-logs").addEventListener("click", () => {
    state.logs = [];
    renderLogs();
  });

  api("GET", "/api/logs?limit=300").then((logs) => {
    state.logs = logs;
    if (state.tab === "logs") renderLogs();
  });

  // The tray's "View logs" opens /?tab=logs.
  const wanted = new URLSearchParams(location.search).get("tab");
  if (wanted && $(`#view-${wanted}`)) selectTab(wanted);

  refreshAll();
  connectEvents();
  setInterval(loadStatus, 15000);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

document.addEventListener("DOMContentLoaded", init);
