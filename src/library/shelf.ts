// What a shelf is *of*.
//
// The library, a person and a reader are three different questions, and until
// now all three returned the same answer — every book in every watched folder,
// with a different checkbox on each folder header. The scope switch changed the
// annotation rather than the contents, which is why picking somebody's name did
// not show you their books.
//
// Resolving a scope has to happen here rather than as a join, because the folder
// rules that bind a folder to a reader live in `config.json` and not in SQLite
// (`Scanner.librariesForDevice()`). Kept out of `src/web/server.ts` so it can be
// tested without a listener, and so the catalog can adopt it later.
import type { Books } from "./books.ts";
import type { Scanner } from "./scanner.ts";
import type { Db } from "../core/db.ts";
import type { UserConfig } from "../core/config.ts";
import type { Pins } from "../sync/pins.ts";

export type Scope =
  | { kind: "all" }
  | { kind: "user"; id: string }
  | { kind: "device"; id: string };

export interface ResolvedScope {
  libraryIds: string[] | undefined;
  includeBookIds: string[];
  /** Whose reading progress the shelf carries. A shelf is always somebody's. */
  userId: string;
}

/** `all`, `user:<id>` or `device:<id>` — the wire form of a scope. */
export function parseScope(raw: string | null): Scope {
  if (!raw || raw === "all") return { kind: "all" };
  const [kind, ...rest] = raw.split(":");
  const id = rest.join(":");
  if (id && (kind === "user" || kind === "device")) return { kind, id };
  return { kind: "all" };
}

export function resolveScope(
  scope: Scope,
  deps: {
    db: Db;
    books: Books;
    scanner: Scanner;
    pins: Pins;
    users: UserConfig[];
    holderOf: (deviceId: string) => string | null;
  },
): ResolvedScope {
  const fallbackUser = deps.users[0]?.id ?? "";

  if (scope.kind === "all") {
    return { libraryIds: undefined, includeBookIds: [], userId: fallbackUser };
  }

  if (scope.kind === "device") {
    return {
      libraryIds: deps.scanner.librariesForDevice(scope.id).map((l) => l.id),
      // Sent by hand, and already carried. The second term is what makes this
      // page mean "what is on this reader" rather than "what a sync would
      // choose to put there" — including books whose rule was dropped, or whose
      // file has left the library, which a sync deliberately never removes.
      includeBookIds: [
        ...new Set([...deps.pins.idsFor(scope.id), ...onDevice(deps.db, scope.id)]),
      ],
      userId: deps.holderOf(scope.id) ?? fallbackUser,
    };
  }

  // A person: everything their readers carry, plus the pile they are part-way
  // through. That last term is what gives the page meaning for somebody who
  // holds no reader at all — otherwise it would be empty and read as broken.
  const deviceIds = deps.users.find((u) => u.id === scope.id)
    ? devicesHeldBy(deps.db, scope.id)
    : [];
  const libraryIds = new Set<string>();
  const include = new Set<string>(reading(deps.db, scope.id));
  for (const deviceId of deviceIds) {
    for (const lib of deps.scanner.librariesForDevice(deviceId)) libraryIds.add(lib.id);
    for (const id of deps.pins.idsFor(deviceId)) include.add(id);
    for (const id of onDevice(deps.db, deviceId)) include.add(id);
  }
  return { libraryIds: [...libraryIds], includeBookIds: [...include], userId: scope.id };
}

const onDevice = (db: Db, deviceId: string): string[] =>
  db.all<{ book_id: string }>(
    "SELECT book_id FROM device_content WHERE device_id = ?",
    deviceId,
  ).map((r) => r.book_id);

const devicesHeldBy = (db: Db, userId: string): string[] =>
  db.all<{ device_id: string }>(
    "SELECT device_id FROM device_settings WHERE user_id = ?",
    userId,
  ).map((r) => r.device_id);

const reading = (db: Db, userId: string): string[] =>
  db.all<{ book_id: string }>(
    `SELECT book_id FROM reading_state
      WHERE user_id = ? AND (percentage > 0 OR finished = 1)`,
    userId,
  ).map((r) => r.book_id);
