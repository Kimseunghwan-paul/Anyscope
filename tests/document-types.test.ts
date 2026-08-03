import assert from "node:assert/strict";
import test from "node:test";
import {
  createDocumentTypeId,
  descendantDocumentTypeIds,
  documentTypeDepth,
  documentTypeLabel,
  normalizeDocumentTypes,
  recommendDocumentType,
  resolveDocumentTypeId,
} from "../app/document-types.ts";

test("starts an empty workspace with a reusable uncategorized type", () => {
  const types = normalizeDocumentTypes(undefined);
  assert.deepEqual(types.map((type) => type.id), ["uncategorized"]);
});

test("always places uncategorized after user-defined types", () => {
  const types = normalizeDocumentTypes([
    { id: "uncategorized", name: "미분류", color: "slate", keywords: [], sort_order: 0 },
    { id: "bids", name: "입찰 도서", color: "orange", keywords: [], sort_order: 20 },
    { id: "risk", name: "Risk", color: "rose", keywords: [], sort_order: 10 },
  ]);
  assert.deepEqual(types.map((type) => type.id), ["risk", "bids", "uncategorized"]);
});

test("builds dynamic parent and child labels from stored type data", () => {
  const types = normalizeDocumentTypes([
    { id: "standards", name: "기술기준", color: "teal", keywords: ["standard"], sort_order: 10 },
    { id: "design", name: "설계", parent_id: "standards", color: "navy", keywords: ["design"], sort_order: 20 },
  ]);
  assert.equal(documentTypeLabel("design", types), "기술기준 / 설계");
});

test("allows the same child name under different parent types", () => {
  const types = normalizeDocumentTypes([
    { id: "international", name: "International Standard", color: "orange", keywords: [], sort_order: 10 },
    { id: "international-design", name: "Design", parent_id: "international", color: "navy", keywords: [], sort_order: 10 },
    { id: "local", name: "Local Standard", color: "teal", keywords: [], sort_order: 20 },
    { id: "local-design", name: "Design", parent_id: "local", color: "violet", keywords: [], sort_order: 10 },
  ]);
  assert.equal(types.filter((type) => type.name === "Design").length, 2);
  assert.equal(documentTypeLabel("international-design", types), "International Standard / Design");
  assert.equal(documentTypeLabel("local-design", types), "Local Standard / Design");
});

test("keeps children grouped with their parent while respecting sibling order", () => {
  const types = normalizeDocumentTypes([
    { id: "local", name: "Local Standard", color: "teal", keywords: [], sort_order: 20 },
    { id: "local-construction", name: "Construction", parent_id: "local", color: "violet", keywords: [], sort_order: 20 },
    { id: "international", name: "International Standard", color: "orange", keywords: [], sort_order: 10 },
    { id: "local-design", name: "Design", parent_id: "local", color: "navy", keywords: [], sort_order: 10 },
  ]);
  assert.deepEqual(types.map((type) => type.id), [
    "international",
    "local",
    "local-design",
    "local-construction",
    "uncategorized",
  ]);
});

test("supports a three-level hierarchy with full labels and recursive descendants", () => {
  const types = normalizeDocumentTypes([
    { id: "international", name: "International Standard", color: "orange", keywords: [], sort_order: 10 },
    { id: "design", name: "Design", parent_id: "international", color: "navy", keywords: [], sort_order: 10 },
    { id: "bridge", name: "Bridge", parent_id: "design", color: "teal", keywords: [], sort_order: 10 },
    { id: "construction", name: "Construction", parent_id: "international", color: "violet", keywords: [], sort_order: 20 },
  ]);
  assert.equal(documentTypeDepth("bridge", types), 3);
  assert.equal(documentTypeLabel("bridge", types), "International Standard / Design / Bridge");
  assert.deepEqual(descendantDocumentTypeIds("international", types), ["design", "bridge", "construction"]);
  assert.deepEqual(types.map((type) => type.id), [
    "international",
    "design",
    "bridge",
    "construction",
    "uncategorized",
  ]);
});

test("recommends a user-managed type from filename keywords", () => {
  const types = normalizeDocumentTypes([
    { id: "minutes", name: "회의록", color: "orange", keywords: ["meeting minutes", "회의록"], sort_order: 10 },
    { id: "risk", name: "위험관리대장", color: "rose", keywords: ["risk register", "hazard"], sort_order: 20 },
  ]);
  assert.equal(recommendDocumentType("Project Risk Register Rev.2.xlsx", types), "risk");
});

test("keeps legacy documents searchable without a migration", () => {
  const types = normalizeDocumentTypes(undefined, [{ type: "기존 보고서" }]);
  const legacy = types.find((type) => type.name === "기존 보고서");
  assert.ok(legacy);
  assert.equal(resolveDocumentTypeId({ document_type: "기존 보고서" }, types), legacy.id);
});

test("creates stable readable ids and avoids collisions", () => {
  assert.equal(createDocumentTypeId("Meeting Minutes", []), "type-meeting-minutes");
  assert.equal(createDocumentTypeId("Meeting Minutes", ["type-meeting-minutes"]), "type-meeting-minutes-2");
});
