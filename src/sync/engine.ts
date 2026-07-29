import { bit, type Db } from "../core/db.ts";
import type { ConfigStore } from "../core/config.ts";
import type { EventBus } from "../core/events.ts";
import { koreaderPartialMd5, md5File } from "../core/hash.ts";
import {
  type DevicePlacement,
  devicePlacements,
  legacyBookIdFromFilename,
  shortHash,
} from "../core/ids.ts";
import type { Logger } from "../core/log.ts";
import { isLocalUrl } from "../core/net.ts";
import type { DeviceClient, DeviceFile } from "../device/client.ts";
import { joinDevicePath, normalizeDevicePath } from "../device/client.ts";
import type { DeviceManager } from "../device/manager.ts";
import type { Sidecar } from "../engine/sidecar.ts";
import { SidecarError } from "../engine/sidecar.ts";
import type { Book, Books } from "../library/books.ts";
import { fmtBytes } from "../library/ingest.ts";
import type { Scanner } from "../library/scanner.ts";
import type { KosyncServer } from "./kosync.ts";
import type { Pins } from "./pins.ts";
import { Profiles, type ResampleProfile } from "./profiles.ts";

/**
 * What is left of the old sync rule. A folder rule and a book sent by hand are
 * the two ways into a device's desired set, so there is no source type, no list
 * and no mode to choose (docs/DESIGN.md).
 */
export interface DeviceSettings {
  device_id: string;
  profile_id: string | null;
  /** Who is currently holding this reader. Reading progress keys on it. */
  user_id: string | null;
  enabled: number;
  auto_on_connect: number;
  /**
   * Which of the holder's sync servers this reader reports to. NULL — the
   * normal value — means their default, which is what makes handing the reader
   * to someone else re-point it at *their* server.
   */
  sync_server_id: string | null;
  /** Fingerprint of the page-sync settings the reader last accepted. */
  kosync_hash: string | null;
  kosync_state: ReaderConfigState | null;
  kosync_detail: string | null;
  kosync_at: string | null;
  /** The same, for the OPDS catalog entry — a separate endpoint, separate
   * outcome. See `configureCatalog()`. */
  opds_hash: string | null;
  opds_state: ReaderConfigState | null;
  opds_detail: string | null;
  opds_at: string | null;
  /**
   * When the user first looked at this reader — not when it was configured.
   * Everything that needs configuring is pushed automatically; this only stops
   * the "new reader" card offering to introduce a reader you have already met.
   */
  setup_at: string | null;
}

/**
 * How pointing the reader at a sync server went.
 *
 * `adopted` is its own outcome because it is the one case where doing nothing
 * to the reader is correct: it was already reporting somewhere we have never
 * configured, so somebody set that up deliberately. We take a copy of that
 * server into the holder's list and pin the reader to it, which turns a dead
 * end into a choice the user can change later.
 */
export type ReaderConfigState = "configured" | "unchanged" | "skipped" | "adopted" | "failed";

export interface ReaderConfigResult {
  state: ReaderConfigState;
  detail: string;
  at: string | null;
}

/** Removing more than this many books in one sync needs confirmation. */
export const REMOVAL_CONFIRM_THRESHOLD = 5;

/**
 * How deep the mirrored folder structure may go below the upload path.
 *
 * Two reasons, and the smaller number wins: the firmware creates one level per
 * request, so depth costs round trips; and `listEpubs()` gives up below 8
 * levels, at which point a delivered book becomes invisible to us and would be
 * sent again on every single sync. Anything deeper is truncated to its top
 * levels, which keeps the grouping the user arranged.
 */
export const MIRROR_MAX_DEPTH = 4;

/** How our entry is labelled in the reader's own catalog list, and the key we
 * find it by so a re-push edits it instead of appending a duplicate. */
export const CATALOG_NAME = "Pocket Sync";

/** The catalog ignores passwords (`src/web/opds.ts`), but the reader's entry
 * wants a field, so it gets a placeholder rather than a real credential. */
const CATALOG_PASSWORD = "pocketsync";

export interface SyncResult {
  deviceId: string;
  started: string;
  durationMs: number;
  sent: number;
  failed: number;
  deleted: number;
  upToDate: number;
  skipped?: string;
  /** Set when reconciliation stopped to ask before removing books. */
  pendingRemovals?: { bookId: string; title: string; path: string }[];
  message: string;
}

export interface SyncOptions {
  /** Proceed with removals that crossed the confirmation threshold. */
  confirmRemovals?: boolean;
}

/**
 * How the hashes in `kosync_document` are computed. Bump it whenever that
 * changes, and every book already on a reader is re-identified once at the next
 * start — see `remapDeliveredDocuments()`.
 *
 * 2: `koreaderPartialMd5` sampled from offset 256 instead of 0, so no report a
 *    reader made ever matched a book.
 */
const DOCUMENT_HASH_VERSION = "2";

export class SyncEngine {
  #running = new Set<string>();
  #rerun = new Set<string>();

