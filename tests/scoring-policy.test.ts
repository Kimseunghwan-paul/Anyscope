import assert from "node:assert/strict";
import test from "node:test";
import { applyPdfContextScopes, isSentenceQuery, scoreRecord } from "../app/page";

function record(title: string, body: string, section = "PDF Page 1") {
  return {
    id: "test-record",
    document_id: "test-document",
    document_type: "Local Standard",
    file_name: "test.pdf",
    source_kind: "pdf" as const,
    page: 1,
    section,
    title,
    body,
    text_available: true,
    ocr_status: "not_needed" as const,
  };
}

test("caps references and table-of-contents records at 18", () => {
  const references = scoreRecord(record(
    "References",
    "Liquefaction susceptibility criteria. ASTM D6066. Liquefaction assessment reference, 2024 edition.",
  ), "liquefaction susceptibility criteria");
  const contents = scoreRecord(record(
    "Table of Contents",
    "5.1 Geotextile requirements ................................ 42",
  ), "geotextile requirements");
  assert.ok(references && references.score <= 18);
  assert.ok(contents && contents.score <= 18);
});

test("keeps a single unqualified keyword occurrence in the low range", () => {
  const weak = scoreRecord(record(
    "General Information",
    "Liquefaction is discussed in the project.",
  ), "liquefaction");
  assert.ok(weak && weak.score <= 29);
});

test("supports explicit OR search without weakening the default AND search", () => {
  const source = record(
    "Settlement Monitoring",
    "Settlement monitoring shall continue at the specified interval.",
  );
  assert.equal(scoreRecord(source, "settlement concrete"), null);
  assert.ok(scoreRecord(source, "settlement concrete", "or"));
});

test("automatically analyzes English and Korean sentence queries independently of AND/OR", () => {
  const source = record(
    "Concrete Strength Testing",
    "The Contractor shall perform concrete strength testing before structural concrete is accepted.",
  );
  const english = "When should the contractor perform concrete strength testing?";
  const korean = "콘크리트 강도 시험은 언제 실시해야 하나요?";
  assert.equal(isSentenceQuery(english), true);
  assert.equal(isSentenceQuery(korean), true);
  assert.ok(scoreRecord(source, english, "and"));
  assert.ok(scoreRecord(source, english, "or"));
  assert.ok(scoreRecord(source, korean, "and"));
  assert.ok(scoreRecord(source, korean, "or"));
});

test("keeps OR result counts from shrinking when broader page matches become adjacent", () => {
  const pages = [
    { ...record("Testing Requirements", "Test Tests Testing shall be documented."), id: "p1", page: 1, page_count: 4 },
    { ...record("General", "A Test shall be documented."), id: "p2", page: 2, page_count: 4 },
    { ...record("General", "Testing shall be documented."), id: "p3", page: 3, page_count: 4 },
    { ...record("Testing Requirements", "Test Tests Testing shall be verified."), id: "p4", page: 4, page_count: 4 },
  ];
  const query = "Test Tests Testing";
  const andDirect = pages.map((page) => scoreRecord(page, query, "and")).filter((hit) => hit !== null);
  const orDirect = pages.map((page) => scoreRecord(page, query, "or")).filter((hit) => hit !== null);
  const andResults = applyPdfContextScopes(pages, andDirect, query, "and");
  const orResults = applyPdfContextScopes(pages, orDirect, query, "or");
  assert.ok(orResults.length >= andResults.length);
  assert.ok(orResults.length > andResults.length);
});

test("reserves high scores for a substantive clause with close requirements and details", () => {
  const strong = scoreRecord(record(
    "5.1.2.3 Liquefaction Susceptibility Criteria",
    "Liquefaction susceptibility criteria shall be evaluated for every soil layer. The liquefaction susceptibility criteria must use a minimum corrected SPT value of 15 and groundwater depth of 2 m. Liquefaction susceptibility criteria shall be verified by the Engineer.",
    "Clause 5.1.2.3",
  ), "liquefaction susceptibility criteria");
  assert.ok(strong && strong.score >= 85);
});

test("expands a matching ITEM heading through the page before the next ITEM", () => {
  const pages = [
    { ...record("Section VI: Works Requirements", "103.4 Basis of Payment ITEM 104 – EMBANKMENT Refer to the specification. 104.1 Description This Item shall consist of the construction of embankment."), id: "p124", page: 124, page_count: 128 },
    { ...record("Section VI: Works Requirements", "104.2 Material Requirements The selected materials shall comply with the specified grading."), id: "p125", page: 125, page_count: 128 },
    { ...record("Section VI: Works Requirements", "104.3 Construction Requirements The Contractor shall place and compact each layer."), id: "p126", page: 126, page_count: 128 },
    { ...record("Section VI: Works Requirements", "Compaction testing shall continue for the completed layer."), id: "p127", page: 127, page_count: 128 },
    { ...record("Section VI: Works Requirements", "ITEM 105 – SUBGRADE PREPARATION This Item shall cover preparation of the subgrade."), id: "p128", page: 128, page_count: 128 },
  ];
  const direct = pages.map((page) => scoreRecord(page, "embankment")).filter((hit) => hit !== null);
  const scoped = applyPdfContextScopes(pages, direct, "embankment");
  const item = scoped.find((hit) => hit.record.context_mode === "section");
  assert.ok(item);
  assert.equal(item.record.title, "ITEM 104 – EMBANKMENT");
  assert.deepEqual(item.record.context_pages, { from: 124, to: 127 });
  assert.ok(item.score >= 85);
});

test("merges consecutive body matches and includes one neighboring page on each side", () => {
  const pages = [
    { ...record("General Requirements", "Geotextile shall comply with ASTM D4751."), id: "p200", page: 200, page_count: 203 },
    { ...record("General Requirements", "Geotextile installation shall use a minimum overlap of 300 mm."), id: "p201", page: 201, page_count: 203 },
    { ...record("General Requirements", "Compaction shall continue above the completed layer."), id: "p202", page: 202, page_count: 203 },
  ];
  const direct = pages.map((page) => scoreRecord(page, "geotextile")).filter((hit) => hit !== null);
  const grouped = applyPdfContextScopes(pages, direct, "geotextile");
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].record.context_mode, "cluster");
  assert.deepEqual(grouped[0].record.context_pages, { from: 199, to: 202 });
});

test("does not treat VAT as a substring inside excavation", () => {
  const unrelated = scoreRecord(record(
    "Pay Item 103(2)a3 Bridge Structure Excavation",
    "Please confirm whether additional excavation quantities are applicable and whether the Contractor should account for the associated excavation costs.",
    "BB3!B38:N38",
  ), "부가가치세 포함 여부");
  assert.equal(unrelated, null);
});

test("searches Korean VAT wording and its precise English translation", () => {
  const korean = scoreRecord(record(
    "입찰금액 조건",
    "입찰금액에 부가가치세가 포함되어 있는지 확인하여야 합니다.",
  ), "부가가치세 포함 여부");
  const english = scoreRecord(record(
    "Bid Price",
    "The submitted bid price shall be inclusive of VAT.",
  ), "부가가치세 포함 여부");
  const excluded = scoreRecord(record(
    "Taxes",
    "The Contract Price is exclusive of value-added tax.",
  ), "부가가치세 포함 여부");
  assert.ok(korean);
  assert.ok(english);
  assert.ok(excluded);
});
