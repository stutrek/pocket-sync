// Shapes returned by src/web/server.ts. Where the server hands back a domain
// object unchanged we reuse its type directly, so a change to the schema shows
// up here as a type error instead of a blank field in the UI.
import type { Config, LibraryConfig, UserConfig } from "../../core/config.ts";
import type { LibraryRow, ReadingFilter } from "../../library/books.ts";
import type { ImportJob } from "../../library/imports.ts";
import type { DeviceRow, DeviceState } from "../../device/manager.ts";
import type { DeviceSettings, ReaderConfigResult } from "../../sync/engine.ts";
import type { SyncServer } from "../../sync/kosync.ts";
import type { ReadingState } from "../../sync/reading.ts";

export type {
  Config,
  DeviceSettings,
  ImportJob,
  LibraryConfig,
  ReadingFilter,
  ReadingState,
  SyncServer,
  UserConfig,
};

/**
 * `GET /api/library` — a book within one folder, with reading and device state.
 *
 * `onDevices` is where it is; `pinnedTo` is which of those readers were told to
 * take it by hand. A reader in the first list but not the second carries it
 * because a folder rule covers it, and offering to un-send it there would be a
 * lie — the rule would put it straight back.
 */
export interface LibraryBook extends LibraryRow {
  hasCover: boolean;
  onDevices: string[];
  pinnedTo: string[];
}

/** `GET /api/libraries`. */
export interface Library extends LibraryConfig {
  /** Path relative to the library root, which is how folders are addressed. */
  relPath: string;
  books: number;
}

/** `GET /api/root`. */
export interface Root {
  path: string;
  chosen: boolean;
  /** A native folder chooser is available and the caller is on this machine. */
  canPick: boolean;
  local: boolean;
}

/** `GET /api/root/browse`. */
export interface Browse {
  root: string;
  rel: string;
  watched: boolean;
  entries: { name: string; rel: string; watched: boolean; children: number }[];
}

/**
 * `GET /api/users` — a name, its page-sync credentials, and where its readers
 * report.
 *
 * `syncServers` is the *resolved* list, so it overrides the stored one on
 * `UserConfig`: ours is synthesized rather than stored and always comes first,
 * and `defaultSyncServerId` is always filled in (never the implicit undefined
 * that means "ours" in config.json).
 */
export interface User extends Omit<UserConfig, "syncServers" | "defaultSyncServerId"> {
  username: string;
  password: string;
  syncServers: SyncServer[];
  defaultSyncServerId: string;
  deviceIds: string[];
}

/** `GET /api/books/:id`. */
export interface BookDetail {
  id: string;
  title: string;
  author: string;
  series: string | null;
  series_index: number | null;
  added_at: string;
  original_ext: string;
  size_bytes: number;
  hasCover: boolean;
  epubSize: number | null;
  libraries: { library_id: string; name: string; path: string; readOnly: boolean }[];
  /** Progress per person — reading state belongs to users, not folders. */
  reading: { userId: string; name: string; state: ReadingState | null }[];
  devices: { device_id: string; name: string | null; synced_at: string | null }[];
  /** Readers told to take this book by hand, as opposed to by a folder rule. */
  pinnedTo: string[];
}

/** What the next sync would do, without touching the device. */
export interface SyncPlan {
  folders: { id: string; name: string }[];
  /** How many books were sent to this reader by hand. */
  sent: number;
  send: number;
  remove: number;
  onDevice: number;
  /** Too many removals for an automatic sync to do unasked — the UI must offer. */
  needsConfirm: boolean;
}

/** `GET /api/devices`. */
export interface Device extends DeviceRow {
  state: DeviceState;
  settings: DeviceSettings;
  /** The folder rules feeding this reader. */
  libraryIds: string[];
  pinnedBookIds: string[];
  plan: SyncPlan;
  contentCount: number;
}

/** `GET /api/devices/:id/contents`. */
export interface DeviceContents {
  files: {
    path: string;
    size: number;
    title: string | null;
    synced_at: string | null;
    managed: boolean;
  }[];
  error?: string;
}

/** `GET /api/profiles`. Booleans are stored as SQLite 0/1. */
export interface Profile {
  id: string;
  name: string;
  device_model: string;
  jpeg_quality: number;
  grayscale: number;
  auto_crop: number;
  split_text: number;
}

