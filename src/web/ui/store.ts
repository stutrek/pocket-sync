// All shared UI state. Components read signals directly and re-render on change;
// nothing here touches the DOM.
import { signal } from "@preact/signals";
import { api } from "./api.ts";
import type {
  Device,
  ImportJob,
  Library,
  LibraryBook,
  LogEvent,
  LogLevel,
  Profile,
  ReadingFilter,
  Root,
  Scope,
  Settings,
  Status,
  Tab,
  User,
} from "./types.ts";

export const tab = signal<Tab>("library");
/** Where Activity was opened from, so it can offer the way back. */
export const activityFrom = signal<Tab | null>(null);
export const status = signal<Status | null>(null);
export const books = signal<LibraryBook[]>([]);
export const libraries = signal<Library[]>([]);
export const users = signal<User[]>([]);
export const root = signal<Root | null>(null);
export const inbox = signal<ImportJob[]>([]);
export const devices = signal<Device[]>([]);
export const profiles = signal<Profile[]>([]);
export const settings = signal<Settings | null>(null);

export const query = signal("");
/**
 * Whose shelf is on screen: everything, one person's, or one reader's. The
 * whole library is always fetched — scope decides which folders are shown and,
 * because reading state is per person, whose progress is attached.
 */
export const scope = signal<Scope>({ kind: "all" });
export const readingFilter = signal<ReadingFilter>("all");
export const selection = signal<ReadonlySet<string>>(new Set());
/** Bulk selection is the rare operation now, so it lives behind a mode. */
export const selectMode = signal(false);
export const detailBookId = signal<string | null>(null);

export const logs = signal<LogEvent[]>([]);
export const logLevel = signal<LogLevel>("info");
export const follow = signal(true);
/** bookId -> 0..1 upload progress, cleared when a sync starts or finishes. */
export const progress = signal<ReadonlyMap<string, number>>(new Map());

/**
 * The sync run in flight, as the engine reports it: book `index` of `total`,
 * and how far through that book we are. The count comes from the engine's
 * `sync.book.start` event rather than being inferred from how many books have
 * been seen so far — inferring it makes the bar reach 100% and then fall back
 * the moment the next book starts.
 */
export interface SyncRun {
  index: number;
  total: number;
  /** The engine's own wording, e.g. `Sending “Piranesi” (4/12)`. */
  label: string;
  percent: number;
}
export const syncRun = signal<SyncRun | null>(null);
/** False while the SSE stream is down, so the header dot can show it. */
export const connected = signal(true);
export const statusError = signal<string | null>(null);

export const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// --- scope ------------------------------------------------------------------

/**
 * Whose reading progress the current scope implies: the person themselves, the
 * person holding the reader, or — looking at the whole library — the first
 * person on the list. A shelf is always somebody's, so there is no "nobody".
 */
export function scopeUserId(s: Scope = scope.value): string {
  if (s.kind === "user") return s.id;
  if (s.kind === "device") {
    return devices.value.find((d) => d.id === s.id)?.settings.user_id ?? users.value[0]?.id ?? "";
  }
  return users.value[0]?.id ?? "";
}

export function setScope(next: Scope) {
  scope.value = next;
  clearSelection();
  loadBooks();
}

// --- folder collapse --------------------------------------------------------

const FOLDER_OPEN_KEY = "pocketsync.folderOpen";

function readFolderOpen(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(FOLDER_OPEN_KEY);
    return raw ? JSON.parse(raw) as Record<string, boolean> : {};
  } catch {
    return {};
  }
}

/**
 * Explicit collapse choices only. The default is left to the caller because it
 * differs by scope — a folder that doesn't sync to this reader starts closed.
 */
export const folderOpen = signal<Readonly<Record<string, boolean>>>(readFolderOpen());

export function setFolderOpen(id: string, open: boolean) {
  const next = { ...folderOpen.value, [id]: open };
  folderOpen.value = next;
  try {
    localStorage.setItem(FOLDER_OPEN_KEY, JSON.stringify(next));
  } catch {
    // Private-mode storage failures are not worth a toast; the view still works.
  }
}

// --- toasts ----------------------------------------------------------------

export interface Toast {
  id: number;
  message: string;
  kind?: "ok" | "error";
}

export const toasts = signal<Toast[]>([]);
let toastId = 0;

export function toast(message: string, kind?: "ok" | "error") {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, message, kind }];
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, kind === "error" ? 9000 : 4500);
}

// --- selection helpers ------------------------------------------------------

export function toggleSelected(id: string, on: boolean) {
  const next = new Set(selection.value);
  if (on) next.add(id);
  else next.delete(id);
  selection.value = next;
}

export const clearSelection = () => (selection.value = new Set());

// --- loaders ----------------------------------------------------------------

export async function loadStatus() {
  try {
    status.value = await api<Status>("GET", "/api/status");
    statusError.value = null;
  } catch (err) {
    statusError.value = String(err);
  }
}

/**
 * Every folder's books in one request — the shelf groups them client-side, so
 * narrowing to a folder here would only cost a round trip per expand.
 */
