import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";

import {
  deviceFilename,
  devicePlacements,
  legacyBookIdFromFilename,
  newId,
  sanitizeForFilename,
  shortHash,
} from "../src/core/ids.ts";
import { relativeDirSegments } from "../src/sync/engine.ts";
import { createHash } from "node:crypto";
import { koreaderPartialMd5, md5Bytes, md5File } from "../src/core/hash.ts";
import { detectDrm } from "../src/library/drm.ts";
import { joinDevicePath, normalizeDevicePath } from "../src/device/client.ts";
import { stableIdentity } from "../src/device/manager.ts";
import { metadataFromFilename, parseMetaOutput } from "../src/library/calibre.ts";
import { profileHash, type ResampleProfile } from "../src/sync/profiles.ts";
import { groupsFor } from "../src/web/ui/grouping.ts";
import type { Library as UiLibrary, LibraryBook } from "../src/web/ui/types.ts";

Deno.test("ids: newId is sortable and unique", () => {
  const early = newId(1_000_000);
  const late = newId(2_000_000);
  assert(early < late, `${early} should sort before ${late}`);
  assertEquals(new Set(Array.from({ length: 500 }, () => newId())).size, 500);
  assertMatch(newId(), /^[0-9a-z]{16}$/);
});

Deno.test("ids: device filenames are human readable and firmware-safe", () => {
  const name = deviceFilename("Émile’s Guide to Ünicode: Part 2/3", "Ada Lovelace");
  // Spaces are kept — this is a name read off a reader's screen. Everything the
  // firmware or the upload handshake would choke on is not: no colon (the
  // handshake is `START:<name>:<size>:<dir>`), no slash, nothing non-ASCII.
  assertMatch(name, /^[A-Za-z0-9 ._-]+\.epub$/);
  assert(name.includes("Emile"), name);
  assert(name.includes("Ada Lovelace"), name);
  assertEquals(deviceFilename("Piranesi", "Susanna Clarke"), "Piranesi - Susanna Clarke.epub");
  assertEquals(deviceFilename("Piranesi"), "Piranesi.epub");
});

Deno.test("ids: books are placed in the folders they sit in on disk", () => {
  const books = [
    { id: "a".repeat(32), title: "Dune", author: "Frank Herbert", relDir: ["Sci-Fi"] },
    { id: "b".repeat(32), title: "Emma", author: "Jane Austen", relDir: ["Classics", "Austen"] },
    { id: "c".repeat(32), title: "Piranesi", author: "Susanna Clarke" },
  ];
  const places = devicePlacements(books);
  assertEquals(places.get(books[0].id), {
    dir: ["Sci-Fi"],
    filename: "Dune - Frank Herbert.epub",
  });
  assertEquals(places.get(books[1].id)?.dir, ["Classics", "Austen"]);
  assertEquals(places.get(books[2].id)?.dir, [], "a book at the top stays at the top");

  // Folder names go through the same sanitizer, and one that survives it as
  // nothing is dropped rather than becoming a level called "book".
  assertEquals(
    devicePlacements([{ ...books[0], relDir: ["Sci Fi: 1970s", "???"] }])
      .get(books[0].id)?.dir,
    ["Sci Fi 1970s"],
  );
});

Deno.test("ids: a hand-sent book is filed under its own folder", () => {
  // A book sent to a reader out of a folder no rule covers still mirrors that
  // folder. Not a nicety: it is what makes adding the rule afterwards a no-op
  // rather than a send-then-delete for every book already up there — and it
  // keeps sent books out of the upload root, where every folder name lives and
  // collisions are likeliest.
  const ruled = [
    { id: "a".repeat(32), title: "Dune", author: "Frank Herbert", relDir: ["Fiction"] },
    { id: "b".repeat(32), title: "Emma", author: "Jane Austen", relDir: ["Fiction"] },
  ];
  const sent = { id: "c".repeat(32), title: "Maus", author: "Art Spiegelman", relDir: ["Comics"] };

  const withSent = devicePlacements([...ruled, sent]);
  assertEquals(withSent.get(sent.id)?.dir, ["Comics"]);

  // Adding it must not disturb where the rule-covered books already sit, and
  // its own placement must be the same as if the rule had covered it all along.
  const ruleOnly = devicePlacements(ruled);
  for (const book of ruled) {
    assertEquals(withSent.get(book.id), ruleOnly.get(book.id), `${book.title} moved`);
  }
  const asIfRuled = devicePlacements([...ruled, sent]);
  assertEquals(withSent.get(sent.id), asIfRuled.get(sent.id));

  // It lands in a folder of its own, so it cannot collide with anything the
  // rules put on the reader.
  assert(withSent.get(sent.id)?.filename === "Maus - Art Spiegelman.epub");
});

Deno.test("ids: names collide only within a folder, and break deterministically", () => {
  const books = [
    { id: "a".repeat(32), title: "Selected Poems", author: "Anon" },
    { id: "b".repeat(32), title: "Selected Poems", author: "Anon" },
    { id: "c".repeat(32), title: "Piranesi", author: "Susanna Clarke" },
  ];
  const places = devicePlacements(books);
  const paths = (m: Map<string, { dir: string[]; filename: string }>) =>
    new Set([...m.values()].map((p) => [...p.dir, p.filename].join("/")));
  assertEquals(paths(places).size, 3, "paths must be unique");
  // Same input, same output, regardless of the order books sync in.
  assertEquals(places, devicePlacements([...books].reverse()));
  assertEquals(places.get(books[2].id)?.filename, "Piranesi - Susanna Clarke.epub");
  assert(places.get(books[0].id)?.filename.includes(books[0].id.slice(0, 6)));

  // The same title and author in *different* folders is not a collision at all,
  // so neither copy is disfigured with a hash.
  const filed = devicePlacements([
    { ...books[0], relDir: ["A"] },
    { ...books[1], relDir: ["B"] },
  ]);
  assertEquals(paths(filed).size, 2);
  for (const place of filed.values()) {
    assertEquals(place.filename, "Selected Poems - Anon.epub");
  }
});

Deno.test("ids: files from the old scheme stay attributable for cleanup", () => {
  const id = newId();
  assertEquals(legacyBookIdFromFilename(`${id}__Some_Title.epub`), id);
  assertEquals(legacyBookIdFromFilename("Piranesi_-_Susanna_Clarke.epub"), null);
});

Deno.test("ids: sanitize keeps something usable", () => {
  assertEquals(sanitizeForFilename("  A  Tale   of Two  Cities "), "A Tale of Two Cities");
  assertEquals(sanitizeForFilename("###"), "book");
  assert(sanitizeForFilename("x".repeat(200)).length <= 60);
  // Truncation must not leave a trailing space or dot, which FAT-ish naming
  // treats as a name of its own.
  assertMatch(sanitizeForFilename("x".repeat(59) + " tail"), /[A-Za-z0-9]$/);
});

Deno.test("sync: the device mirrors the folders a book sits in on disk", () => {
  assertEquals(relativeDirSegments("/books/shelf/Sci-Fi/Dune.epub", "/books/shelf"), ["Sci-Fi"]);
  assertEquals(relativeDirSegments("/books/shelf/Dune.epub", "/books/shelf"), []);
  // A trailing slash on the configured folder is not a difference.
  assertEquals(relativeDirSegments("/books/shelf/A/B/x.epub", "/books/shelf/"), ["A", "B"]);

  // Depth is capped: the firmware makes one folder per request, and a book
  // below `listEpubs()`'s recursion limit would be invisible to us and re-sent
  // on every sync.
  assertEquals(
    relativeDirSegments("/r/a/b/c/d/e/f/x.epub", "/r"),
    ["a", "b", "c", "d"],
  );

  // Not under the folder it was indexed from: flat, rather than a path built
  // from a mismatched prefix.
  assertEquals(relativeDirSegments("/elsewhere/Dune.epub", "/books/shelf"), []);
  assertEquals(relativeDirSegments("/books/shelf-other/Dune.epub", "/books/shelf"), []);
  assertEquals(relativeDirSegments("/books/shelf/Dune.epub", ""), []);
});

