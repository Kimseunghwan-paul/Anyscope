"use client";

import {
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageNumber,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

type OcrExportDocument = {
  id: string;
  display_name: string;
};

type OcrExportRecord = {
  document_id: string;
  file_name: string;
  page?: number;
  title: string;
  body: string;
  ocr_status: "not_needed" | "pending" | "complete";
};

export async function downloadOcrDocx(
  documents: OcrExportDocument[],
  records: OcrExportRecord[],
) {
  const children: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: "ANYSCOPE · OCR EXPORT", bold: true, color: "E65F2B", size: 18 })],
    }),
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun("OCR 결과 내보내기")],
    }),
    new Paragraph(`${new Date().toLocaleDateString("ko-KR")} · ${documents.length}개 문서`),
  ];
  for (const document of documents) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: children.length > 3,
      children: [new TextRun(document.display_name)],
    }));
    const documentRecords = records
      .filter((record) => record.document_id === document.id && record.ocr_status === "complete")
      .sort((left, right) => (left.page ?? 0) - (right.page ?? 0));
    for (const record of documentRecords) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun(`p. ${record.page ?? "-"} · ${record.title || "OCR 결과"}`)],
        }),
        new Paragraph(record.body || ""),
      );
    }
  }
  const output = new Document({
    creator: "AnyScope",
    title: "AnyScope OCR 결과",
    sections: [{
      headers: { default: new Header({ children: [new Paragraph("AnyScope · OCR 결과") ] }) },
      footers: { default: new Footer({ children: [new Paragraph({
        children: [new TextRun({ children: ["Page ", PageNumber.CURRENT] })],
      })] }) },
      children,
    }],
  });
  const blob = await Packer.toBlob(output);
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement("a");
  link.href = url;
  link.download = `AnyScope_OCR_결과_${new Date().toISOString().slice(0, 10)}.docx`;
  link.style.display = "none";
  window.document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