export async function loadBooks() {
  const params = new URLSearchParams();
  if (query.value) params.set("query", query.value);
  const user = scopeUserId();
  if (user) params.set("user", user);
  if (readingFilter.value !== "all") params.set("reading", readingFilter.value);
  lastBooksUser = user;
  books.value = await api<LibraryBook[]>("GET", `/api/library?${params}`);
}

/**
 * Which person the loaded shelf carries progress for. People and devices arrive
 * in parallel with the first book fetch, so the answer can change right after
 * it — without this the opening shelf silently shows nobody's progress.
 */
let lastBooksUser: string | null = null;

function reloadBooksIfUserChanged() {
  if (lastBooksUser !== null && lastBooksUser !== scopeUserId()) loadBooks();
}

export async function loadLibraries() {
  libraries.value = await api<Library[]>("GET", "/api/libraries");
}

export async function loadRoot() {
  root.value = await api<Root>("GET", "/api/root");
}

export async function loadUsers() {
  users.value = await api<User[]>("GET", "/api/users");
  const s = scope.value;
  // The person whose shelf is open may have just been removed in Settings.
  if (s.kind === "user" && !users.value.some((u) => u.id === s.id)) scope.value = { kind: "all" };
  reloadBooksIfUserChanged();
}

export async function loadInbox() {
  inbox.value = await api<ImportJob[]>("GET", "/api/inbox");
}

export async function loadDevices() {
  devices.value = await api<Device[]>("GET", "/api/devices");
  const s = scope.value;
  // Likewise for a reader that was forgotten, here or from another window.
  if (s.kind === "device" && !devices.value.some((d) => d.id === s.id)) {
    scope.value = { kind: "all" };
  }
  reloadBooksIfUserChanged();
}

export async function loadProfiles() {
  profiles.value = await api<Profile[]>("GET", "/api/profiles");
}

export async function loadSettings() {
  settings.value = await api<Settings>("GET", "/api/settings");
}

export function refreshAll() {
  return Promise.all([
    loadStatus(),
    loadBooks(),
    loadLibraries(),
    loadRoot(),
    loadUsers(),
    loadInbox(),
    loadDevices(),
    loadProfiles(),
  ]);
}

// --- live events ------------------------------------------------------------

const MAX_LOGS = 2000;

// A sync emits a progress event per chunk. Buffer the high-frequency signals and
// flush them on a timer so a busy transfer can't re-render the app per frame.
let logBuffer: LogEvent[] = [];
let progressBuffer: Map<string, number> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleFlush() {
  if (flushTimer !== undefined) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    if (logBuffer.length) {
      const next = [...logs.value, ...logBuffer];
      logs.value = next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
      logBuffer = [];
    }
    if (progressBuffer) {
      progress.value = progressBuffer;
      progressBuffer = null;
    }
    if (runPercent !== null) {
      if (syncRun.value) syncRun.value = { ...syncRun.value, percent: runPercent };
      runPercent = null;
    }
  }, 120);
}

/** A chunk-per-event stream drives this, so it rides the same flush timer. */
let runPercent: number | null = null;

function noteProgress(bookId: string, percent: number) {
  progressBuffer = new Map(progressBuffer ?? progress.value);
  progressBuffer.set(bookId, percent);
  runPercent = percent;
  scheduleFlush();
}

function clearProgress() {
  progressBuffer = null;
  if (progress.value.size) progress.value = new Map();
  syncRun.value = null;
}

const RELOAD_EVENTS = [
  "sync.done",
  "sync.start",
  "device.connected",
  "device.lost",
  "device.new",
  "deps.checked",
];
/** Scanning is unattended, so the Inbox has to keep itself current. */
const INGEST_EVENTS = ["ingest.done", "ingest.failed", "scan.done", "reading.progress"];

export function connectEvents() {
  const es = new EventSource("/api/events");

  es.onopen = () => (connected.value = true);

  es.onmessage = (msg) => {
    const e = JSON.parse(msg.data) as LogEvent;
    logBuffer.push(e);
    scheduleFlush();

    if (e.event === "sync.book.start" && e.detail) {
      const { index, total } = e.detail as { index?: number; total?: number };
      if (index && total) syncRun.value = { index, total, label: e.message, percent: 0 };
    }
    if (e.event === "sync.progress" && e.bookId && e.detail) {
      noteProgress(e.bookId, e.detail.percent ?? 0);
    }
    if (RELOAD_EVENTS.includes(e.event)) {
      clearProgress();
      loadStatus();
      loadDevices();
      if (e.event === "sync.done") loadBooks();
    }
    if (INGEST_EVENTS.includes(e.event)) {
      loadBooks();
      loadInbox();
      loadLibraries();
      loadStatus();
    }
  };

  es.onerror = () => {
    connected.value = false;
    setTimeout(() => {
      es.close();
      connectEvents();
    }, 3000);
  };
}

export async function loadRecentLogs() {
  logs.value = await api<LogEvent[]>("GET", "/api/logs?limit=300");
}
