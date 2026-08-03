export type ExcelLocationSource = {
  file_name?: string;
  range?: string;
  excel_range_is_absolute?: boolean;
};

const LEGACY_ROW_OFFSETS: Record<string, number> = {
  "260605 (검토) 251029_BB Summary No 3 4_의견반영.xlsx": 2,
};

export function displayExcelRange(source: ExcelLocationSource) {
  const range = source.range ?? "-";
  if (source.excel_range_is_absolute) return range;
  const offset = source.file_name ? LEGACY_ROW_OFFSETS[source.file_name] ?? 0 : 0;
  if (!offset) return range;
  return range.replace(/([A-Z]+)(\d+)/gi, (_, column: string, row: string) => (
    `${column}${Number(row) + offset}`
  ));
}
