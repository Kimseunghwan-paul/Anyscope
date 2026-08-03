import { loadPdfJs, PDFJS_DOCUMENT_OPTIONS } from "./pdfjs-config";

export type UploadSourceKind = "pdf" | "excel" | "word";

export type IndexedRecord = {
  id: string;
  document_id: string;
  document_type: string;
  document_type_id?: string;
  file_name: string;
  source_kind: UploadSourceKind;
  page?: number;
  page_count?: number;
  context_pages?: { from: number; to: number } | null;
  sheet?: string;
  range?: string;
  excel_range_is_absolute?: boolean;
  section?: string;
  title: string;
  body: string;
  text_available: boolean;
  ocr_status: "not_needed" | "pending" | "complete";
};

export type IndexedDocument = {
  id: string;
  display_name: string;
  type: string;
  type_id: string;
  source_kind: UploadSourceKind;
  page_count?: number;
  record_count: number;
  text_pages: number;
  ocr_pending_pages: number;
};

export type IndexProgress = (message: string) => void;

function documentId() {
  const random = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  return `document-${Date.now()}-${random}`;
}

function compact(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function titleFromText(text: string, fallback: string) {
  const title = text.split(/\r?\n/).map(compact).find((line) => line.length >= 3);
  return (title || fallback).slice(0, 180);
}

async function indexPdf(file: File, id: string, documentType: string, progress: IndexProgress) {
  const pdfjs = await loadPdfJs();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data: bytes, ...PDFJS_DOCUMENT_OPTIONS }).promise;
  const records: IndexedRecord[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    if (pageNumber === 1 || pageNumber % 20 === 0 || pageNumber === pdf.numPages) {
      progress(`${file.name}: PDF ${pageNumber}/${pdf.numPages}페이지 색인 중`);
    }
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const textAvailable = text.length > 2;
    records.push({
      id: `${id}-page-${pageNumber}`,
      document_id: id,
      document_type: documentType,
      file_name: file.name,
      source_kind: "pdf",
      page: pageNumber,
      page_count: pdf.numPages,
      context_pages: { from: Math.max(1, pageNumber - 1), to: Math.min(pdf.numPages, pageNumber + 1) },
      section: `PDF Page ${pageNumber}`,
      title: titleFromText(text, `${file.name} · Page ${pageNumber}`),
      body: text,
      text_available: textAvailable,
      ocr_status: textAvailable ? "not_needed" : "pending",
    });
  }
  return records;
}

async function indexWorkbook(file: File, id: string, documentType: string, progress: IndexProgress) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  const records: IndexedRecord[] = [];
  workbook.SheetNames.forEach((sheetName) => {
    progress(`${file.name}: ${sheetName} 시트 색인 중`);
    const sheet = workbook.Sheets[sheetName];
    const worksheetRange = sheet["!ref"]
      ? XLSX.utils.decode_range(sheet["!ref"])
      : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" });
    const header = (rows[0] ?? []).map(compact);
    rows.forEach((row, rowIndex) => {
      if (rowIndex === 0) return;
      const values = row.map(compact);
      if (!values.some(Boolean)) return;
      const body = values.map((value, index) => value ? `${header[index] || `열 ${index + 1}`}: ${value}` : "").filter(Boolean).join(" | ");
      const actualRow = worksheetRange.s.r + rowIndex;
      const startColumn = worksheetRange.s.c;
      const endColumn = Math.max(startColumn, startColumn + values.length - 1);
      const range = `${XLSX.utils.encode_col(startColumn)}${actualRow + 1}:${XLSX.utils.encode_col(endColumn)}${actualRow + 1}`;
      records.push({
        id: `${id}-${sheetName.replace(/[^a-zA-Z0-9가-힣]/g, "-")}-${actualRow + 1}`,
        document_id: id,
        document_type: documentType,
        file_name: file.name,
        source_kind: "excel",
        sheet: sheetName,
        range,
        excel_range_is_absolute: true,
        section: sheetName,
        title: values.filter(Boolean).slice(0, 3).join(" · ").slice(0, 180) || `${sheetName} ${actualRow + 1}행`,
        body,
        text_available: true,
        ocr_status: "not_needed",
      });
    });
  });
  return records;
}

async function indexWord(file: File, id: string, documentType: string, progress: IndexProgress) {
  if (file.name.toLowerCase().endsWith(".doc")) {
    throw new Error("구형 .doc 파일은 Word에서 .docx로 저장한 뒤 추가해 주세요.");
  }
  progress(`${file.name}: Word 문단을 읽는 중`);
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  const paragraphs = result.value.split(/\n+/).map(compact).filter(Boolean);
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;
  paragraphs.forEach((paragraph) => {
    if (current.length >= 12 || currentLength + paragraph.length > 5000) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(paragraph);
    currentLength += paragraph.length;
  });
  if (current.length) chunks.push(current);
  return chunks.map<IndexedRecord>((chunk, index) => ({
    id: `${id}-section-${index + 1}`,
    document_id: id,
    document_type: documentType,
    file_name: file.name,
    source_kind: "word",
    page: index + 1,
    page_count: chunks.length,
    context_pages: { from: Math.max(1, index), to: Math.min(chunks.length, index + 2) },
    section: `Word 문맥 구간 ${index + 1}`,
    title: titleFromText(chunk.join("\n"), `${file.name} · 구간 ${index + 1}`),
    body: chunk.join("\n\n"),
    text_available: chunk.length > 0,
    ocr_status: "not_needed",
  }));
}

export async function indexFile(file: File, documentTypeId: string, documentType: string, progress: IndexProgress) {
  const id = documentId();
  const lower = file.name.toLowerCase();
  let records: IndexedRecord[];
  let sourceKind: UploadSourceKind;
  if (lower.endsWith(".pdf")) {
    sourceKind = "pdf";
    records = await indexPdf(file, id, documentType, progress);
  } else if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    sourceKind = "excel";
    records = await indexWorkbook(file, id, documentType, progress);
  } else if (lower.endsWith(".docx") || lower.endsWith(".doc")) {
    sourceKind = "word";
    records = await indexWord(file, id, documentType, progress);
  } else {
    throw new Error("PDF, Excel(.xls/.xlsx), Word(.docx) 파일만 추가할 수 있습니다.");
  }
  if (!records.length) throw new Error("검색 가능한 텍스트나 행을 찾지 못했습니다.");
  records = records.map((record) => ({ ...record, document_type_id: documentTypeId }));
  const document: IndexedDocument = {
    id,
    display_name: file.name,
    type: documentType,
    type_id: documentTypeId,
    source_kind: sourceKind,
    page_count: sourceKind === "excel" ? undefined : records.length,
    record_count: records.length,
    text_pages: records.filter((record) => record.text_available).length,
    ocr_pending_pages: records.filter((record) => record.ocr_status === "pending").length,
  };
  return { document, records };
}