Deno.test("profileHash changes with every setting that alters output", () => {
  const base: ResampleProfile = {
    id: "p1",
    name: "X4",
    device_model: "X4",
    jpeg_quality: 85,
    grayscale: 1,
    auto_crop: 0,
    split_text: 1,
  };
  const h = profileHash(base);
  assertEquals(h, profileHash({ ...base, id: "p2", name: "renamed" })); // cosmetic only
  for (
    const patch of [
      { device_model: "X3" },
      { jpeg_quality: 70 },
      { grayscale: 0 },
      { auto_crop: 1 },
      { split_text: 0 },
    ] as Partial<ResampleProfile>[]
  ) {
    assertNotEquals(h, profileHash({ ...base, ...patch }), `hash ignored ${JSON.stringify(patch)}`);
  }
});

Deno.test("shortHash is stable and 8 hex chars", () => {
  assertEquals(shortHash("abc"), shortHash("abc"));
  assertMatch(shortHash("abc"), /^[0-9a-f]{8}$/);
  assertNotEquals(shortHash("abc"), shortHash("abd"));
});

Deno.test("device paths normalize to the firmware's form", () => {
  assertEquals(normalizeDevicePath("books//a.epub"), "/books/a.epub");
  assertEquals(normalizeDevicePath("\\books\\a.epub"), "/books/a.epub");
  assertEquals(normalizeDevicePath("/a.epub"), "/a.epub");
  assertEquals(normalizeDevicePath(""), "");
  assertEquals(joinDevicePath("/", "a.epub"), "/a.epub");
  assertEquals(joinDevicePath("/books", "a.epub"), "/books/a.epub");
});

Deno.test("stable device identity prefers hardware fields over the address", () => {
  assertEquals(stableIdentity({ device: "X4" }), null);
  const byUuid = stableIdentity({ device: "X4", uuid: "ABC-123-DEF" });
  assertEquals(byUuid?.strategy, "uuid");
  // same hardware at a new IP -> same id
  assertEquals(stableIdentity({ device: "X4", uuid: "ABC-123-DEF" })?.id, byUuid?.id);
  assertNotEquals(stableIdentity({ device: "X4", uuid: "OTHER-456" })?.id, byUuid?.id);
  // junk values are ignored
  assertEquals(stableIdentity({ device: "X4", uuid: "000" }), null);
});

Deno.test("ebook-meta output parses into metadata", () => {
  const out = [
    "Title               : The Long Sentence",
    "Author(s)           : Ursula Tester [Tester, Ursula]",
    "Series              : Testing Times #3",
    "Languages           : eng",
    "Comments            : A book about",
    "                      several lines.",
  ].join("\n");
  const meta = parseMetaOutput(out);
  assertEquals(meta.title, "The Long Sentence");
  assertEquals(meta.author, "Ursula Tester");
  assertEquals(meta.series, "Testing Times");
  assertEquals(meta.seriesIndex, 3);
  assertEquals(meta.languages, "eng");
  assertEquals(meta.comments, "A book about several lines.");
  assertEquals(parseMetaOutput("Title : Unknown").title, undefined);
});

Deno.test("filename fallback splits author and title", () => {
  assertEquals(metadataFromFilename("Ursula Tester - The Long Sentence.mobi"), {
    author: "Ursula Tester",
    title: "The Long Sentence",
  });
  assertEquals(metadataFromFilename("just_a_book.epub").title, "just a book");
});