  /**
   * Where this reader's OPDS catalog lives, injected by `App` rather than taken
   * as a constructor argument: the catalog server needs the engine (it serves
   * `prepareForDevice`), so the engine cannot also need the catalog server.
   * Unset — and null when the catalog is off — means there is nothing to push.
   */
  catalogUrlFor: ((deviceId: string) => string | null) | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly books: Books,
    private readonly profiles: Profiles,
    private readonly devices: DeviceManager,
    private readonly sidecar: Sidecar,
    private readonly scanner: Scanner,
    private readonly kosync: KosyncServer,
    readonly pins: Pins,
    private readonly log: Logger,
    private readonly bus: EventBus,
  ) {}

  settings(deviceId: string): DeviceSettings {
    let row = this.db.get<DeviceSettings>(
      "SELECT * FROM device_settings WHERE device_id = ?",
      deviceId,
    );
    if (!row) {
      this.db.run(
        "INSERT INTO device_settings (device_id, profile_id, user_id) VALUES (?, ?, ?)",
        deviceId,
        this.defaultProfileFor(deviceId),
        this.config.current.users[0]?.id ?? null,
      );
      row = this.db.get<DeviceSettings>(
        "SELECT * FROM device_settings WHERE device_id = ?",
        deviceId,
      )!;
    }
    return row;
  }

  /**
   * Resampling should match the hardware, not be off. Sending an unoptimized
   * book to a reader with ~380 KB of layout RAM is the thing most likely to
   * crash it, so "none" has to be a deliberate choice rather than the default.
   */
  defaultProfileFor(deviceId: string): string | null {
    const model = this.devices.row(deviceId)?.model;
    if (!model) return null;
    const match = this.profiles.all().find((p) => p.device_model === model);
    return match?.id ?? null;
  }

  /**
   * Handing a reader to someone else re-points it at *their* default server.
   *
   * A server override belongs to the person who set it — it is an id from
   * their list, and the new holder may not even have that server — so the
   * override is dropped rather than carried across. Clearing the fingerprint
   * alongside it is what makes the next `configureReader()` actually push,
   * instead of short-circuiting on settings the previous holder accepted.
   */
  setSettings(deviceId: string, patch: Partial<DeviceSettings>): DeviceSettings {
    const before = this.settings(deviceId);
    const next = { ...before, ...patch };
    const rehomed = patch.user_id !== undefined && patch.user_id !== before.user_id;
    if (rehomed && patch.sync_server_id === undefined) next.sync_server_id = null;
    const overrideChanged = next.sync_server_id !== before.sync_server_id;

    this.db.run(
      `UPDATE device_settings
          SET profile_id = ?, user_id = ?, enabled = ?, auto_on_connect = ?, sync_server_id = ?,
              setup_at = ?
        WHERE device_id = ?`,
      next.profile_id,
      next.user_id,
      bit(next.enabled),
      bit(next.auto_on_connect),
      next.sync_server_id,
      next.setup_at,
      deviceId,
    );
    if (rehomed || overrideChanged) {
      this.db.run("UPDATE device_settings SET kosync_hash = NULL WHERE device_id = ?", deviceId);
    }
    // The catalog entry carries the holder's name as its username, so a new
    // holder has to re-push it too — but a changed *override* is page sync only.
    if (rehomed) {
      this.db.run("UPDATE device_settings SET opds_hash = NULL WHERE device_id = ?", deviceId);
    }
    return this.settings(deviceId);
  }

  /**
   * Point the reader's own KOReader Sync client at the right sync server.
   *
   * The alternative is the user typing a URL, a username and a password on an
   * e-ink keyboard, once per reader — and typing the URL again every time DHCP
   * moves this machine. The firmware takes the same JSON block its settings
   * page posts (see the `pocket-device-protocol` skill), so we write it.
   *
   * "The right server" is the device's own override, else the holder's
   * default, else ours. Called at the top of every sync; the fingerprint of
   * what the reader last accepted short-circuits it before any request, so the
   * steady state costs nothing, while a changed holder, override, port or LAN
   * address re-pushes by itself.
   *
   * Never throws: a reader that will not take its settings still syncs books,
   * which is the part that matters.
   */
  async configureReader(
    deviceId: string,
    opts: { force?: boolean } = {},
  ): Promise<ReaderConfigResult> {
    const settings = this.settings(deviceId);
    const wanted = this.kosync.readerSettings(settings.user_id, settings.sync_server_id);
    if (!wanted.ok) return this.#recordReaderConfig(deviceId, "skipped", wanted.reason);

    const want = wanted.settings;
    const fingerprint = shortHash(JSON.stringify(want));
    if (!opts.force && settings.kosync_hash === fingerprint) {
      return { state: "unchanged", detail: settings.kosync_detail ?? "", at: settings.kosync_at };
    }

    const client = this.devices.clientFor(deviceId);
    if (!client) {
      return this.#recordReaderConfig(deviceId, "skipped", "the reader's address is unknown");
    }

    // What it is set to now, if this firmware will say. Only ever a reason to
    // hold off — never a reason to fail.
    const before = await client.settings();
    const current = String(before?.koServerUrl ?? "");
    if (before && current === want.koServerUrl && before.koUsername === want.koUsername) {
      return this.#recordReaderConfig(
        deviceId,
        "configured",
        `Already reporting to ${wanted.server.name} as ${want.koUsername}`,
        fingerprint,
      );
    }
    // Somebody set this reader up against a server we have never heard of. Take
    // a copy into the holder's list and pin the reader to it, rather than
    // overwriting a deliberate choice.
    //
    // "Never heard of" is the test, not "never configured this reader": a
    // server already on the holder's list has been shown to them and given a
    // control, so pushing past it is now their decision, not a surprise. A
    // stale address for *this* machine was never somebody else's setup either,
    // hence `isLocalUrl`.
    const unknown = !this.kosync.serverByUrl(settings.user_id!, current);
    if (before && current && !opts.force && unknown && !isLocalUrl(current)) {
      return this.#adoptReaderServer(deviceId, settings.user_id!, before, current);
    }

    try {
      await client.writeSettings({ ...want });
    } catch (err) {
      return this.#recordReaderConfig(
        deviceId,
        "failed",
        `The reader refused the settings: ${err}`,
      );
    }

    // Verify where we can: a 200 that quietly dropped the fields would
    // otherwise look like success until progress never arrived.
    const after = await client.settings();
    if (after && String(after.koServerUrl ?? "") !== want.koServerUrl) {
      return this.#recordReaderConfig(
        deviceId,
        "failed",
        `The reader did not keep the settings (it still reports to ` +
          `${after.koServerUrl || "nowhere"})`,
      );
    }

    const detail = `Reporting progress to ${wanted.server.name} as ${want.koUsername}`;
    this.log.info(
      "sync.kosync.configured",
      `Set up page sync on ${this.devices.label(deviceId)}: ${detail}`,
      {
        deviceId,
      },
    );
    return this.#recordReaderConfig(deviceId, "configured", detail, fingerprint);
  }

  /**
   * Put this machine's catalog in the reader's own OPDS list.
   *
   * The reader is an OPDS *client*: `GET /api/opds` returns its catalogs as
   * `{index, name, url, username, filenameFormat, hasPassword}`, and a POST to
   * the same endpoint adds one — or edits a slot in place when `index` is
   * included. Getting that distinction wrong appends a duplicate on every
   * single sync, so our entry is always found first and edited.
   *
   * Deliberately independent of `configureReader()`, which is about page sync:
   *
   * - a reader **nobody is holding** still gets a catalog. Page sync must skip
   *   it, because the only credentials it could be given would be somebody
   *   else's and every report would land on their shelf — but a catalog is
   *   scoped by bound folder and resample profile, neither of which is personal.
   * - a reader pointed at **somebody else's sync server** is adopted and left
   *   alone; that says nothing about its catalog list.
   * - our page-sync server being **switched off** is unrelated to the catalog.
   *
   * Never throws, like its page-sync counterpart: a reader that will not take a
   * catalog still syncs books.
   */
  async configureCatalog(
    deviceId: string,
    opts: { force?: boolean } = {},
  ): Promise<ReaderConfigResult> {
    const settings = this.settings(deviceId);
    const url = this.catalogUrlFor?.(deviceId) ?? null;
    if (!url) {
      return this.#recordCatalogConfig(
        deviceId,
        "skipped",
        this.config.current.opds.enabled
          ? "no LAN address — a reader has no way to reach this machine"
          : "the OPDS catalog is turned off in Settings",
      );
    }

    // A reader nobody holds still gets a catalog; it just browses under a name
    // that resolves to nobody, and the feed falls back to the first user.
    const holder = this.config.current.users.find((u) => u.id === settings.user_id);
    const username = holder?.name ?? "reader";
    const want = { name: CATALOG_NAME, url, username, filenameFormat: "title_author" };

    const fingerprint = shortHash(JSON.stringify(want));
    if (!opts.force && settings.opds_hash === fingerprint) {
      return { state: "unchanged", detail: settings.opds_detail ?? "", at: settings.opds_at };
    }

    const client = this.devices.clientFor(deviceId);
    if (!client) {
      return this.#recordCatalogConfig(deviceId, "skipped", "the reader's address is unknown");
    }

    const existing = await client.opdsCatalogs();
    if (!existing) {
      // No list means no OPDS client on this firmware — not a failure, just a
      // reader that cannot do this. The URL is shown in the UI to enter by hand.
      return this.#recordCatalogConfig(
        deviceId,
        "skipped",
        "this reader's firmware has no OPDS catalog list",
      );
    }

    // Ours by name, else by the device-scoped path, which is what survives the
    // user renaming the entry on the reader. Anything else in the list is
    // somebody's own catalog and is never touched.
    const mine = existing.find((c) => c.name === CATALOG_NAME) ??
      existing.find((c) => c.url.includes(`/opds/d/${deviceId}`));

    try {
      await client.saveOpdsCatalog({
        ...want,
        // Ours ignores the password entirely (src/web/opds.ts), so this is a
        // placeholder to satisfy a client that wants one — never a real
        // credential, which would be handing the reader something it has no
        // use for.
        password: CATALOG_PASSWORD,
        ...(mine ? { index: mine.index } : {}),
      });
    } catch (err) {
      return this.#recordCatalogConfig(
        deviceId,
        "failed",
        `The reader refused the catalog: ${err}`,
      );
    }

    // Verify: the firmware never reads a password back, so `hasPassword` is all
    // there is — the URL and username are what we can actually check.
    const after = await client.opdsCatalogs();
    const saved = after?.find((c) => c.name === CATALOG_NAME);
    if (after && (!saved || saved.url !== url)) {
      return this.#recordCatalogConfig(
        deviceId,
        "failed",
        saved
          ? `The reader kept a different catalog address (${saved.url})`
          : "The reader did not keep the catalog",
      );
    }

    const detail = `Catalog ${mine ? "updated" : "added"} as “${CATALOG_NAME}” (${url})`;
    this.log.info(
      "sync.opds.configured",
      `Set up the OPDS catalog on ${this.devices.label(deviceId)}: ${detail}`,
      { deviceId },
    );
    return this.#recordCatalogConfig(deviceId, "configured", detail, fingerprint);
  }

  #recordCatalogConfig(
    deviceId: string,
    state: ReaderConfigState,
    detail: string,
    hash: string | null = null,
  ): ReaderConfigResult {
    const before = this.settings(deviceId);
    const at = new Date().toISOString();
    this.db.run(
      `UPDATE device_settings
          SET opds_state = ?, opds_detail = ?, opds_at = ?, opds_hash = ?
        WHERE device_id = ?`,
      state,
      detail,
      at,
      hash,
      deviceId,
    );

    if (state === "failed") {
      this.log.warn(
        "sync.opds.configure",
        `OPDS catalog on ${this.devices.label(deviceId)}: ${detail}`,
        { deviceId },
      );
    } else if (
      state === "skipped" && (before.opds_state !== state || before.opds_detail !== detail)
    ) {
      // Say it once, on the transition. A skip is usually a setting the user can
      // change — silence is indistinguishable from the feature not existing —
      // but this runs on every connect and every sync, so repeating it each time
      // would bury the log.
      this.log.info(
        "sync.opds.skipped",
        `No OPDS catalog for ${this.devices.label(deviceId)}: ${detail}`,
        { deviceId },
      );
    }
    return { state, detail, at };
  }

  /**
   * Keep a reader on the sync server it already had, and remember that server.
   *
   * The reader hands us its username and password along with the URL, so the
   * copy we store is usable — the holder can point their other readers at the
   * same server without typing anything, and can switch this one to their
   * default whenever they like. The reader itself is not written to.
   *
   * Credentials are read off the device rather than guessed. If the firmware
   * declines to report them we still record the URL, because a server the user
   * can see and fill in beats one that exists only on the reader's screen.
   */
  #adoptReaderServer(
    deviceId: string,
    userId: string,
    before: Record<string, unknown>,
    url: string,
  ): ReaderConfigResult {
    const added = this.kosync.addServer(userId, {
      url,
      username: String(before.koUsername ?? ""),
      password: String(before.koPassword ?? ""),
      adopted: true,
    });
    if ("error" in added) {
      return this.#recordReaderConfig(
        deviceId,
        "skipped",
        `The reader reports to ${url}, which could not be saved: ${added.error}`,
      );
    }
    this.db.run(
      "UPDATE device_settings SET sync_server_id = ? WHERE device_id = ?",
      added.id,
      deviceId,
    );
    const detail = added.username
      ? `Kept on ${added.name} as ${added.username}, which it was already using`
      : `Kept on ${added.name}, which it was already using — the reader did not report a ` +
        `username, so fill that in to use this server on another reader`;
    return this.#recordReaderConfig(deviceId, "adopted", detail);
  }

  /** `hash` only on success — it is what suppresses the next attempt. */
  #recordReaderConfig(
    deviceId: string,
    state: ReaderConfigState,
    detail: string,
    hash: string | null = null,
  ): ReaderConfigResult {
    const at = new Date().toISOString();
    this.db.run(
      `UPDATE device_settings
          SET kosync_state = ?, kosync_detail = ?, kosync_at = ?, kosync_hash = ?
        WHERE device_id = ?`,
      state,
      detail,
      at,
      hash,
      deviceId,
    );
    // `adopted` is a normal outcome, not a problem: the reader keeps working and
    // the user now has that server on their list.
    if (state === "failed") {
      this.log.warn(
        "sync.kosync.configure",
        `Page sync on ${this.devices.label(deviceId)}: ${detail}`,
        {
          deviceId,
        },
      );
    }
    return { state, detail, at };
  }

  /**
   * Fill in a profile for devices registered before their model was known, or
   * before this defaulted. Only touches rows that never had one set.
   */
  backfillProfiles() {
    for (
      const row of this.db.all<{ device_id: string }>(
        "SELECT device_id FROM device_settings WHERE profile_id IS NULL",
      )
    ) {
      const profileId = this.defaultProfileFor(row.device_id);
      if (!profileId) continue;
      this.db.run(
        "UPDATE device_settings SET profile_id = ? WHERE device_id = ? AND profile_id IS NULL",
        profileId,
        row.device_id,
      );
      this.log.info(
        "sync.profile.default",
        `Defaulted ${this.devices.label(row.device_id)} to its model's resampling profile`,
        { deviceId: row.device_id },
      );
    }
  }

  /**
   * Where every book in these folders belongs on a device.
   *
   * **The watched folder's own name is the top level**, and whatever
   * arrangement sits inside it follows: `Hunger Games Trilogy/` on the reader,
   * and a book filed under `Sci-Fi/` on disk lands in
   * `Hunger Games Trilogy/Sci-Fi/`. Without that first level a reader syncing
   * several folders merges them all into the upload path — which defaults to
   * `/` — and a collection that happens to be flat on disk becomes
   * indistinguishable from every other one. Nothing here invents a hierarchy
   * below that: the rest is the user's own.
   *
   * The name is the folder's *label* rather than its basename on disk, because
   * that is what the user sees and what the catalog shows. Renaming a folder
   * therefore moves its books on every reader — a real cost, and the same one
   * as reorganizing the folder itself, which is the behaviour it should match.
   *
   * Computed for the whole set at once because a name only has to be unique
   * within its own folder, and the tiebreak must not depend on the order books
   * happen to go out.
   */
  placementsFor(
    libs: { id: string; name: string; path: string }[],
    extraBookIds: string[] = [],
  ): Map<string, DevicePlacement & { devicePath: string }> {
    const targetDir = normalizeDevicePath(this.config.current.upload.path || "/");
    const libraryIds = libs.map((l) => l.id);
    // Every configured folder, not just the ruled ones: this is a lookup table
    // for "what is this folder called", and a book sent by hand out of a folder
    // no rule covers still files under that folder's name. Scoping it to `libs`
    // would drop such a book at the upload root — where it would collide with
    // every folder name, and where adding the rule later would then have to
    // move it.
    const roots = new Map(
      this.scanner.libraries.map((l) => [l.id, { name: l.name, path: l.path }]),
    );
    // One title-ordered list rather than a concatenation: `devicePlacements()`
    // breaks name collisions across the whole set at once, so the outcome has to
    // not depend on which half a book arrived in.
    const ids = this.books.idsForDevice(libraryIds, extraBookIds);
    const sources = this.books.sourcePathsFor(ids, libraryIds);

    const placements = devicePlacements(
      ids
        .map((id) => this.books.get(id))
        .filter((b): b is Book => !!b)
        .map((b) => {
          const src = sources.get(b.id);
          const lib = src ? roots.get(src.libraryId) : undefined;
          // The cap covers the whole path, folder name included — it is about
          // how deep the firmware is asked to go, not about how much of it we
          // contributed.
          const relDir = lib
            ? [lib.name, ...relativeDirSegments(src!.path, lib.path)].slice(0, MIRROR_MAX_DEPTH)
            : [];
          return { id: b.id, title: b.title, author: b.author, relDir };
        }),
    );

    const out = new Map<string, DevicePlacement & { devicePath: string }>();
    for (const [id, place] of placements) {
      out.set(id, {
        ...place,
        devicePath: joinDevicePath([targetDir, ...place.dir].join("/"), place.filename),
      });
    }
    return out;
  }

  /**
   * What the next sync would do, without touching the device. Backs the
   * "will send N / remove N" preview.
   */
  plan(deviceId: string) {
    const libs = this.scanner.librariesForDevice(deviceId);
    const folders = libs.map((l) => ({ id: l.id, name: l.name }));
    const pinned = this.pins.idsFor(deviceId);
    if (!libs.length && !pinned.length) {
      return { folders, sent: 0, send: 0, remove: 0, onDevice: 0, needsConfirm: false };
    }
    const desired = new Set(this.books.idsForDevice(libs.map((l) => l.id), pinned));
    const present = this.db.all<{ book_id: string; device_path: string }>(
      "SELECT book_id, device_path FROM device_content WHERE device_id = ?",
      deviceId,
    );
    const presentSet = new Set(present.map((r) => r.book_id));
    const remove = present.filter((r) => !desired.has(r.book_id)).length;
    // A book on the reader in the wrong place is re-sent, not left — so the
    // preview has to count it, or "0 to send" would be followed by a sync that
    // moves half the shelf.
    const placements = this.placementsFor(libs, pinned);
    const misplaced = present.filter((r) =>
      desired.has(r.book_id) &&
      normalizeDevicePath(r.device_path) !== placements.get(r.book_id)?.devicePath
    ).length;
    return {
      folders,
      /** Books sent by hand, so the reader's page can offer to clear them. */
      sent: pinned.length,
      send: [...desired].filter((id) => !presentSet.has(id)).length + misplaced,
      remove,
      onDevice: present.length,
      /**
       * An automatic sync will stop rather than delete this many, so the UI has
       * to offer the confirmation — otherwise the removals wait forever. Decided
       * here so the threshold stays in one place.
       *
       * Un-sending one book is deliberately *not* what this catches: the user
       * just said to take it off, and a confirmation for an action that
       * explicit is noise. The confirmable action is removing a folder rule,
       * which the route gates with this same threshold.
       */
      needsConfirm: remove > REMOVAL_CONFIRM_THRESHOLD,
    };
  }

  /** Contents of a device per our manifest, joined with book titles. */
  contents(deviceId: string) {
    return this.db.all(
      `SELECT dc.*, b.title, b.author FROM device_content dc
       LEFT JOIN book b ON b.id = dc.book_id
       WHERE dc.device_id = ? ORDER BY b.title COLLATE NOCASE`,
      deviceId,
    );
  }

  /** Auto-sync entry point (device connected). Respects the pause switch. */
  onDeviceConnected(deviceId: string) {
    // Page sync is not book sync. A reader that is paused, or that has no
    // folder bound yet, should still know where to report reading progress, so
    // this happens before every reason to skip below. It is a no-op once the
    // reader has accepted the settings.
    this.configureReader(deviceId).catch(() => {});
    // Independent of page sync: a reader nobody holds gets no credentials but
    // can still have a catalog.
    this.configureCatalog(deviceId).catch(() => {});

    if (!this.config.current.autoSyncEnabled) {
      this.log.info(
        "sync.paused",
        `Auto-sync is paused; skipping ${this.devices.label(deviceId)}`,
        {
          deviceId,
        },
      );
      return;
    }
    const settings = this.settings(deviceId);
    if (!settings.enabled || !settings.auto_on_connect) {
      this.log.debug(
        "sync.auto.disabled",
        `Auto-sync disabled for ${this.devices.label(deviceId)}`,
        {
          deviceId,
        },
      );
      return;
    }
    this.sync(deviceId, "auto").catch((err) =>
      this.log.error("sync.failed", `Auto-sync failed: ${err}`, { deviceId })
    );
  }

  /**
   * Sync one device. Never runs twice concurrently for the same device; a
   * trigger arriving mid-run queues exactly one follow-up pass.
   */
  async sync(
    deviceId: string,
    trigger: "auto" | "manual",
    opts: SyncOptions = {},
  ): Promise<SyncResult> {
    if (this.#running.has(deviceId)) {
      this.#rerun.add(deviceId);
      this.log.debug("sync.queued", `Sync already running for ${this.devices.label(deviceId)}`, {
        deviceId,
      });
      return this.#empty(deviceId, "already running");
    }
    this.#running.add(deviceId);
    this.devices.markSyncing(deviceId, true);
    try {
      const result = await this.#run(deviceId, trigger, opts);
      this.devices.markSyncing(deviceId, false, result.message);
      return result;
    } finally {
      this.#running.delete(deviceId);
      if (this.#rerun.delete(deviceId)) {
        this.sync(deviceId, trigger).catch(() => {});
      }
    }
  }

  #empty(deviceId: string, skipped: string): SyncResult {
    return {
      deviceId,
      started: new Date().toISOString(),
      durationMs: 0,
      sent: 0,
      failed: 0,
      deleted: 0,
      upToDate: 0,
      skipped,
      message: `Skipped: ${skipped}`,
    };
  }

  async #run(deviceId: string, trigger: string, opts: SyncOptions): Promise<SyncResult> {
    const t0 = performance.now();
    const started = new Date().toISOString();
    const settings = this.settings(deviceId);
    const label = this.devices.label(deviceId);

    if (!settings.enabled && trigger !== "manual") return this.#empty(deviceId, "sync disabled");

    const libs = this.scanner.librariesForDevice(deviceId);
    const pinned = this.pins.idsFor(deviceId);
    // A reader with no folder rule but a book sent by hand has real work to do —
    // under this model that is the ordinary case, not an edge one.
    if (!libs.length && !pinned.length) return this.#empty(deviceId, "nothing to sync");

    // Reconciliation deletes, so an unreadable folder must never reach the diff
    // as "zero books" — an unplugged drive would clear the reader. With several
    // folders the whole sync has to abort: books from the missing one would look
    // removed, and we cannot tell that apart from the user deleting them.
    //
    // The folders holding sent books count too, and the rules alone do not name
    // them: a book sent out of a folder on an unmounted drive is in the desired
    // set (its `library_book` row outlives the mount) and would fail per book
    // with nothing saying why.
    const holding = new Set(this.books.librariesHolding(pinned));
    const toScan = [...libs];
    for (const id of holding) {
      if (libs.some((l) => l.id === id)) continue;
      const lib = this.scanner.library(id);
      if (lib) toScan.push(lib);
    }
    for (const lib of toScan) {
      const scan = await this.scanner.scan(lib.id);
      if (scan.unreadable) {
        const msg =
          `Folder “${lib.name}” for ${label} is unavailable (${scan.unreadable}) — nothing ` +
          `was changed`;
        this.log.error("sync.folder.unreadable", msg, { deviceId, detail: { libraryId: lib.id } });
        return { ...this.#empty(deviceId, "folder unavailable"), message: msg };
      }
    }

    const client = this.devices.clientFor(deviceId);
    if (!client) return this.#empty(deviceId, "device address unknown");

    // Before the books: make sure the reader knows where to report reading
    // progress. Costs nothing once it has taken, and this is the moment we
    // know the reader is awake and reachable.
    await this.configureReader(deviceId);
    await this.configureCatalog(deviceId);

    const cfg = this.config.current;
    const profile = settings.profile_id ? this.profiles.get(settings.profile_id) ?? null : null;
    this.log.info(
      "sync.start",
      `Sync (${trigger}) started for ${label}: ${libs.length} folder rule(s) ` +
        `(${libs.map((l) => l.name).join(", ") || "none"})` +
        (pinned.length ? `, ${pinned.length} sent by hand` : "") +
        `, profile ${profile ? profile.name : "none"}`,
      { deviceId, detail: { libraryIds: libs.map((l) => l.id), pinned: pinned.length } },
    );

    // 1. what's on the device now
    let onDevice: { path: string; name: string; size: number }[];
    try {
      onDevice = await client.listEpubs("/");
    } catch (err) {
      const msg = `Could not list device contents: ${err}`;
      this.log.error("sync.failed", msg, { deviceId });
      return { ...this.#empty(deviceId, "unreachable"), message: msg };
    }

    // 2. reconcile the manifest with reality (files may have been deleted on-device)
    const manifest = this.db.all<{ book_id: string; device_path: string }>(
      "SELECT book_id, device_path FROM device_content WHERE device_id = ?",
      deviceId,
    );
    const presentPaths = new Set(onDevice.map((f) => normalizeDevicePath(f.path)));
    for (const row of manifest) {
      if (!presentPaths.has(normalizeDevicePath(row.device_path))) {
        this.db.run(
          "DELETE FROM device_content WHERE device_id = ? AND book_id = ?",
          deviceId,
          row.book_id,
        );
      }
    }

    // Book ids present on device, from the manifest. Files placed by an older
    // version still carry their id in the filename, so they stay attributable
    // to us and reconciliation is allowed to clean them up.
    const presentBooks = new Map<string, string>(); // bookId -> device path
    for (
      const row of this.db.all<{ book_id: string; device_path: string }>(
        "SELECT book_id, device_path FROM device_content WHERE device_id = ?",
        deviceId,
      )
    ) {
      presentBooks.set(row.book_id, row.device_path);
    }
    const legacy: string[] = [];
    const unmanaged: string[] = [];
    const manifestPaths = new Set(presentBooks.values());
    for (const file of onDevice) {
      if (manifestPaths.has(file.path)) continue;
      if (legacyBookIdFromFilename(file.name)) legacy.push(file.path);
      else unmanaged.push(file.path);
    }

    // 3. desired set — every book a folder rule covers, plus every book sent to
    // this reader by hand. The two are indistinguishable from here on: a sent
    // book is resampled, stamped, placed and recorded by exactly the same loop.
    const desired = this.books.idsForDevice(libs.map((l) => l.id), pinned);
    const desiredSet = new Set(desired);

    // Where each of them belongs, and which are somewhere else. A book moves
    // when the folder it sits in on disk changes, when its title or author is
    // edited, and once for everybody when the naming scheme itself changes —
    // the firmware has no rename, so moving means sending it again and deleting
    // the old copy after the new one lands. Deliberately *not* counted as a
    // removal: the book stays on the reader, so this must not trip the
    // confirmation rail that exists to catch a folder going missing.
    const placements = this.placementsFor(libs, pinned);
    const relocations = new Map<string, string>(); // bookId -> where it is now
    for (const [id, current] of presentBooks) {
      if (!desiredSet.has(id)) continue;
      const want = placements.get(id)?.devicePath;
      if (want && normalizeDevicePath(current) !== want) relocations.set(id, current);
    }

    /** Folders a departing book may have been the last thing in. */
    const emptied = new Set<string>();

    const toSend = desired.filter((id) => !presentBooks.has(id) || relocations.has(id));
    const upToDate = desired.length - toSend.length;
    if (relocations.size) {
      this.log.info(
        "sync.relocating",
        `Moving ${relocations.size} book(s) on ${label} into their folders`,
        { deviceId, detail: { count: relocations.size } },
      );
    }

    // 4. remove what the folder no longer holds, plus any old-scheme leftovers.
    const stale = [...presentBooks.entries()].filter(([id]) => !desiredSet.has(id));
    const removalPaths = [...stale.map(([, path]) => path), ...legacy];
    let deleted = 0;

    if (removalPaths.length > REMOVAL_CONFIRM_THRESHOLD && !opts.confirmRemovals) {
      const pendingRemovals = stale.map(([id, path]) => ({
        bookId: id,
        title: this.books.get(id)?.title ?? "(unknown)",
        path,
      }));
      const msg =
        `${removalPaths.length} books would be removed from ${label} — confirm to proceed`;
      this.log.warn("sync.removal.confirm", msg, {
        deviceId,
        detail: { count: removalPaths.length },
      });
      return {
        ...this.#empty(deviceId, "awaiting removal confirmation"),
        pendingRemovals,
        message: msg,
      };
    }

    if (removalPaths.length) {
      try {
        await client.delete(removalPaths);
        for (const [id] of stale) {
          this.db.run(
            "DELETE FROM device_content WHERE device_id = ? AND book_id = ?",
            deviceId,
            id,
          );
        }
        deleted = removalPaths.length;
        for (const path of removalPaths) emptied.add(parentDevicePath(normalizeDevicePath(path)));
        this.log.info("sync.deleted", `Removed ${deleted} book(s) from ${label}`, {
          deviceId,
          detail: { paths: removalPaths.slice(0, 20) },
        });
      } catch (err) {
        this.log.warn("sync.delete.failed", `Could not delete removed books: ${err}`, { deviceId });
      }
    }
    if (unmanaged.length) {
      this.log.info(
        "sync.unmanaged",
        `Left ${unmanaged.length} file(s) not sent by Pocket Sync in place`,
        { deviceId, detail: { paths: unmanaged.slice(0, 20) } },
      );
    }

    // 5. upload
    const targetDir = normalizeDevicePath(cfg.upload.path || "/");
    // Folders created during this run. The firmware makes one level per request
    // and every existence check is a round trip, so a folder holding fifty
    // books must not cost fifty listings.
    const madeDirs = new Set<string>(["/"]);
    await this.#ensureDeviceDir(client, deviceId, targetDir, madeDirs);

    let sent = 0;
    let failed = 0;
    let connectionLost = false;
    let stopped = false;

    // Which folders hold each book we are about to send, so the per-book
    // re-check below can tell "this one book's rule went away" from "there is
    // nothing left to do at all".
    const holders = this.books.libraryIdsByBook(toSend);

    for (const [index, bookId] of toSend.entries()) {
      // Sending a large folder takes minutes, and the user can unbind a rule,
      // un-send a book or remove a folder while we are mid-transfer. Re-check
      // each book rather than trusting what we read at the top of the run.
      const stillRuled = new Set(
        this.scanner.librariesForDevice(deviceId).map((l) => l.id),
      );
      const stillSent = new Set(this.pins.idsFor(deviceId));
      if (!stillRuled.size && !stillSent.size) {
        this.log.info(
          "sync.stopped",
          `Stopped syncing ${label} after ${sent} book(s) — its folders and sends were removed`,
          { deviceId, detail: { libraryIds: libs.map((l) => l.id) } },
        );
        stopped = true;
        break;
      }
      // One book losing its reason to be here does not invalidate the rest of
      // the run — which the old whole-run check got wrong in the other
      // direction, happily finishing a folder the user had just unbound.
      if (
        !stillSent.has(bookId) &&
        ![...(holders.get(bookId) ?? [])].some((id) => stillRuled.has(id))
      ) {
        continue;
      }

      const book = this.books.get(bookId);
      if (!book) continue;
      if (!book.epub_path) {
        failed++;
        this.log.error("sync.book.failed", `“${book.title}” has no EPUB to send`, {
          deviceId,
          bookId,
        });
        continue;
      }
      this.bus.emit({
        level: "debug",
        event: "sync.book.start",
        message: `Sending “${book.title}” (${index + 1}/${toSend.length})`,
        deviceId,
        bookId,
        detail: { index: index + 1, total: toSend.length },
      });

      let sendPath: string;
      try {
        sendPath = (await this.prepareForDevice(book, deviceId, profile)).path;
      } catch (err) {
        failed++;
        this.log.error("sync.optimize.failed", `Optimize failed for “${book.title}”: ${err}`, {
          deviceId,
          bookId,
        });
        continue;
      }

      const placement = placements.get(book.id);
      const filename = placement?.filename ?? `${book.id}.epub`;
      const bookDir = placement?.dir.length
        ? joinDevicePath(targetDir, placement.dir.join("/"))
        : targetDir;
      const devicePath = placement?.devicePath ?? joinDevicePath(targetDir, filename);
      // The upload handshake writes into a directory; it does not create one.
      await this.#ensureDeviceDir(client, deviceId, bookDir, madeDirs);
      const ok = await this.#uploadWithRetry(client, deviceId, book.id, book.title, {
        host: client.hostname,
        port: client.wsPort,
        uploadPath: bookDir,
        filename,
        filePath: sendPath,
        devicePath,
      });

      if (ok === "sent") {
        sent++;
        const size = (await Deno.stat(sendPath)).size;
        this.db.run(
          `INSERT INTO device_content (device_id, book_id, device_filename, device_path,
                                       size_bytes, profile_hash, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (device_id, book_id) DO UPDATE SET
             device_filename = excluded.device_filename, device_path = excluded.device_path,
             size_bytes = excluded.size_bytes, profile_hash = excluded.profile_hash,
             synced_at = excluded.synced_at`,
          deviceId,
          book.id,
          filename,
          devicePath,
          size,
          profile ? profile.id : null,
          new Date().toISOString(),
        );
        // A move is only finished once the new copy is on the reader: delete
        // the old one now, never before, so a failed upload leaves the book
        // where it was rather than nowhere.
        const cameFrom = relocations.get(book.id);
        if (cameFrom) {
          emptied.add(parentDevicePath(normalizeDevicePath(cameFrom)));
          await client.delete([cameFrom]).catch((err) =>
            this.log.warn(
              "sync.relocate.cleanup",
              `Moved “${book.title}” but could not remove the old copy at ${cameFrom}: ${err}`,
              { deviceId, bookId: book.id },
            )
          );
        }
        this.#logSync(deviceId, book.id, "info", "sync.book.done", `Sent “${book.title}”`);
        if (cfg.upload.bookCooldownSec > 0 && index < toSend.length - 1) {
          await sleep(cfg.upload.bookCooldownSec * 1000);
        }
      } else {
        failed++;
        if (ok === "offline") {
          connectionLost = true;
          this.log.warn(
            "sync.interrupted",
            `Device ${label} stopped responding — ${toSend.length - index - 1} book(s) deferred ` +
              `to the next connection`,
            { deviceId },
          );
          break;
        }
      }
    }

    // Mirroring means folders come and go with the books in them: a book that
    // left, or moved, can strand the folder it was the last occupant of, and an
    // empty folder on the reader's shelf is litter the user has to clear by
    // hand.
    if (emptied.size) await this.#pruneEmptied(client, deviceId, emptied, targetDir);

    const durationMs = performance.now() - t0;
    const message = stopped
      ? `Stopped: ${sent} sent before the folder was removed`
      : connectionLost
      ? `Interrupted: ${sent} sent, ${failed} failed, ${deleted} removed`
      : `${sent} sent, ${failed} failed, ${deleted} removed, ${upToDate} already there`;
    this.log.info(
      "sync.done",
      `Sync finished for ${label}: ${message} in ${(durationMs / 1000).toFixed(1)}s`,
      { deviceId, detail: { sent, failed, deleted, upToDate, trigger } },
    );
    return { deviceId, started, durationMs, sent, failed, deleted, upToDate, message };
  }

  /**
   * Make sure a folder exists on the device, at most once per run.
   *
   * Never throws: a folder we could not create makes the books bound for it
   * fail one by one, which is reported per book — the same as any other upload
   * failure, and better than aborting a sync that has other folders to deliver.
   */
  async #ensureDeviceDir(
    client: DeviceClient,
    deviceId: string,
    dir: string,
    made: Set<string>,
  ): Promise<void> {
    const path = normalizeDevicePath(dir);
    if (made.has(path)) return;
    try {
      await client.ensureDir("/", path.split("/").filter(Boolean));
      made.add(path);
    } catch (err) {
      this.log.warn("sync.mkdir.failed", `Could not create ${path}: ${err}`, { deviceId });
    }
  }

  /**
   * Remove the folders that the books we just deleted or moved were the last
   * occupants of, walking up towards the upload path.
   *
   * Deliberately scoped to folders we emptied ourselves rather than sweeping
   * the device for empty ones: the upload path defaults to `/`, so a sweep
   * would cheerfully delete an empty folder the user made, or one the firmware
   * keeps for its own reasons. Stops at the first folder that still holds
   * something — including a file nobody here put there — and at anything it
   * cannot list, since "unreadable" must not read as "empty" on a device any
   * more than it does on a watched folder.
   */
  async #pruneEmptied(
    client: DeviceClient,
    deviceId: string,
    dirs: Set<string>,
    stopAt: string,
  ): Promise<void> {
    const root = normalizeDevicePath(stopAt);
    const inside = (p: string) => root === "/" ? p !== "/" : p.startsWith(`${root}/`);

    for (const start of dirs) {
      let dir = normalizeDevicePath(start);
      while (inside(dir)) {
        let entries: DeviceFile[];
        try {
          entries = await client.listDir(dir);
        } catch {
          break;
        }
        if (entries.length) break;
        try {
          await client.delete([dir]);
        } catch (err) {
          this.log.debug("sync.prune.failed", `Could not remove ${dir}: ${err}`, { deviceId });
          break;
        }
        this.log.debug("sync.prune", `Removed the now-empty folder ${dir}`, { deviceId });
        dir = parentDevicePath(dir);
      }
    }
  }

  /** Upload one book, retrying with backoff and cleaning up partial files. */
  async #uploadWithRetry(
    client: DeviceClient,
    deviceId: string,
    bookId: string,
    title: string,
    args: {
      host: string;
      port: number;
      uploadPath: string;
      filename: string;
      filePath: string;
      devicePath: string;
    },
  ): Promise<"sent" | "failed" | "offline"> {
    const cfg = this.config.current.upload;
    const attempts = Math.max(1, cfg.retries + 1);
    let lastErr: unknown = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.sidecar.call("upload", {
          host: args.host,
          port: args.port,
          uploadPath: args.uploadPath,
          filename: args.filename,
          filePath: args.filePath,
          chunkSize: cfg.chunkSize,
          timeout: cfg.socketTimeoutSec,
        }, (e) => {
          if (e.tag === "PROGRESS" && typeof e.sent === "number" && typeof e.total === "number") {
            this.bus.emit({
              level: "debug",
              event: "sync.progress",
              message: `${title}: ${fmtBytes(e.sent)} / ${fmtBytes(e.total)}`,
              deviceId,
              bookId,
              detail: { sent: e.sent, total: e.total, percent: e.total ? e.sent / e.total : 0 },
            });
          }
        });
        return "sent";
      } catch (err) {
        lastErr = err;
        const started = err instanceof SidecarError && err.uploadStarted;
        this.log.warn(
          "sync.upload.retry",
          `Upload of “${title}” failed (attempt ${attempt}/${attempts}): ${err}`,
          { deviceId, bookId },
        );
        if (started) {
          // Remove the partial file so a retry doesn't leave a corrupt book.
          await client.delete([args.devicePath]).catch((cleanupErr) =>
            this.log.debug("sync.cleanup", `Partial cleanup ignored: ${cleanupErr}`, { deviceId })
          );
        }
        if (attempt < attempts) await sleep(cfg.retryDelaySec * 1000 * attempt);
      }
    }

    // Last resort: the firmware's WebDAV endpoint (§8.2).
    if (cfg.webdavFallback) {
      try {
        this.log.info("sync.webdav", `Trying WebDAV upload for “${title}”`, { deviceId, bookId });
        await client.putFile(args.devicePath, await Deno.readFile(args.filePath));
        this.log.info("sync.webdav.ok", `WebDAV upload succeeded for “${title}”`, {
          deviceId,
          bookId,
        });
        return "sent";
      } catch (err) {
        await client.delete([args.devicePath]).catch(() => {});
        this.log.warn("sync.webdav.failed", `WebDAV upload failed for “${title}”: ${err}`, {
          deviceId,
          bookId,
        });
      }
    }

    this.#logSync(
      deviceId,
      bookId,
      "error",
      "sync.book.failed",
      `Failed to send “${title}”: ${lastErr}`,
    );
    this.log.error("sync.book.failed", `Failed to send “${title}”: ${lastErr}`, {
      deviceId,
      bookId,
    });
    return (await client.reachable()) ? "failed" : "offline";
  }

  /**
   * The bytes a device should receive for a book, ready to leave: resampled for
   * its profile, stamped with the source hash, and recorded so a page-sync
   * report about those bytes resolves back to this book.
   *
   * The three steps belong together, which is why this is one method and not
   * three calls at each site. The OPDS catalog serves the result of this
   * directly (`src/web/opds.ts`): a book the user pulls off the catalog by hand
   * has to be exactly as attributable as one we pushed — same cached optimized
   * copy, same OPF stamp, same document hashes — or its reading position lands
   * nowhere. Only the resampling can fail; stamping and mapping are best
   * effort, so a book still goes out when they don't work.
   */
  async prepareForDevice(
    book: Book,
    deviceId: string | null,
    profile: ResampleProfile | null,
  ): Promise<{ path: string; optimized: boolean }> {
    const { path, optimized } = await this.profiles.fileForSend(book, profile);
    // Human-readable names mean the file no longer carries the book id, so the
    // source hash goes into the EPUB before it leaves. That is what matches a
    // file found on a reader back to a book.
    await this.#stamp(path, book.id, deviceId);
    await this.#mapKosyncDocument(path, book.id, profile ? profile.id : null);
    return { path, optimized };
  }

  /** The resample profile a device's books are prepared for, if any. */
  profileFor(deviceId: string): ResampleProfile | null {
    const id = this.settings(deviceId).profile_id;
    return id ? this.profiles.get(id) ?? null : null;
  }

  /** Write the source hash into the delivered EPUB. Best effort: a book that
   * cannot be stamped still syncs, it just relies on the manifest alone. */
  async #stamp(path: string, bookId: string, deviceId: string | null) {
    try {
      await this.sidecar.call("stamp", { path, md5: bookId });
    } catch (err) {
      this.log.debug("sync.stamp.failed", `Could not stamp ${path}: ${err}`, {
        deviceId: deviceId ?? undefined,
        bookId,
      });
    }
  }

  /**
   * Re-derive the document hashes for every book already delivered.
   *
   * `#mapKosyncDocument` runs only when a book is *sent*, so a correction to how
   * a hash is computed would otherwise reach only books a reader has yet to
   * receive — everything already on a device would keep reporting its position
   * into nothing, with no sign of it beyond a line in the log. Keyed by
   * `DOCUMENT_HASH_VERSION`, so it runs once per correction and not on every
   * start; bump that constant whenever `koreaderPartialMd5` or the set of
   * hashes recorded changes.
   *
   * Safe to repeat and safe to interrupt: each row is an upsert keyed on the
   * hash, and the marker is only written once every book is done.
   */
  async remapDeliveredDocuments(): Promise<void> {
    const KEY = "kosync.document.hash.version";
    const done = this.db.get<{ value: string }>(
      "SELECT value FROM setting WHERE key = ?",
      KEY,
    )?.value;
    if (done === DOCUMENT_HASH_VERSION) return;

    const rows = this.db.all<{ book_id: string }>(
      `SELECT book_id FROM device_content
       UNION
       SELECT book_id FROM kosync_document`,
    );
    if (!rows.length) {
      this.db.run(
        `INSERT INTO setting (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        KEY,
        DOCUMENT_HASH_VERSION,
      );
      return;
    }

    const started = performance.now();
    let books = 0;
    for (const { book_id } of rows) {
      const book = this.books.get(book_id);
      // The optimized copies are the bytes that actually went to a reader; the
      // converted EPUB only did if the device syncs with no profile at all.
      const paths = await this.profiles.cachedCopies(book_id);
      if (book?.epub_path) paths.push(book.epub_path);
      for (const path of paths) {
        // A cached copy can be deleted under us; the stale mapping it leaves is
        // harmless, so a miss is skipped rather than aborting the pass.
        await this.#mapKosyncDocument(path, book_id, null);
      }
      if (paths.length) books++;
    }

    this.db.run(
      `INSERT INTO setting (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      KEY,
      DOCUMENT_HASH_VERSION,
    );
    this.log.info(
      "kosync.remapped",
      `Re-identified ${books} already-delivered book(s) for page sync in ` +
        `${((performance.now() - started) / 1000).toFixed(1)}s`,
    );
  }

  /**
   * Remember how the reader will refer to this file. CrossPoint reports a
   * 32-hex MD5 but which one is not documented, so both candidates over the
   * delivered bytes are recorded and whichever arrives resolves (docs/DESIGN.md).
   */
  async #mapKosyncDocument(path: string, bookId: string, profileId: string | null) {
    try {
      const hashes = [await md5File(path), await koreaderPartialMd5(path)];
      for (const hash of hashes) {
        this.db.run(
          `INSERT INTO kosync_document (document_hash, book_id, profile_hash, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (document_hash) DO UPDATE SET book_id = excluded.book_id`,
          hash,
          bookId,
          profileId,
          new Date().toISOString(),
        );
      }
    } catch (err) {
      this.log.debug("sync.kosync.map.failed", `Could not map document hash: ${err}`, { bookId });
    }
  }

  #logSync(deviceId: string, bookId: string | null, level: string, event: string, detail: string) {
    this.db.run(
      "INSERT INTO sync_log (device_id, book_id, ts, level, event, detail) VALUES (?, ?, ?, ?, ?, ?)",
      deviceId,
      bookId,
      new Date().toISOString(),
      level,
      event,
      detail,
    );
  }
}

