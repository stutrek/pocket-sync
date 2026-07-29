// All shared UI state. Components read signals directly and re-render on change;
// nothing here touches the DOM.
import { signal } from "@preact/signals";
import { api, errText } from "./api.ts";
import { scopeParam } from "./types.ts";
import type {
  Device,
  GroupBy,
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
 * Whose shelf is on screen: everything, one person's, or one reader's.
 *
 * The scope decides the *contents*, not just the annotations — the server
 * resolves it (`src/library/shelf.ts`) and answers with that reader's or that
 * person's books, plus whose reading progress to attach. Picking a person used
 * to show the whole library with different checkboxes, which is why the rail
 * never felt like it was taking you anywhere.
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

// --- persisted preferences --------------------------------------------------

const FOLDER_OPEN_KEY = "pocketsync.folderOpen";
const TARGET_KEY = "pocketsync.target";
const GROUP_KEY = "pocketsync.groupBy";
const DROP_KEY = "pocketsync.dropTo";

/** Private-mode storage throws; a preference is never worth failing a render. */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Ignored for the same reason as above.
  }
}

// --- scope and target -------------------------------------------------------

export function setScope(next: Scope) {
  scope.value = next;
  clearSelection();
  // Looking at a reader is the clearest possible statement of where a send
  // should go, so the page you are on picks the target for you.
  if (next.kind === "device") target.value = next.id;
  loadBooks();
}

/**
 * Which reader the Send button on each cover means.
 *
 * The alternative was a menu per card, which needs a positioned popover the
 * component set does not have — and which asks the same question hundreds of
 * times when the answer changes about once a week. One target, chosen once,
 * makes every card's button unambiguous and gives the dot on the cover a single
 * meaning: on *that* reader, or not.
 */
export const target = signal<string | null>(read(TARGET_KEY));

export function setTarget(deviceId: string | null) {
  target.value = deviceId;
  write(TARGET_KEY, deviceId);
}

/**
 * The target must name a reader that still exists, and a fresh install has none
 * chosen. Resolved against the loaded devices rather than trusted from storage.
 */
export function resolveTarget(): string | null {
  const all = devices.value;
  if (!all.length) return null;
  const scoped = scope.value;
  if (scoped.kind === "device") return scoped.id;
  if (scoped.kind === "user") {
    const held = users.value.find((u) => u.id === scoped.id)?.deviceIds ?? [];
    if (held.length) return held.includes(target.value ?? "") ? target.value : held[0];
  }
  if (target.value && all.some((d) => d.id === target.value)) return target.value;
  return all[0].id;
}

/** Folders are the sync unit; they are not the only way to find a book. */
export const groupBy = signal<GroupBy>((read(GROUP_KEY) as GroupBy) ?? "folder");

export function setGroupBy(next: GroupBy) {
  groupBy.value = next;
  write(GROUP_KEY, next);
}

/** Where a drop lands when the shelf is not grouped by folder. */
export const dropTo = signal<string | null>(read(DROP_KEY));

export function setDropTo(libraryId: string) {
  dropTo.value = libraryId;
  write(DROP_KEY, libraryId);
}

function readFolderOpen(): Record<string, boolean> {
  const raw = read(FOLDER_OPEN_KEY);
  try {
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
  write(FOLDER_OPEN_KEY, JSON.stringify(next));
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

// --- sending ----------------------------------------------------------------

/**
 * Put books on a reader, or take them off again.
 *
 * The server starts the sync and does not wait for it, so this returns as soon
 * as the instruction is recorded — the reader may well be asleep, and the books
 * go when it wakes. Both lists reload because the card's state comes from
 * `/api/library` and the reader's counts from `/api/devices`.
 */
export async function send(deviceId: string, bookIds: string[], on: boolean) {
  if (!bookIds.length) return;
  const one = bookIds.length === 1;
  const path = one
    ? `/api/devices/${deviceId}/pins/${encodeURIComponent(bookIds[0])}`
    : `/api/devices/${deviceId}/pins`;
  try {
    const result = await api<{ online: boolean }>(
      on ? "PUT" : "DELETE",
      path,
      one ? undefined : { bookIds },
    );
    const what = one ? "Book" : `${bookIds.length} books`;
    const name = devices.value.find((d) => d.id === deviceId);
    const label = name?.name || name?.model || "the reader";
    toast(
      on
        ? result.online ? `${what} sending to ${label}…` : `${what} queued for ${label}`
        : `${what} will come off ${label}`,
      "ok",
    );
    await Promise.all([loadBooks(), loadDevices()]);
  } catch (err) {
    toast(errText(err), "error");
  }
}

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
 * The scope's books in one request — the shelf groups them client-side, so
 * narrowing further here would only cost a round trip per expand.
 *
 * The server works out whose reading progress belongs on these rows, which is
 * why there is no `user` parameter and no client-side race between "the devices
 * arrived" and "the books arrived" to reconcile afterwards.
 */
export async function loadBooks() {
  const params = new URLSearchParams({ scope: scopeParam(scope.value) });
  if (query.value) params.set("query", query.value);
  if (readingFilter.value !== "all") params.set("reading", readingFilter.value);
  books.value = await api<LibraryBook[]>("GET", `/api/library?${params}`);
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
  // The person whose shelf is open may have just been removed.
  if (s.kind === "user" && !users.value.some((u) => u.id === s.id)) setScope({ kind: "all" });
}

export async function loadInbox() {
  inbox.value = await api<ImportJob[]>("GET", "/api/inbox");
}

export async function loadDevices() {
  devices.value = await api<Device[]>("GET", "/api/devices");
  const s = scope.value;
  // Likewise for a reader that was forgotten, here or from another window.
  if (s.kind === "device" && !devices.value.some((d) => d.id === s.id)) {
    setScope({ kind: "all" });
  }
  // A forgotten reader must not stay the send target, or every Send button
  // points at something that is not there any more.
  if (target.value && !devices.value.some((d) => d.id === target.value)) setTarget(null);
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