export interface Deps {
  /** False until the first probe completes; the UI must not report problems
   * before then, because the placeholder claims everything is missing. */
  checked: boolean;
  calibre: {
    convert: boolean;
    meta: boolean;
    db: boolean;
    version?: string;
    convertPath?: string;
    /** Installed *and* enabled. */
    dedrm: boolean;
    /** Installed but switched off — a different fix from a missing plugin. */
    dedrmDisabled: boolean;
    /** Superseded DRM plugins Calibre can no longer load. */
    stalePlugins: string[];
  };
  engine: { ok: boolean; python?: string; bundled?: boolean; error?: string };
  checkedAt: string;
}

/** `GET /api/status`. */
export interface Status {
  dataDir: string;
  autoSyncEnabled: boolean;
  books: number;
  libraries: { id: string; name: string; path: string; deviceIds: string[]; books: number }[];
  users: UserConfig[];
  inbox: number;
  devices: number;
  devicesOnline: number;
  lastSync: string | null;
  syncing: boolean;
  discovery: {
    running: boolean;
    broadcast: boolean;
    manualHosts: number;
    hotspotFallback: boolean;
    intervalSec: number;
    sweeping: boolean;
    lastSweepAt: string | null;
    /** Nothing at all would be probed — the app cannot find a reader. */
    blind: boolean;
    /** Probing, but nothing has ever answered — see DeviceManager. */
    silent: boolean;
    platform: string;
  };
  deps: Deps;
}

/**
 * `GET /api/calibre/keys`. Loopback-only: a remote caller gets `local: false`
 * and nothing else, so the UI hides the section rather than failing on click.
 */
export interface CalibreKeys {
  local: boolean;
  configDir?: string;
  serials: string[];
  /** Counts only — key values never cross the wire. */
  adobeKeys?: number;
  kindleKeys?: number;
  stalePlugins?: string[];
  dedrm?: boolean;
  dedrmDisabled?: boolean;
}

/**
 * `GET /api/sources` — existing e-reader libraries on this machine. Loopback
 * only; a source is always referred to by `id`, never by path.
 */
export interface SourceList {
  local: boolean;
  sources: {
    id: string;
    label: string;
    note: string;
    expectDrm: boolean;
    installed: boolean;
    path?: string;
    watching: boolean;
  }[];
}

/** `POST /api/sources/:id/preview` — what watching it would actually pull in. */
export interface SourcePreview {
  id: string;
  label: string;
  note: string;
  path: string;
  books: number;
  truncated: boolean;
  /** Needs DeDRM and a key. */
  protected: number;
  /** Bare KFX: no voucher, so nothing can open them. */
  unopenable: number;
  /** Already indexed by content, so free to add. */
  known: number;
  dedrm: boolean;
  keysConfigured: number;
}

/** `GET /api/settings` — the config plus a live autostart probe. */
export type Settings = Config;

export type LogLevel = Config["logLevel"];

/** One entry from `GET /api/logs` or the `/api/events` SSE stream. */
export interface LogEvent {
  ts: string;
  level: LogLevel;
  event: string;
  message: string;
  bookId?: string;
  detail?: Record<string, unknown> & { percent?: number };
}

export interface SyncOutcome {
  message: string;
  failed?: number;
  pendingRemovals?: { bookId: string; title: string; path: string }[];
}

/** `POST /api/devices/:id/kosync` and `/opds` — how configuring the reader went. */
export type ReaderConfig = ReaderConfigResult;

/**
 * `GET /api/opds`. `url` is null whenever the catalog cannot be reached from
 * the network — switched off, or no LAN address — and `reason` says which,
 * because a blank address otherwise looks like a bug.
 */
export interface OpdsStatus {
  enabled: boolean;
  port: number;
  host: string;
  url: string | null;
  devices: { id: string; name: string; url: string | null }[];
  reason: string | null;
}

export type Tab = "library" | "settings" | "activity";

/**
 * What the library view is showing. The whole library, one person's shelf, or
 * one reader's — the three levels the rail lays out, in that order.
 *
 * Each scope now decides its own *contents*, not just its annotations: the
 * server resolves it (`src/library/shelf.ts`) and returns that reader's or that
 * person's books, along with whose reading progress to attach.
 */
export type Scope =
  | { kind: "all" }
  | { kind: "user"; id: string }
  | { kind: "device"; id: string };

/** The wire form the server parses. */
export const scopeParam = (s: Scope) => s.kind === "all" ? "all" : `${s.kind}:${s.id}`;

/** How the shelf is carved up. Folders are the sync unit, not the only lens. */
export type GroupBy = "folder" | "author" | "series" | "recent";