/**
 * The folders a source file sits in, relative to its watched folder — the
 * structure the device mirrors.
 *
 * Pure, and it answers "no folders" rather than guessing whenever the file is
 * not plainly under the root it was indexed from: the alternative is a path
 * assembled from a mismatched prefix, which would scatter books into folders
 * named after fragments of somebody's home directory. Both strings come from
 * the same walk (`file_index.path` is built from `LibraryConfig.path`), so they
 * agree in case and spelling; if they ever don't, flat is the safe answer.
 */
export function relativeDirSegments(
  sourcePath: string,
  libraryRoot: string,
  maxDepth = MIRROR_MAX_DEPTH,
): string[] {
  const path = sourcePath.replace(/\\/g, "/");
  const root = libraryRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root || !path.startsWith(`${root}/`)) return [];
  return path
    .slice(root.length + 1)
    .split("/")
    .slice(0, -1) // the filename is named by `deviceFilename()`, not by disk
    .filter(Boolean)
    .slice(0, maxDepth);
}

/** The folder holding a device path. `/` is its own parent. */
export function parentDevicePath(path: string): string {
  const normalized = normalizeDevicePath(path);
  const cut = normalized.lastIndexOf("/");
  return cut > 0 ? normalized.slice(0, cut) : "/";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type { ResampleProfile };
export { Profiles };