Deno.test("hash: identity follows content, not name or location", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const bytes = new TextEncoder().encode("the same bytes");
    const a = `${dir}/original.epub`;
    const b = `${dir}/renamed and moved.epub`;
    await Deno.writeFile(a, bytes);
    await Deno.writeFile(b, bytes);

    const hashA = await md5File(a);
    assertEquals(hashA, await md5File(b), "rename must not change identity");
    assertEquals(hashA, md5Bytes(bytes));

    await Deno.writeFile(b, new TextEncoder().encode("different bytes"));
    assertNotEquals(hashA, await md5File(b));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("hash: KOReader partial MD5 is stable and content-derived", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const big = new Uint8Array(200_000);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const path = `${dir}/book.epub`;
    await Deno.writeFile(path, big);

    const first = await koreaderPartialMd5(path);
    assertEquals(first, await koreaderPartialMd5(path));
    assertMatch(first, /^[0-9a-f]{32}$/);
    // It samples rather than reading everything, so it differs from the plain
    // MD5 — both are recorded because CrossPoint's choice isn't documented.
    assertNotEquals(first, await md5File(path));

    // The offsets are the reader's, not ours to choose: they are `1024 << 2i`
    // in 32-bit for i in -1..10, so the first one wraps to 0. Pinned against a
    // literal transcription rather than the constant, because computing them as
    // `1024 * 4^i` samples from 256 and matches nothing the reader reports.
    const expect = createHash("md5");
    for (const off of [0, 1024, 4096, 16384, 65536]) {
      expect.update(big.subarray(off, off + 1024));
    }
    assertEquals(first, expect.digest("hex"));

    // The head of the file is sampled, so a change to byte 0 has to show up.
    // Sampling from 256 leaves this file hashing identically.
    const moved = big.slice();
    moved[0] ^= 0xff;
    await Deno.writeFile(`${dir}/moved.epub`, moved);
    assertNotEquals(first, await koreaderPartialMd5(`${dir}/moved.epub`));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("drm: an ordinary EPUB is not flagged", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // A minimal zip whose entry names contain no encryption marker.
    const path = `${dir}/plain.epub`;
    await Deno.writeFile(
      path,
      new TextEncoder().encode("PK\u0003\u0004mimetypeapplication/epub+zip"),
    );
    assertEquals((await detectDrm(path, "epub")).drm, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("drm: an Adobe-encrypted EPUB is flagged", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/drm.epub`;
    await Deno.writeFile(
      path,
      new TextEncoder().encode(
        "PK\u0003\u0004META-INF/encryption.xml ... META-INF/rights.xml ... adept",
      ),
    );
    const check = await detectDrm(path, "epub");
    assertEquals(check.drm, "adobe");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("drm: an .acsm is reported as a loan token, not a book", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/loan.acsm`;
    await Deno.writeFile(path, new TextEncoder().encode("<fulfillmentToken/>"));
    assertEquals((await detectDrm(path, "acsm")).drm, "adobe");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("drm: a Mobipocket-encrypted Kindle file is flagged", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // A Palm database header: record 0's offset at byte 78, and that record's
    // PalmDOC encryption field at its own offset 12.
    const buf = new Uint8Array(200);
    const view = new DataView(buf.buffer);
    const rec0 = 100;
    view.setUint32(78, rec0, false);
    view.setUint16(rec0 + 12, 2, false); // 2 = Mobipocket DRM
    const path = `${dir}/book.azw3`;
    await Deno.writeFile(path, buf);

    const check = await detectDrm(path, "azw3");
    assertEquals(check.drm, "kindle");
    assertEquals(check.detail, "Kindle DRM");

    // 0 means no encryption, and must not be reported as protected.
    view.setUint16(rec0 + 12, 0, false);
    await Deno.writeFile(path, buf);
    assertEquals((await detectDrm(path, "azw3")).drm, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("drm: a KFX payload is caught whatever the file is called", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // Observed on a real Kindle library: a modern KFX book can be stored as an
    // `.azw` whose contents are a DRMION payload rather than a Palm database.
    // Trusting the extension parses garbage and calls the book unprotected,
    // after which it fails at conversion with nothing naming the real cause.
    const drmion = new Uint8Array(200);
    drmion.set([0xea, 0x44, 0x52, 0x4d, 0x49, 0x4f, 0x4e, 0xee], 0);
    const path = `${dir}/B0026LTNFO_EBOK.azw`;
    await Deno.writeFile(path, drmion);

    const check = await detectDrm(path, "azw");
    assertEquals(check.drm, "kfx", "a DRMION payload named .azw must not read as unprotected");
    assertStringIncludes(check.detail ?? "", "voucher");

    // Same payload under the names it more usually carries.
    assertEquals((await detectDrm(path, "kfx")).drm, "kfx");
    assertEquals((await detectDrm(path, "azw8")).drm, "kfx");
    // The zip container carries the voucher and is ordinary Kindle DRM.
    assertEquals((await detectDrm(path, "kfx-zip")).drm, "kindle");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- DeDRM ------------------------------------------------------------------

import { dedrmState, parsePluginList, staleDrmPlugins, validSerial } from "../src/library/dedrm.ts";

/**
 * Real `calibre-customize --list-plugins` output, captured from a machine
 * carrying three superseded DRM plugins. The `Failed to initialize` lines are
 * printed on **stdout**, which is what made a naive `/dedrm/i` grep report a
 * working DeDRM when none was installed.
 */
const LIST_PLUGINS_WITH_STALE =
  `Failed to initialize plugin: '/Users/x/Library/Preferences/calibre/plugins/Ignoble Epub DeDRM.zip'
Failed to initialize plugin: '/Users/x/Library/Preferences/calibre/plugins/Inept Epub DeDRM.zip'
Failed to initialize plugin: '/Users/x/Library/Preferences/calibre/plugins/Inept PDF DeDRM.zip'
Type                  Name                        Version        Disabled       Site Customization

File type             HTML to ZIP                 (5, 19, 0)     False
\t Follow all local links in an HTML file and create a ZIP file containing all linked files.
\t Character encoding for the input HTML files.

File type             KPF Extract                 (1, 0, 0)      False

Metadata source       Amazon.com                  (1, 3, 6)      False
`;

Deno.test("dedrm: stale plugin load failures are not mistaken for an install", () => {
  const parsed = parsePluginList(LIST_PLUGINS_WITH_STALE);

  // The regression: the string "DeDRM" appears three times in this output.
  assertEquals(/dedrm/i.test(LIST_PLUGINS_WITH_STALE), true);
  assertEquals(dedrmState(parsed), "missing");

  assertEquals(staleDrmPlugins(parsed), [
    "Ignoble Epub DeDRM",
    "Inept Epub DeDRM",
    "Inept PDF DeDRM",
  ]);
  // Descriptions are TAB-indented continuations, not rows.
  assertEquals(parsed.plugins.map((p) => p.name), ["HTML to ZIP", "KPF Extract", "Amazon.com"]);
  assertEquals(parsed.plugins[0].version, "(5, 19, 0)");
});

Deno.test("dedrm: an installed plugin is only 'ok' when it is also enabled", () => {
  const table = (disabled: string) =>
    `Type                  Name                        Version        Disabled       Site Customization

File type             DeDRM                       (10, 0, 3)     ${disabled}
\t Removes DRM from ebooks.
`;

  assertEquals(dedrmState(parsePluginList(table("False"))), "ok");
  assertEquals(dedrmState(parsePluginList(table("True"))), "disabled");
  assertEquals(staleDrmPlugins(parsePluginList(table("False"))), []);
});

Deno.test("dedrm: only DRM-related plugins are offered for removal", () => {
  const parsed = parsePluginList(
    `Failed to initialize plugin: '/x/plugins/Some Other Plugin.zip'
Failed to initialize plugin: '/x/plugins/DeDRM.zip'
Type                  Name                        Version        Disabled       Site Customization
`,
  );
  assertEquals(parsed.failed.length, 2);
  assertEquals(staleDrmPlugins(parsed), ["DeDRM"]);
});

Deno.test("dedrm: a Kindle serial is validated without changing its case", () => {
  // Case is preserved: DeDRM compares serials case-sensitively, so folding it
  // would produce a key that silently never matches.
  assertEquals(validSerial("B0aF12345678CdEf").serial, "B0aF12345678CdEf");
  // Spaces and dashes are how people transcribe them off the device.
  assertEquals(validSerial(" B002 3456 7890 1234 ").serial, "B002345678901234");

  assertEquals(validSerial("").serial, undefined);
  assertEquals(validSerial("B0023456").serial, undefined);
  assertEquals(validSerial("B00234567890123!").serial, undefined);
  // The message should say what is wrong, not just that something is.
  assertStringIncludes(validSerial("B0023456").error ?? "", "16 characters");
});

// --- import failures --------------------------------------------------------

import { classifyImportFailure } from "../src/library/ingest.ts";

Deno.test("ingest: late failures are told apart by what Calibre actually said", () => {
  // All four of these arrive as a Python traceback from a subprocess, and
  // without classification every one of them reads as "conversion is broken".
  // Messages captured from real runs against a real Kindle library.

  // Amazon's current KFX voucher — no key or plugin will ever help.
  assertEquals(
    classifyImportFailure(
      "Exception: Unknown type encountered in envelope, expected VoucherEnvelope",
    ),
    "drm-kfx",
  );
  assertEquals(
    classifyImportFailure(
      "KFXDRMError: Book container CR!HPFTAF2BKS08VFKZAJNPQ1HZA8AA.azw9.md has DRM " +
        "and cannot be converted",
    ),
    "drm-kfx",
  );

  // Still encrypted after DeDRM ran: a key problem, and solvable.
  assertEquals(
    classifyImportFailure(
      "calibre.ebooks.DRMError: The Contact: The ascendancy of mankind is being decided",
    ),
    "drm-key",
  );
  assertEquals(
    classifyImportFailure("DeDRM v10.0.3: Ultimately failed to decrypt after 5.4 seconds."),
    "drm-key",
  );

  // Nothing wrong with the book at all — Calibre is simply open.
  assertEquals(
    classifyImportFailure(
      "calibredb add failed (exit 1): Another calibre program such as calibre-server " +
        "or the main calibre program is running.",
    ),
    "calibre-busy",
  );

  // An ordinary conversion error stays an ordinary failure.
  assertEquals(classifyImportFailure("ebook-convert failed: Unsupported input format"), null);
});

// --- existing e-reader libraries --------------------------------------------

import {
  adeAccepts,
  calibreAccepts,
  enumerate,
  knownSources,
  sourceById,
} from "../src/library/sources.ts";

Deno.test("sources: Calibre's non-book files are skipped", () => {
  assert(calibreAccepts("John Schember/Quick Start (1)/Quick Start - John Schember.epub"));
  assert(calibreAccepts("Nick Harkaway/Gone-Away (6)/Gone-Away - Nick Harkaway.mobi"));

  // `.original_epub` is Calibre's pre-conversion backup, not a second book.
  assertEquals(calibreAccepts("A/B (1)/Flatland - Edwin A. Abbott.original_epub"), false);
  assertEquals(calibreAccepts("A/B (1)/metadata.opf"), false);
  assertEquals(calibreAccepts("A/B (1)/cover.jpg"), false);
  assertEquals(calibreAccepts("metadata_db_prefs_backup.json"), false);
});

Deno.test("sources: the allowlist is the only way to a path", async () => {
  // Choosing happens by id; an unknown id yields nothing at all.
  assertEquals(sourceById("calibre")?.label, "Calibre library");
  // The Kindle apps are deliberately gone — their DRM cannot be removed.
  assertEquals(sourceById("kindle-mac"), undefined);
  assertEquals(sourceById("../../etc"), undefined);
  assertEquals(sourceById("/etc/passwd"), undefined);
  // Every offered source names its own fixed candidates.
  for (const s of knownSources()) {
    assert(s.candidates.length > 0, `${s.id} has no candidate paths`);
    assert(s.candidates.every((c) => c.startsWith("/") || /^[A-Za-z]:/.test(c)), s.id);
  }
  assert(adeAccepts("Some Book.epub"));

  // The walk applies the source's filter *and* the extension check, so a
  // preview never counts files the scanner would then skip.
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/Author/Title (1)`, { recursive: true });
    await Deno.writeTextFile(`${dir}/Author/Title (1)/Title - Author.epub`, "book");
    await Deno.writeTextFile(`${dir}/Author/Title (1)/Title - Author.original_epub`, "backup");
    await Deno.writeTextFile(`${dir}/Author/Title (1)/metadata.opf`, "meta");
    await Deno.writeTextFile(`${dir}/metadata.db`, "index");

    const calibre = knownSources().find((s) => s.id === "calibre")!;
    const { files } = await enumerate(calibre, dir);
    assertEquals(files.map((f) => f.split("/").pop()), ["Title - Author.epub"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- reading progress -------------------------------------------------------

import { Db } from "../src/core/db.ts";
import { FINISHED_AT, Reading, storedReport } from "../src/sync/reading.ts";
import type { EventBus } from "../src/core/events.ts";
import type { Logger } from "../src/core/log.ts";

const BOOK = "a".repeat(32);

/**
 * Two people, each with a copy of the same book in their own folder — the case
 * that makes attribution matter, because identical bytes mean an identical
 * document hash.
 */
function readingFixture(dbPath: string) {
  const db = new Db(dbPath);
  const noop = () => {};
  const log = { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
  const bus = { emit: noop } as unknown as EventBus;

  const now = new Date().toISOString();
  db.run(
    "INSERT INTO book (id, title, author, added_at, original_ext) VALUES (?, 'Piranesi', 'Clarke', ?, 'epub')",
    BOOK,
    now,
  );
  for (const [lib, path] of [["lib-1", "/tmp/a/p.epub"], ["lib-2", "/tmp/b/p.epub"]]) {
    db.run(
      "INSERT INTO library_book (library_id, book_id, path, added_at) VALUES (?, ?, ?, ?)",
      lib,
      BOOK,
      path,
      now,
    );
  }
  db.run(
    "INSERT INTO kosync_document (document_hash, book_id, created_at) VALUES ('doc-hash', ?, ?)",
    BOOK,
    now,
  );
  return { db, reading: new Reading(db, log, bus) };
}

Deno.test("reading: progress is attributed to a person, never guessed", async (t) => {
  const dir = await Deno.makeTempDir();
  const { db, reading } = readingFixture(`${dir}/db.sqlite`);
  try {
    await t.step("an unknown document is ignored, not guessed at", () => {
      assertEquals(
        reading.record({ document: "nope", percentage: 0.5 }, "stu", "device-1").bookId,
        null,
      );
    });

    await t.step("progress lands only against the user who authenticated", () => {
      const { bookId } = reading.record(
        { document: "doc-hash", percentage: 0.42, device: "X4" },
        "stu",
        "device-1",
      );
      assertEquals(bookId, BOOK);
      assertEquals(reading.get("stu", BOOK)!.percentage, 0.42);
      // The other person has the same book and the same document hash; their
      // position must be untouched.
      assertEquals(reading.get("sarah", BOOK), undefined);
    });

    await t.step("each person keeps their own position for the same book", () => {
      reading.record({ document: "doc-hash", percentage: 0.9 }, "sarah", null);
      assertEquals(reading.get("stu", BOOK)!.percentage, 0.42);
      assertEquals(reading.get("sarah", BOOK)!.percentage, 0.9);
    });

    await t.step("one person reading from two folders has a single position", () => {
      // The book is in lib-1 and lib-2; progress is keyed by user, so there is
      // exactly one row for them regardless of which folder it came from.
      reading.record({ document: "doc-hash", percentage: 0.55 }, "stu", "device-1");
      assertEquals(
        db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reading_state WHERE user_id = 'stu'")!.n,
        1,
      );
      assertEquals(reading.get("stu", BOOK)!.percentage, 0.55);
    });

    await t.step("removing a person drops their positions only", () => {
      reading.forgetUser("sarah");
      assertEquals(reading.get("sarah", BOOK), undefined);
      assertEquals(reading.get("stu", BOOK)!.percentage, 0.55);
      // Put it back for the steps that follow.
      reading.record({ document: "doc-hash", percentage: 0.9 }, "sarah", null);
    });

    await t.step("CrossPoint's pctQ wins over percentage and is scaled", () => {
      reading.record(
        { document: "doc-hash", percentage: 0.1, position: { pctQ: 750_000 } },
        "stu",
        "device-1",
      );
      assertEquals(reading.get("stu", BOOK)!.percentage, 0.75);
    });

    await t.step("crossing the threshold marks it finished automatically", () => {
      reading.record({ document: "doc-hash", percentage: FINISHED_AT }, "stu", "device-1");
      const state = reading.get("stu", BOOK)!;
      assertEquals(state.finished, 1);
      assertEquals(state.finished_source, "auto");
    });

    await t.step("a manual flag outranks later reports from the reader", () => {
      reading.setFinished("stu", BOOK, false);
      reading.record({ document: "doc-hash", percentage: 1 }, "stu", "device-1");
      const state = reading.get("stu", BOOK)!;
      assertEquals(state.finished, 0, "the reader must not undo a manual override");
      assertEquals(state.finished_source, "manual");
    });

    await t.step("the whole report is kept, so the reader gets its own locator back", () => {
      // A percentage with no locator is what makes a reader open a book at page
      // one despite having synced it — only the reader can read its own
      // position, so whatever it sent has to come back verbatim.
      reading.record(
        {
          document: "doc-hash",
          progress: "/body/DocFragment[3]/body/p[17]/text().0",
          percentage: 0.4,
          device: "White X3",
          device_id: "x3-1",
          position: { spine: 3, page: 88, pctQ: 400_000 },
        },
        "stu",
        "device-1",
      );
      const stored = storedReport(reading.get("stu", BOOK)!.position_json);
      assertEquals(stored.progress, "/body/DocFragment[3]/body/p[17]/text().0");
      assertEquals(stored.device, "White X3");
      assertEquals(stored.position?.page, 88);
    });

    await t.step("a side-loaded book is kept against its hash, not dropped", () => {
      // On the reader, never sent by us, so there is no book to attach it to —
      // and the reader cannot tell that from page sync being broken.
      const payload = { document: "sideloaded", progress: "/body/p[9]", percentage: 0.31 };
      assertEquals(reading.record(payload, "stu", null).bookId, null);
      reading.recordUnmapped(payload, "stu", null);
      assertEquals(reading.unmapped("stu", "sideloaded")!.percentage, 0.31);
      // Same rule as everything else here: it belongs to the person who
      // authenticated, not to whoever else holds the same file.
      assertEquals(reading.unmapped("sarah", "sideloaded"), undefined);
      // And it stays out of the library — there is no book to show it on.
      assertEquals(
        db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reading_state WHERE user_id = 'stu'")!.n,
        1,
      );
      reading.forgetUser("stu");
      assertEquals(reading.unmapped("stu", "sideloaded"), undefined);
      // Put the position back for the steps that follow.
      reading.record({ document: "doc-hash", percentage: 1 }, "stu", "device-1");
      reading.setFinished("stu", BOOK, false);
    });

    await t.step("a position stored before the round-trip still reads back", () => {
      // Old rows hold the bare `position` object; they must not be mistaken for
      // a full report with everything missing.
      db.run(
        "UPDATE reading_state SET position_json = ? WHERE user_id = 'stu' AND book_id = ?",
        JSON.stringify({ xpath: "/body/p[2]" }),
        BOOK,
      );
      const stored = storedReport(reading.get("stu", BOOK)!.position_json);
      assertEquals(stored.progress, undefined);
      assertEquals(stored.position?.xpath, "/body/p[2]");
    });
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

// --- index reconciliation ---------------------------------------------------

import { ConfigStore } from "../src/core/config.ts";
import { Paths } from "../src/core/paths.ts";
import { Books } from "../src/library/books.ts";
import { Scanner } from "../src/library/scanner.ts";
import { Imports } from "../src/library/imports.ts";
import type { Ingest } from "../src/library/ingest.ts";

Deno.test("reconcile drops what belongs to folders that are no longer watched", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const paths = new Paths(dir);
    paths.ensure();
    const config = ConfigStore.load(paths);
    config.update({
      libraries: [{ id: "keep", name: "Keep", path: `${dir}/keep`, deviceIds: [] }],
    });

    const db = new Db(paths.db);
    const books = new Books(db, paths);
    const noop = () => {};
    const log = { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
    const scanner = new Scanner(
      db,
      config,
      books,
      paths,
      {} as unknown as Ingest,
      {} as unknown as Imports,
      log,
      { emit: noop } as unknown as EventBus,
    );

    const now = new Date().toISOString();
    for (const [lib, book] of [["keep", "k"], ["gone", "g"], ["gone", "h"]]) {
      const id = book.repeat(32);
      db.run(
        "INSERT OR IGNORE INTO book (id, title, author, added_at, original_ext, epub_path) VALUES (?, ?, '', ?, 'epub', ?)",
        id,
        `Book ${book}`,
        now,
        `${paths.bookDir(id)}/book.epub`,
      );
      db.run(
        "INSERT INTO library_book (library_id, book_id, path, added_at) VALUES (?, ?, ?, ?)",
        lib,
        id,
        `/tmp/${lib}/${book}.epub`,
        now,
      );
      db.run(
        "INSERT INTO file_index (path, library_id, size, mtime, md5, seen_at) VALUES (?, ?, 1, 1, ?, ?)",
        `/tmp/${lib}/${book}.epub`,
        lib,
        id,
        now,
      );
    }
    // A job left mid-flight by a killed process, and its on-disk artifacts.
    db.run(
      "INSERT INTO import_job (id, library_id, path, filename, stage, state, created_at, updated_at) VALUES ('j1', 'keep', '/tmp/keep/x.epub', 'x.epub', 'converting', 'running', ?, ?)",
      now,
      now,
    );
    await Deno.mkdir(paths.bookDir("g".repeat(32)), { recursive: true });

    const result = scanner.reconcile();

    // 2 library_book + 2 file_index rows for "gone".
    assertEquals(result.orphanRows, 4);
    assertEquals(result.staleJobs, 1);
    assertEquals(result.purgedBooks, 2, "books no folder holds are purged");

    assertEquals(books.list().length, 1, "only the kept folder's book survives");
    assertEquals(books.list()[0].library_id, "keep");
    assertEquals(
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM import_job")!.n,
      0,
      "the interrupted job is gone so the file is retried",
    );
    // Derived artifacts for a purged book are removed from disk.
    await assertRejects(() => Deno.stat(paths.bookDir("g".repeat(32))));

    // An artifact folder whose row vanished by some other route is swept too —
    // nothing else will ever look at it.
    const stray = paths.bookDir("f".repeat(32));
    await Deno.mkdir(stray, { recursive: true });
    await Deno.writeTextFile(`${stray}/book.epub`, "junk");
    assertEquals(scanner.reconcile().orphanDirs, 1);
    await assertRejects(() => Deno.stat(stray));
    // The surviving book's artifacts are left alone.
    assertEquals(books.list().length, 1);

    db.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("reconcile keeps books that are still on a device", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const paths = new Paths(dir);
    paths.ensure();
    const config = ConfigStore.load(paths);
    config.update({ libraries: [] });

    const db = new Db(paths.db);
    const books = new Books(db, paths);
    const noop = () => {};
    const scanner = new Scanner(
      db,
      config,
      books,
      paths,
      {} as unknown as Ingest,
      {} as unknown as Imports,
      { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger,
      { emit: noop } as unknown as EventBus,
    );

    const now = new Date().toISOString();
    const id = "d".repeat(32);
    db.run(
      "INSERT INTO book (id, title, author, added_at, original_ext) VALUES (?, 'On Device', '', ?, 'epub')",
      id,
      now,
    );
    db.run(
      "INSERT INTO device (id, first_seen, last_seen) VALUES ('dev-1', ?, ?)",
      now,
      now,
    );
    db.run(
      "INSERT INTO device_content (device_id, book_id, device_filename, device_path, synced_at) VALUES ('dev-1', ?, 'x.epub', '/x.epub', ?)",
      id,
      now,
    );

    assertEquals(scanner.reconcile().purgedBooks, 0);
    assertEquals(
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM book")!.n,
      1,
      "a book still on a reader keeps its manifest entry and artifacts",
    );
    db.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- one book, several formats ----------------------------------------------

import { groupEditions } from "../src/library/scanner.ts";
import { basenameOf, editionKey, extOf, formatRank, ImportBlocked } from "../src/library/ingest.ts";
import type { Book } from "../src/library/books.ts";

function seenFiles(...paths: string[]) {
  return paths.map((path) => ({ path, size: path.length, mtime: 0 }));
}

Deno.test("editions: the same title in two formats is one book", () => {
  // Calibre keeps every format of a book side by side in its folder.
  const [group, ...rest] = groupEditions(seenFiles(
    "/lib/Frank Herbert/Dune (3)/Dune - Frank Herbert.mobi",
    "/lib/Frank Herbert/Dune (3)/Dune - Frank Herbert.epub",
  ));
  assertEquals(rest.length, 0, "one book, not two");
  assertEquals(group.map((f) => extOf(f.path)), ["epub", "mobi"], "best format first");

  // A library split into per-format trees is the same book too — which is why
  // the key ignores the directory.
  assertEquals(groupEditions(seenFiles("/lib/epub/Dune.epub", "/lib/mobi/Dune.mobi")).length, 1);

  // Case and separators differ between the copies more often than not.
  assertEquals(editionKey("/a/The_Hobbit.epub"), editionKey("/b/the hobbit.MOBI"));

  // Two *editions* of one title are a real thing and are told apart by format,
  // not by name: same rank, so neither supersedes the other.
  const editions = groupEditions(seenFiles("/lib/A (1)/Dune.epub", "/lib/A (7)/Dune.epub"));
  assertEquals(editions.length, 1);
  assertEquals(editions[0].map((f) => formatRank(extOf(f.path))), [0, 0]);

  // Ties break on path so a rescan makes the same choice every time — otherwise
  // the book on the reader churns between two files.
  assertEquals(editions[0][0].path, "/lib/A (1)/Dune.epub");

  // A different book keeps to itself.
  assertEquals(groupEditions(seenFiles("/lib/Dune.epub", "/lib/Emma.epub")).length, 2);

  // EPUB needs no conversion at all; PDF converts worst; a fulfilment token is
  // not a book and only stands when nothing else carries the title.
  assert(formatRank("epub") < formatRank("mobi"));
  assert(formatRank("mobi") < formatRank("pdf"));
  assert(formatRank("pdf") < formatRank("acsm"));
});

/** Enough of `Ingest` for the scanner: records what it was asked to import. */
function fakeIngest(db: Db, books: Books, blocked: (path: string) => boolean = () => false) {
  const imported: string[] = [];
  const ingest = {
    imported,
    // deno-lint-ignore require-await
    async addFromPath(libraryId: string, sourcePath: string, md5: string): Promise<Book> {
      if (blocked(sourcePath)) throw new ImportBlocked("drm-key", "no key for this one");
      imported.push(basenameOf(sourcePath));
      db.run(
        `INSERT OR IGNORE INTO book (id, title, author, added_at, original_ext, epub_path)
         VALUES (?, ?, '', ?, ?, ?)`,
        md5,
        basenameOf(sourcePath),
        new Date().toISOString(),
        extOf(sourcePath),
        `${sourcePath}.epub`,
      );
      books.addToLibrary(libraryId, md5, sourcePath);
      return books.get(md5)!;
    },
  };
  return ingest;
}

async function scanFixture(dir: string, blocked?: (path: string) => boolean) {
  const paths = new Paths(dir);
  paths.ensure();
  const config = ConfigStore.load(paths);
  await Deno.mkdir(`${dir}/books`, { recursive: true });
  config.update({
    // No settle window: the fixture's files were written a moment ago.
    scan: { ...config.current.scan, settleSec: 0 },
    libraries: [{ id: "lib", name: "Books", path: `${dir}/books`, deviceIds: [] }],
  });
  const db = new Db(paths.db);
  const books = new Books(db, paths);
  const ingest = fakeIngest(db, books, blocked);
  const noop = () => {};
  const scanner = new Scanner(
    db,
    config,
    books,
    paths,
    ingest as unknown as Ingest,
    new Imports(db),
    { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger,
    { emit: noop } as unknown as EventBus,
  );
  return { db, books, ingest, scanner, folder: `${dir}/books` };
}

Deno.test("scan: only the best format of a book is imported", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { db, books, ingest, scanner, folder } = await scanFixture(dir);

    // The MOBI arrives first and is a book like any other.
    await Deno.writeTextFile(`${folder}/Dune - Frank Herbert.mobi`, "mobi bytes");
    await scanner.scan("lib");
    assertEquals(ingest.imported, ["Dune - Frank Herbert.mobi"]);
    assertEquals(books.list().length, 1);

    // Then the EPUB of the same book turns up. It supersedes the MOBI, which is
    // never converted and does not stay in the library as a second copy.
    await Deno.writeTextFile(`${folder}/Dune - Frank Herbert.epub`, "epub bytes");
    const result = await scanner.scan("lib");
    assertEquals(ingest.imported, [
      "Dune - Frank Herbert.mobi",
      "Dune - Frank Herbert.epub",
    ]);
    assertEquals(result.found, 2, "both files are on disk");
    assertEquals(books.list().length, 1, "but only one book");
    assertEquals(books.list()[0].original_ext, "epub");
    assertEquals(
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM file_index")!.n,
      1,
      "the superseded file's index row is reaped",
    );

    // A rescan is stable: nothing is imported again, nothing flaps back.
    await scanner.scan("lib");
    assertEquals(ingest.imported.length, 2);
    assertEquals(books.list().length, 1);
    assertEquals(books.list()[0].original_ext, "epub");

    // Delete the EPUB and the MOBI is a book again rather than a hole.
    await Deno.remove(`${folder}/Dune - Frank Herbert.epub`);
    await scanner.scan("lib");
    assertEquals(books.list().length, 1);
    assertEquals(books.list()[0].original_ext, "mobi");

    db.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scan: a format that cannot be imported falls through to the next", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // The EPUB is the better format but is DRM-protected and waits in the
    // Inbox. Superseding on that basis would cost the book entirely.
    const { db, books, ingest, scanner, folder } = await scanFixture(
      dir,
      (path) => path.endsWith(".epub"),
    );
    await Deno.writeTextFile(`${folder}/Dune.epub`, "locked");
    await Deno.writeTextFile(`${folder}/Dune.mobi`, "readable");

    await scanner.scan("lib");
    assertEquals(ingest.imported, ["Dune.mobi"]);
    assertEquals(books.list().length, 1);
    assertEquals(
      db.get<{ state: string }>("SELECT state FROM import_job WHERE path LIKE '%.epub'")!.state,
      "blocked",
      "the EPUB is still in the Inbox, so unlocking it is worth doing",
    );

    db.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- library root confinement -----------------------------------------------

import {
  commonAncestor,
  isInside,
  normalizePath,
  relativeToRoot,
  resolveUnderRoot,
} from "../src/core/roots.ts";

Deno.test("roots: paths normalize and containment is not prefix-fooled", () => {
  assertEquals(normalizePath("/a/b/"), "/a/b");
  assertEquals(normalizePath("/a//b"), "/a/b");
  assertEquals(normalizePath("/"), "/");

  assert(isInside("/a/b", "/a/b"));
  assert(isInside("/a/b", "/a/b/c"));
  // "/a/bc" must not count as inside "/a/b" just because the string starts with it.
  assert(!isInside("/a/b", "/a/bc"));
  assert(!isInside("/a/b", "/a"));
});

Deno.test("roots: nothing outside the root can be addressed", async () => {
  const base = await Deno.makeTempDir();
  try {
    const root = `${base}/books`;
    const outside = `${base}/secrets`;
    await Deno.mkdir(`${root}/scifi`, { recursive: true });
    await Deno.mkdir(outside, { recursive: true });

    // The ordinary case.
    const ok = await resolveUnderRoot(root, "scifi");
    assertEquals(ok.path, await Deno.realPath(`${root}/scifi`));
    assertEquals((await resolveUnderRoot(root, "")).path, await Deno.realPath(root));

    // Traversal, absolute paths, and a symlink out of the root all refused.
    for (const attempt of ["../secrets", "scifi/../../secrets", "/etc", "scifi/../.."]) {
      const r = await resolveUnderRoot(root, attempt);
      assertEquals(r.path, undefined, `"${attempt}" must be refused`);
      assert(r.error, `"${attempt}" must explain itself`);
    }

    await Deno.symlink(outside, `${root}/escape`);
    const viaLink = await resolveUnderRoot(root, "escape");
    assertEquals(viaLink.path, undefined, "a symlink out of the root must be refused");
    assertMatch(viaLink.error!, /outside the library root/);

    // A symlink that stays inside is fine.
    await Deno.symlink(`${root}/scifi`, `${root}/inside-link`);
    assertEquals(
      (await resolveUnderRoot(root, "inside-link")).path,
      await Deno.realPath(`${root}/scifi`),
    );

    assertEquals((await resolveUnderRoot("", "scifi")).path, undefined);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("roots: relative display and inferred root for existing folders", () => {
  assertEquals(relativeToRoot("/books", "/books/scifi/x"), "scifi/x");
  assertEquals(relativeToRoot("/books", "/books"), "");
  assertEquals(relativeToRoot("/books", "/elsewhere"), "/elsewhere");

  // One existing folder infers its parent, so siblings can be added later.
  assertEquals(commonAncestor(["/Users/s/Dropbox/Books/Vonnegut"]), "/Users/s/Dropbox/Books");
  assertEquals(commonAncestor(["/Users/s/Books/A", "/Users/s/Books/B"]), "/Users/s/Books");
  // Nothing sensible spans these, so don't guess.
  assertEquals(commonAncestor(["/Users/s/Books/A", "/Volumes/Ext/B"]), null);
});

Deno.test("roots: a case-differing root still resolves its own children", async () => {
  const base = await Deno.makeTempDir();
  try {
    // The folder on disk is lowercase; the caller supplies a different case, as
    // a case-insensitive filesystem happily allows.
    await Deno.mkdir(`${base}/shared book folders/ender wiggin`, { recursive: true });
    const miscased = `${base}/Shared Book Folders`;

    let works = false;
    try {
      await Deno.stat(miscased);
      works = true;
    } catch { /* case-sensitive filesystem: nothing to test */ }
    if (!works) return;

    const r = await resolveUnderRoot(miscased, "ender wiggin");
    assertEquals(r.error, undefined, "a child must not look like it escapes its own root");
    assert(r.path, "the child should resolve");
    assert(r.root, "the resolved root must come back for relative computation");

    // Relative paths must be computed against the resolved root, not the
    // miscased one, or they come out absolute and get rejected downstream.
    assertEquals(relativeToRoot(r.root!, r.path!), "ender wiggin");
    assertMatch(relativeToRoot(miscased, r.path!), /^\//, "the old bug: an absolute path");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

// --- pointing the reader at our sync server ---------------------------------

import { isLocalUrl } from "../src/core/net.ts";
import { LOCAL_SYNC_SERVER_ID } from "../src/core/config.ts";
import { KosyncServer } from "../src/sync/kosync.ts";
import type { DeviceManager } from "../src/device/manager.ts";

Deno.test("kosync: a reader is only configured once all three values are known", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const paths = new Paths(dir);
    paths.ensure();
    const config = ConfigStore.load(paths);
    config.update({ users: [{ id: "u1", name: "Ada" }] });
    const db = new Db(paths.db);
    const noop = () => {};
    const kosync = new KosyncServer(
      db,
      {} as unknown as Reading,
      {} as unknown as DeviceManager,
      config,
      { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger,
    );

    // Nobody holding the reader means no credentials to give it — the reader
    // must be left alone rather than handed somebody else's.
    const nobody = kosync.readerSettings(null);
    assertEquals(nobody.ok, false);
    assert(!nobody.ok && /holding/.test(nobody.reason), nobody.ok ? "" : nobody.reason);

    const stranger = kosync.readerSettings("u2");
    assert(!stranger.ok, "a user who no longer exists must not resolve to credentials");

    const got = kosync.readerSettings("u1");
    if (got.ok) {
      const creds = kosync.credentials("u1");
      assertEquals(got.settings.koUsername, creds.username);
      assertEquals(got.settings.koPassword, creds.password);
      // Binary: the reader hashes the file it holds, which is what
      // kosync_document records at delivery. Filename matching would not.
      assertEquals(got.settings.koMatchMethod, 1);
      assertMatch(got.settings.koServerUrl, /^http:\/\/[^/]+:8788$/);
      assert(
        !/127\.0\.0\.1/.test(got.settings.koServerUrl),
        "loopback is unreachable from a reader",
      );
    } else {
      // The only legitimate refusal on a machine with no usable interface.
      assertMatch(got.reason, /LAN address/);
    }

    config.update({ kosync: { ...config.current.kosync, enabled: false } });
    const off = kosync.readerSettings("u1");
    assert(!off.ok && /turned off/.test(off.reason), "the switch has to be honoured");

    db.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("net: a sync server on this machine is not somebody else's", () => {
  assert(isLocalUrl("http://127.0.0.1:8788"));
  assert(!isLocalUrl("https://sync.koreader.rocks"));
  assert(!isLocalUrl("not a url"));
});

/**
 * A person has a list of sync servers, ours first, with one of them the default
 * their readers follow. Everything here is about that list staying coherent —
 * ours cannot be lost, a deleted server cannot strand a reader, and adopting one
 * off a reader is idempotent.
 */
Deno.test("kosync: sync servers are per person, ours first", async (t) => {
  const dir = await Deno.makeTempDir();
  const paths = new Paths(dir);
  paths.ensure();
  const config = ConfigStore.load(paths);
  config.update({ users: [{ id: "u1", name: "Ada" }, { id: "u2", name: "Bo" }] });
  const db = new Db(paths.db);
  const noop = () => {};
  const kosync = new KosyncServer(
    db,
    {} as unknown as Reading,
    {} as unknown as DeviceManager,
    config,
    { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger,
  );

  await t.step("ours is always present and always the default to begin with", () => {
    const list = kosync.servers("u1");
    assertEquals(list.length, 1);
    assertEquals(list[0].id, LOCAL_SYNC_SERVER_ID);
    assert(list[0].builtin, "ours must be marked built-in so the UI cannot offer to delete it");
    assertEquals(kosync.defaultServer("u1")?.id, LOCAL_SYNC_SERVER_ID);
  });

  await t.step("ours carries this person's own credentials", () => {
    const creds = kosync.credentials("u1");
    assertEquals(kosync.servers("u1")[0].username, creds.username);
    assertNotEquals(kosync.credentials("u2").username, creds.username);
  });

  let added: string;
  await t.step("a server is added, and re-adding the same URL updates it in place", () => {
    const first = kosync.addServer("u1", {
      url: "https://sync.example.org/",
      username: "ada",
      password: "pw1",
    });
    assert(!("error" in first), "a valid server must be accepted");
    added = first.id;
    // No name given, so the host stands in for one.
    assertEquals(first.name, "sync.example.org");
    // The trailing slash is not a second server, and neither is a case change.
    const again = kosync.addServer("u1", {
      url: "https://SYNC.example.org",
      username: "ada",
      password: "pw2",
    });
    assert(!("error" in again));
    assertEquals(again.id, added, "the same URL must not produce a second entry");
    assertEquals(again.password, "pw2", "new credentials under a known URL must win");
    assertEquals(kosync.servers("u1").length, 2);
  });

  await t.step("one person's servers are not another's", () => {
    assertEquals(kosync.servers("u2").length, 1);
    assertEquals(kosync.server("u2", added), undefined);
  });

  await t.step("garbage and our own address are refused", () => {
    assert("error" in kosync.addServer("u1", { url: "not a url", username: "", password: "" }));
    assert("error" in kosync.addServer("u1", { url: "", username: "", password: "" }));
    const ours = kosync.servers("u1")[0].url;
    if (ours) {
      const dupe = kosync.addServer("u1", { url: ours, username: "x", password: "y" });
      assert("error" in dupe, "our own server must not be addable as a second entry");
    }
  });

  await t.step("the default is switchable and readerSettings follows it", () => {
    assertEquals(kosync.setDefaultServer("u1", added), { ok: true });
    assertEquals(kosync.defaultServer("u1")?.id, added);
    const got = kosync.readerSettings("u1");
    assert(got.ok, got.ok ? "" : got.reason);
    assertEquals(got.settings.koServerUrl, "https://sync.example.org");
    assertEquals(got.settings.koUsername, "ada");
    // Binary matching regardless of whose server it is — the reader hashes the
    // file it holds either way.
    assertEquals(got.settings.koMatchMethod, 1);
  });

  await t.step("a server override beats the holder's default", () => {
    const pinned = kosync.readerSettings("u1", LOCAL_SYNC_SERVER_ID);
    // Ours may be unavailable on a machine with no LAN address; either way it
    // must not silently resolve to the *other* server.
    if (pinned.ok) assertEquals(pinned.server.id, LOCAL_SYNC_SERVER_ID);
    else assertMatch(pinned.reason, /LAN address|turned off/);
  });

  await t.step("an unknown override falls back to the default rather than failing", () => {
    const got = kosync.readerSettings("u1", "deleted-while-offline");
    assert(got.ok, got.ok ? "" : got.reason);
    assertEquals(got.server.id, added);
  });

  await t.step("removing the default falls back to ours, and clears its readers' overrides", () => {
    const now = new Date().toISOString();
    db.run("INSERT INTO device (id, first_seen, last_seen) VALUES ('dev1', ?, ?)", now, now);
    db.run(
      "INSERT INTO device_settings (device_id, user_id, sync_server_id) VALUES ('dev1', 'u1', ?)",
      added,
    );
    assertEquals(kosync.removeServer("u1", added), { ok: true });
    assertEquals(kosync.servers("u1").length, 1);
    assertEquals(kosync.defaultServer("u1")?.id, LOCAL_SYNC_SERVER_ID);
    assertEquals(
      db.get<{ sync_server_id: string | null }>(
        "SELECT sync_server_id FROM device_settings WHERE device_id = 'dev1'",
      )?.sync_server_id,
      null,
      "a reader pinned to a deleted server must fall back, not point at nothing",
    );
  });

  await t.step("ours cannot be removed or edited — it is a Settings switch", () => {
    assert("error" in kosync.removeServer("u1", LOCAL_SYNC_SERVER_ID));
    assert("error" in kosync.updateServer("u1", LOCAL_SYNC_SERVER_ID, { name: "Mine" }));
    assertEquals(kosync.servers("u1").length, 1);
  });

  await t.step("turning our server off does not empty anyone's list", () => {
    const other = kosync.addServer("u2", {
      url: "https://sync.example.net",
      username: "bo",
      password: "pw",
    });
    assert(!("error" in other));
    kosync.setDefaultServer("u2", other.id);
    config.update({ kosync: { ...config.current.kosync, enabled: false } });

    // Ada follows ours, which is now off — she gets told why.
    const ada = kosync.readerSettings("u1");
    assert(!ada.ok && /turned off/.test(ada.reason), "the switch has to be honoured");
    assertEquals(kosync.servers("u1").length, 1, "ours stays listed so the reason can be shown");
    assert(!kosync.servers("u1")[0].available);

    // Bo's reader points at somebody else's server, so ours being off is
    // irrelevant to it.
    const bo = kosync.readerSettings("u2");
    assert(bo.ok, bo.ok ? "" : bo.reason);
    assertEquals(bo.settings.koServerUrl, "https://sync.example.net");
  });

  db.close();
  await Deno.remove(dir, { recursive: true });
});

import { flattenSettings } from "../src/device/client.ts";
import { asciiFilename, esc, safeSegments } from "../src/web/opds.ts";

Deno.test("device: /api/settings is read as descriptors, not a flat object", () => {
  // Firmware 1.4.0-tiny answers the read with an array of descriptors while the
  // write takes a flat partial object. Reading a field straight off the array
  // yields undefined for every key, which made a successful write report as a
  // failure — and, because a failed result stores no fingerprint, re-push the
  // same settings on every sync forever.
  const real = [
    {
      key: "koUsername",
      name: "KOReader Username",
      category: "KOReader Sync",
      type: "string",
      value: "ada",
    },
    {
      key: "koServerUrl",
      name: "Sync Server URL",
      category: "KOReader Sync",
      type: "string",
      value: "http://10.0.1.9:8788",
    },
    {
      key: "koMatchMethod",
      name: "Document Matching",
      category: "KOReader Sync",
      type: "enum",
      value: 1,
      options: ["Filename", "Binary"],
    },
  ];
  assertEquals(flattenSettings(real), {
    koUsername: "ada",
    koServerUrl: "http://10.0.1.9:8788",
    koMatchMethod: 1,
  });

  // The flat shape older notes recorded still has to work.
  assertEquals(flattenSettings({ koServerUrl: "http://x" }), { koServerUrl: "http://x" });

  // A reader that will not answer at all is a normal state, not an error.
  assertEquals(flattenSettings(null), null);
  assertEquals(flattenSettings("nope"), null);

  // Junk rows are skipped rather than poisoning the map with an "undefined" key.
  assertEquals(flattenSettings([{ nope: 1 }, { key: "deviceName", value: "" }]), {
    deviceName: "",
  });
});

Deno.test("opds: a browsed folder path is reduced to plain names", () => {
  assertEquals(safeSegments("Sci-Fi/Classics"), ["Sci-Fi", "Classics"]);
  assertEquals(safeSegments(""), []);
  // Nothing here opens a file, but a path that cannot exist should land on the
  // parent rather than on something surprising.
  assertEquals(safeSegments("../../etc"), ["etc"]);
  assertEquals(safeSegments("/a//b/./c/"), ["a", "b", "c"]);
  assertEquals(safeSegments("a\\b"), ["a", "b"]);
});

Deno.test("opds: feed text is XML-escaped, and download names are header-safe", () => {
  // A title with a bare ampersand is not a cosmetic problem: the client refuses
  // to parse the feed at all.
  assertEquals(
    esc(`Tom & Jerry's <b>"Guide"</b>`),
    "Tom &amp; Jerry&apos;s &lt;b&gt;&quot;Guide&quot;&lt;/b&gt;",
  );

  // Content-Disposition is header-encoded, so the name is reduced to ASCII and
  // stripped of the quotes and backslashes that would break out of it.
  const name = asciiFilename({
    id: "d41d8cd98f00b204e9800998ecf8427e",
    title: `Émile’s "Guide"`,
    author: "Ada\\Lovelace",
  });
  assertMatch(name, /^[\x20-\x7e]+\.epub$/);
  assert(!name.includes('"') && !name.includes("\\"), name);

  // A title with nothing ASCII in it still has to produce a filename.
  assertEquals(
    asciiFilename({ id: "abc123", title: "日本語", author: "著者" }),
    "abc123.epub",
  );
});

// --- the shelf's groupings --------------------------------------------------
//
// `grouping.ts` is deliberately free of preact imports so it can be tested here.
// It is pure: rows in, headed sections out.

const shelfBook = (
  over: Partial<LibraryBook> & { id: string },
): LibraryBook => ({
  title: "Untitled",
  author: "Anon",
  series: null,
  series_index: null,
  added_at: "2026-01-01T00:00:00.000Z",
  cover_path: null,
  original_ext: "epub",
  epub_path: null,
  size_bytes: 0,
  meta_json: "{}",
  library_id: "fiction",
  path: "/books/x.epub",
  percentage: 0,
  finished: 0,
  hasCover: false,
  onDevices: [],
  pinnedTo: [],
  ...over,
});

const folder = (id: string, name: string): UiLibrary => ({
  id,
  name,
  path: `/books/${id}`,
  relPath: id,
  deviceIds: [],
  books: 0,
});

Deno.test("shelf: folders keep their headers, and orphans get their own", () => {
  const folders = [folder("fiction", "Fiction"), folder("comics", "Comics")];
  const groups = groupsFor(
    [
      shelfBook({ id: "a", title: "Dune", library_id: "fiction" }),
      // On the reader, but its file has left every watched folder. A sync never
      // removes these, so the shelf must not silently drop them either.
      shelfBook({ id: "b", title: "Ghost", library_id: null, path: null }),
    ],
    folders,
    "folder",
  );

  assertEquals(groups.map((g) => g.label), ["Fiction", "Comics", "Not in a watched folder"]);
  // An empty folder you have just started watching must not look like it failed.
  assertEquals(groups[1].books.length, 0);
  assertEquals(groups[2].books.map((b) => b.id), ["b"]);
  // Only real folders take a drop; "Not in a watched folder" is not a place.
  assertEquals(groups.map((g) => g.dropTo), ["fiction", "comics", undefined]);
});

Deno.test("shelf: series read in order, and standalones do not become sections", () => {
  const groups = groupsFor(
    [
      shelfBook({ id: "c", title: "Third", series: "Earthsea", series_index: 3 }),
      shelfBook({ id: "a", title: "First", series: "Earthsea", series_index: 1 }),
      shelfBook({ id: "x", title: "Piranesi" }),
      shelfBook({ id: "y", title: "Maus" }),
    ],
    [],
    "series",
  );

  assertEquals(groups.map((g) => g.label), ["Earthsea", "Standalone"]);
  // The one grouping where order *inside* a section carries meaning.
  assertEquals(groups[0].books.map((b) => b.title), ["First", "Third"]);
  // Most of a library is standalone, and a hundred one-book sections is not a
  // shelf — so they land in one group, closed until asked for.
  assertEquals(groups[1].books.length, 2);
  assertEquals(groups[1].closedByDefault, true);
});

Deno.test("shelf: authors sort, and a missing one is still a group", () => {
  const groups = groupsFor(
    [
      shelfBook({ id: "b", author: "Ursula K. Le Guin" }),
      shelfBook({ id: "a", author: "Ada Lovelace" }),
      shelfBook({ id: "c", author: "" }),
    ],
    [],
    "author",
  );
  assertEquals(groups.map((g) => g.label), ["Ada Lovelace", "Unknown author", "Ursula K. Le Guin"]);
});

Deno.test("shelf: recency buckets, and a book cannot fall out of all of them", () => {
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000 - 60_000).toISOString();

  const groups = groupsFor(
    [
      shelfBook({ id: "old", added_at: ago(90) }),
      shelfBook({ id: "new", added_at: ago(0) }),
      shelfBook({ id: "week", added_at: ago(3) }),
      // A bad mtime or a clock skew must not vanish a book.
      shelfBook({ id: "broken", added_at: "not a date" }),
    ],
    [],
    "recent",
  );

  assertEquals(groups.map((g) => g.label), ["Today", "This week", "Earlier"]);
  assertEquals(groups[0].books.map((b) => b.id), ["new"]);
  assertEquals(groups[1].books.map((b) => b.id), ["week"]);
  assertEquals(new Set(groups[2].books.map((b) => b.id)), new Set(["old", "broken"]));
});
