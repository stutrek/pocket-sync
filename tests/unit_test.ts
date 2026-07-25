import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";

import {
  bookIdFromDeviceFilename,
  deviceFilename,
  newId,
  sanitizeForFilename,
  shortHash,
} from "../src/core/ids.ts";
import { joinDevicePath, normalizeDevicePath } from "../src/device/client.ts";
import { stableIdentity } from "../src/device/manager.ts";
import { metadataFromFilename, parseMetaOutput } from "../src/library/calibre.ts";
import { profileHash, type ResampleProfile } from "../src/sync/profiles.ts";

Deno.test("ids: newId is sortable and unique", () => {
  const early = newId(1_000_000);
  const late = newId(2_000_000);
  assert(early < late, `${early} should sort before ${late}`);
  assertEquals(new Set(Array.from({ length: 500 }, () => newId())).size, 500);
  assertMatch(newId(), /^[0-9a-z]{16}$/);
});

Deno.test("ids: device filenames round-trip and stay firmware-safe", () => {
  const id = newId();
  const name = deviceFilename(id, "Émile’s Guide to Ünicode: Part 2/3");
  assertEquals(bookIdFromDeviceFilename(name), id);
  assertMatch(name, /^[0-9a-z]{16}__[A-Za-z0-9._-]+\.epub$/);
  assertEquals(bookIdFromDeviceFilename("some-other-book.epub"), null);
});

Deno.test("ids: sanitize keeps something usable", () => {
  assertEquals(sanitizeForFilename("  A  Tale   of Two  Cities "), "A_Tale_of_Two_Cities");
  assertEquals(sanitizeForFilename("###"), "book");
  assert(sanitizeForFilename("x".repeat(200)).length <= 60);
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
