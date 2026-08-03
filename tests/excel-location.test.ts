import assert from "node:assert/strict";
import test from "node:test";
import { displayExcelRange } from "../app/excel-location.ts";

test("corrects the legacy Bid Bulletin range by two worksheet rows", () => {
  assert.equal(displayExcelRange({
    file_name: "260605 (검토) 251029_BB Summary No 3 4_의견반영.xlsx",
    range: "A8:M8",
  }), "A10:M10");
});

test("does not offset newly indexed absolute worksheet ranges", () => {
  assert.equal(displayExcelRange({
    file_name: "260605 (검토) 251029_BB Summary No 3 4_의견반영.xlsx",
    range: "A10:M10",
    excel_range_is_absolute: true,
  }), "A10:M10");
});
