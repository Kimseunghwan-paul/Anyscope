import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { displayExcelRange } from "./excel-location";

export type ReportHit = {
  score: number;
  snippet: string;
  reasons: { label: string; value: number; strong?: boolean }[];
  record: {
    id: string;
    document_type: string;
    file_name: string;
    title: string;
    source_kind: "pdf" | "excel" | "word";
    page?: number;
    sheet?: string;
    range?: string;
    excel_range_is_absolute?: boolean;
    ocr_status: "not_needed" | "pending" | "complete";
  };
};

export type AiSummaryReport = {
  title: string;
  executiveSummary: string;
  overallAssessment: string;
  keyFindings: { heading: string; summary: string; evidenceRefs: string[] }[];
  requirements: string[];
  risksAndExceptions: string[];
  recommendations: string[];
  limitations: string[];
};
export type ReportAnalysis = {
  executiveSummary: string;
  conclusion: string;
  averageScore: number;
  directTitleMatches: number;
  groups: { label: string; count: number; bestScore: number; interpretation: string }[];
  findings: { title: string; evidence: string; analysis: string; source: string }[];
  limitations: string[];
};

function location(hit: ReportHit) {
  if (hit.record.source_kind === "pdf") return `p. ${hit.record.page ?? "-"}`;
  if (hit.record.source_kind === "word") return `문맥 구간 ${hit.record.page ?? "-"}`;
  return `${hit.record.sheet ?? "Sheet"}!${displayExcelRange(hit.record)}`;
}

function shortText(value: string, length = 650) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > length ? compact.slice(0, length).trimEnd() + "…" : compact;
}

export function analyzeReport(query: string, hits: ReportHit[], pendingOcr: number): ReportAnalysis {
  const averageScore = hits.length ? Math.round(hits.reduce((sum, hit) => sum + hit.score, 0) / hits.length) : 0;
  const directTitleMatches = hits.filter((hit) => hit.reasons.some((reason) => reason.label === "Clause 제목" && reason.value >= 15)).length;
  const highConfidence = hits.filter((hit) => hit.score >= 70).length;
  const uniqueDocuments = new Set(hits.map((hit) => hit.record.file_name)).size;
  const strongest = [...hits].sort((a, b) => b.score - a.score)[0];
  const strengthText = highConfidence >= 2 ? "직접 관련성이 높은 근거가 여러 건 확인되었습니다" : highConfidence === 1 ? "직접 관련성이 높은 핵심 근거 1건과 보조 근거가 확인되었습니다" : "관련 정황은 확인되지만 직접적인 Clause 근거는 추가 확인이 필요합니다";
  const executiveSummary = `“${query}”에 대해 선택한 ${hits.length}개 근거를 ${uniqueDocuments}개 문서에서 비교했습니다. ${strengthText}. 평균 관련도는 ${averageScore}점이며, Clause 제목에서 검색 개념이 강하게 확인된 결과는 ${directTitleMatches}건입니다.${strongest ? ` 가장 강한 근거는 “${strongest.record.title}”(${strongest.score}점)입니다.` : ""}`;
  const conclusion = highConfidence >= 2 && uniqueDocuments >= 2
    ? "복수 문서에서 같은 검색 개념이 확인되어 상호 보강되는 근거가 있습니다. 다만 적용 조건·예외·최신 Bid Bulletin 반영 여부는 해당 원문 전후 페이지에서 확인해야 합니다."
    : highConfidence >= 1
      ? "핵심 근거는 확인되었지만 다른 문서 유형의 교차 근거가 제한적입니다. 관련 Clause의 정의·적용 범위·예외 조항을 함께 검토해야 합니다."
      : "현재 선택 근거만으로 단정하기는 어렵습니다. 최소 관련도를 낮추거나 동의어로 재검색해 직접적인 제목·문구 근거를 추가하는 것이 좋습니다.";

  const grouped = new Map<string, ReportHit[]>();
  hits.forEach((hit) => grouped.set(hit.record.document_type, [...(grouped.get(hit.record.document_type) ?? []), hit]));
  const groups = [...grouped.entries()].map(([label, groupHits]) => {
    const bestScore = Math.max(...groupHits.map((hit) => hit.score));
    const titleCount = groupHits.filter((hit) => hit.reasons.some((reason) => reason.label === "Clause 제목" && reason.value >= 15)).length;
    return {
      label,
      count: groupHits.length,
      bestScore,
      interpretation: titleCount ? `제목 직접 일치 ${titleCount}건을 포함한 우선 검토 자료` : "본문 문맥·번역 개념을 중심으로 확인된 보조 자료",
    };
  }).sort((a, b) => b.bestScore - a.bestScore);

  const findings = [...hits].sort((a, b) => b.score - a.score).slice(0, 10).map((hit) => {
    const titleReason = hit.reasons.find((reason) => reason.label === "Clause 제목");
    const translatedReason = hit.reasons.find((reason) => reason.label.includes("한→영"));
    const frequencyReason = hit.reasons.find((reason) => reason.label.startsWith("본문 용어"));
    const signals = [
      titleReason && titleReason.value >= 15 ? "Clause 제목 직접 일치" : "본문 문맥 일치",
      translatedReason && translatedReason.value > 0 ? "한글 질의의 영어 개념 일치" : "원문 검색어 일치",
      frequencyReason ? frequencyReason.label : null,
    ].filter(Boolean).join(" · ");
    return {
      title: `${hit.record.title} (${hit.score}/100)`,
      evidence: shortText(hit.snippet),
      analysis: `${signals}. 이 근거는 ${hit.score >= 70 ? "우선 검토해야 할 직접 근거" : hit.score >= 50 ? "결론을 보강하는 관련 근거" : "추가 확인이 필요한 참고 근거"}로 분류됩니다.`,
      source: `${hit.record.file_name}, ${location(hit)}`,
    };
  });

  const limitations = [
    "관련도 점수는 제목·문구·한→영 개념 일치·본문 반복 빈도를 조합한 검색 점수이며 법률적 또는 기술적 확정 판단이 아닙니다.",
    "표·그래프·도면의 수치와 주석은 텍스트 추출에서 누락될 수 있으므로 앞·뒤 1페이지 보기로 원본을 확인해야 합니다.",
    pendingOcr > 0 ? `현재 OCR 미완료 페이지 ${pendingOcr}건은 검색 결과에서 누락될 수 있습니다.` : "현재 색인에서 OCR 미완료로 표시된 페이지는 없습니다.",
    "최종 검토 시 최신 Bid Bulletin/Addendum, 정의 조항, 예외 조항 및 문서 간 우선순위를 함께 확인해야 합니다.",
  ];
  return { executiveSummary, conclusion, averageScore, directTitleMatches, groups, findings, limitations };
}

const FONT = { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "Malgun Gothic" };
const COLORS = { ink: "173243", blue: "2E74B5", darkBlue: "1F4D78", orange: "C45C2C", muted: "687C85", fill: "F2F4F7", white: "FFFFFF" };
const TABLE_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: "D8E0E2" },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: "D8E0E2" },
  left: { style: BorderStyle.SINGLE, size: 4, color: "D8E0E2" },
  right: { style: BorderStyle.SINGLE, size: 4, color: "D8E0E2" },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "D8E0E2" },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "D8E0E2" },
};

function textCell(text: string, width: number, header = false) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    shading: header ? { type: ShadingType.CLEAR, fill: COLORS.fill, color: "auto" } : undefined,
    children: [new Paragraph({ spacing: { before: 0, after: 0, line: 276 }, children: [new TextRun({ text, font: FONT, size: 20, bold: header, color: COLORS.ink })] })],
  });
}

function evidenceTable(hits: ReportHit[]) {
  const widths = [650, 2050, 2500, 3260, 900];
  const header = ["No.", "문서 유형", "Clause/항목", "출처 위치", "점수"];
  const rows = hits.slice(0, 20).map((hit, index) => new TableRow({ children: [
    textCell(String(index + 1), widths[0]),
    textCell(hit.record.document_type, widths[1]),
    textCell(shortText(hit.record.title, 110), widths[2]),
    textCell(`${hit.record.file_name} · ${location(hit)}`, widths[3]),
    textCell(String(hit.score), widths[4]),
  ] }));
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    indent: { size: 120, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: widths,
    borders: TABLE_BORDERS,
    rows: [new TableRow({ tableHeader: true, children: header.map((value, index) => textCell(value, widths[index], true)) }), ...rows],
  });
}

export async function buildWordReport(query: string, hits: ReportHit[], pendingOcr: number) {
  const analysis = analyzeReport(query, hits, pendingOcr);
  const today = new Date().toLocaleDateString("ko-KR");
  const body: (Paragraph | Table)[] = [
    new Paragraph({ spacing: { before: 0, after: 80 }, children: [new TextRun({ text: "ANYSCOPE · GROUNDED REVIEW", font: FONT, size: 18, bold: true, color: COLORS.orange, characterSpacing: 20 })] }),
    new Paragraph({ spacing: { before: 0, after: 120 }, children: [new TextRun({ text: "근거 검토 보고서", font: FONT, size: 46, bold: true, color: COLORS.ink })] }),
    new Paragraph({ spacing: { before: 0, after: 240 }, children: [new TextRun({ text: `검토 질문: ${query}`, font: FONT, size: 26, color: COLORS.darkBlue })] }),
    new Table({
      width: { size: 9360, type: WidthType.DXA }, indent: { size: 120, type: WidthType.DXA }, layout: TableLayoutType.FIXED, columnWidths: [1875, 7485], borders: TABLE_BORDERS,
      rows: [
        new TableRow({ children: [textCell("작성일", 1875, true), textCell(today, 7485)] }),
        new TableRow({ children: [textCell("근거 범위", 1875, true), textCell(`${hits.length}개 결과 · ${new Set(hits.map((hit) => hit.record.file_name)).size}개 문서`, 7485)] }),
        new TableRow({ children: [textCell("검토 상태", 1875, true), textCell("내부 검토용 · 원본 대조 필요", 7485)] }),
      ],
    }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("1. 요약 분석")] }),
    new Paragraph(analysis.executiveSummary),
    new Paragraph({ spacing: { before: 120, after: 120 }, shading: { type: ShadingType.CLEAR, fill: "F4F6F9", color: "auto" }, indent: { left: 180, right: 180 }, children: [new TextRun({ text: `검토 판단: ${analysis.conclusion}`, bold: true, color: COLORS.darkBlue })] }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("2. 문서 유형별 교차 분석")] }),
    new Table({
      width: { size: 9360, type: WidthType.DXA }, indent: { size: 120, type: WidthType.DXA }, layout: TableLayoutType.FIXED, columnWidths: [2100, 900, 1100, 5260], borders: TABLE_BORDERS,
      rows: [
        new TableRow({ tableHeader: true, children: [textCell("문서 유형", 2100, true), textCell("건수", 900, true), textCell("최고점", 1100, true), textCell("해석", 5260, true)] }),
        ...analysis.groups.map((group) => new TableRow({ children: [textCell(group.label, 2100), textCell(String(group.count), 900), textCell(String(group.bestScore), 1100), textCell(group.interpretation, 5260)] })),
      ],
    }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("3. 주요 근거와 해석")] }),
  ];

  analysis.findings.forEach((finding, index) => {
    body.push(
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(`${index + 1}) ${finding.title}`)] }),
      new Paragraph({ children: [new TextRun({ text: "원문 발췌  ", bold: true, color: COLORS.orange }), new TextRun(finding.evidence)] }),
      new Paragraph({ children: [new TextRun({ text: "분석  ", bold: true, color: COLORS.darkBlue }), new TextRun(finding.analysis)] }),
      new Paragraph({ spacing: { before: 80, after: 80 }, children: [new TextRun({ text: `[출처] ${finding.source}`, font: FONT, size: 18, color: COLORS.muted, italics: true })] }),
    );
  });
  body.push(
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("4. 근거 목록")] }),
    new Paragraph({ spacing: { before: 80, after: 80 }, children: [new TextRun({ text: "아래 표는 본 보고서 작성에 사용된 검색 결과와 원본 위치입니다.", font: FONT, size: 20, color: COLORS.muted })] }),
    evidenceTable(hits),
    new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun("5. 한계 및 확인사항")] }),
    ...analysis.limitations.map((item) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun(item)] })),
  );

  const document = new Document({
    creator: "AnyScope",
    title: `근거 검토 보고서 - ${query}`,
    description: "검색된 원문 근거를 바탕으로 생성한 내부 검토용 보고서",
    styles: {
      default: {
        document: { run: { font: FONT, size: 22, color: COLORS.ink }, paragraph: { spacing: { before: 0, after: 120, line: 264 } } },
        heading1: { run: { font: FONT, size: 32, bold: true, color: COLORS.blue }, paragraph: { spacing: { before: 320, after: 160 } } },
        heading2: { run: { font: FONT, size: 26, bold: true, color: COLORS.blue }, paragraph: { spacing: { before: 240, after: 120 } } },
        heading3: { run: { font: FONT, size: 24, bold: true, color: COLORS.darkBlue }, paragraph: { spacing: { before: 160, after: 80 } } },
      },
    },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 708, footer: 708 } } },
      headers: { default: new Header({ children: [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "D8E0E2" } }, children: [new TextRun({ text: "AnyScope · 근거 검토 보고서", font: FONT, size: 18, color: COLORS.muted })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: ["내부 검토용  ·  ", PageNumber.CURRENT], font: FONT, size: 18, color: COLORS.muted })] })] }) },
      children: body,
    }],
  });
  return Packer.toBlob(document);
}

function aiList(items: string[], emptyText: string) {
  const values = items.length ? items : [emptyText];
  return values.map((item) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun(item)] }));
}

async function buildGeminiWordReport(query: string, hits: ReportHit[], pendingOcr: number, report: AiSummaryReport, language: "ko" | "en" = "ko") {
  const en = language === "en";
  const today = new Date().toLocaleDateString(en ? "en-US" : "ko-KR");
  const body: (Paragraph | Table)[] = [
    new Paragraph({ spacing: { before: 0, after: 80 }, children: [new TextRun({ text: "ANYSCOPE · GEMINI SUMMARY", font: FONT, size: 18, bold: true, color: COLORS.orange, characterSpacing: 20 })] }),
    new Paragraph({ spacing: { before: 0, after: 120 }, children: [new TextRun({ text: report.title || (en ? "Search Results Summary Report" : "검색 결과 요약 보고서"), font: FONT, size: 42, bold: true, color: COLORS.ink })] }),
    new Paragraph({ spacing: { before: 0, after: 240 }, children: [new TextRun({ text: `${en ? "Review topic" : "검토 주제"}: ${query}`, font: FONT, size: 26, color: COLORS.darkBlue })] }),
    new Table({
      width: { size: 9360, type: WidthType.DXA }, indent: { size: 120, type: WidthType.DXA }, layout: TableLayoutType.FIXED, columnWidths: [1875, 7485], borders: TABLE_BORDERS,
      rows: [
        new TableRow({ children: [textCell(en ? "Date" : "작성일", 1875, true), textCell(today, 7485)] }),
        new TableRow({ children: [textCell(en ? "Scope" : "분석 범위", 1875, true), textCell(en ? `${hits.length} selected results · ${new Set(hits.map((hit) => hit.record.file_name)).size} documents` : `${hits.length}개 선택 결과 · ${new Set(hits.map((hit) => hit.record.file_name)).size}개 문서`, 7485)] }),
        new TableRow({ children: [textCell(en ? "Method" : "작성 방식", 1875, true), textCell(en ? "Gemini evidence-grounded summary · Internal review" : "Gemini 근거 기반 요약 · 내부 검토용", 7485)] }),
      ],
    }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(en ? "1. Executive Summary" : "1. 요약 분석")] }),
    new Paragraph(report.executiveSummary),
    new Paragraph({ spacing: { before: 120, after: 120 }, shading: { type: ShadingType.CLEAR, fill: "EDF6F3", color: "auto" }, indent: { left: 180, right: 180 }, children: [new TextRun({ text: `${en ? "Overall assessment" : "종합 판단"}: ${report.overallAssessment}`, bold: true, color: COLORS.darkBlue })] }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(en ? "2. Key Findings" : "2. 주요 내용")] }),
  ];
  report.keyFindings.forEach((finding, index) => body.push(
    new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(`${index + 1}) ${finding.heading}`)] }),
    new Paragraph(finding.summary),
    new Paragraph({ children: [new TextRun({ text: `${en ? "Evidence" : "근거"}: ${finding.evidenceRefs.join(", ") || (en ? "Selected source" : "선택 원문")}`, font: FONT, size: 18, color: COLORS.muted, italics: true })] }),
  ));
  body.push(
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(en ? "3. Requirements, Conditions, and Figures" : "3. 요구사항·조건·수치")] }),
    ...aiList(report.requirements, en ? "No explicit requirement or figure was identified in the selected evidence." : "선택 근거에서 명시적인 요구사항 또는 수치가 확인되지 않았습니다."),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(en ? "4. Risks, Exceptions, and Ambiguities" : "4. 위험·예외·불명확 사항")] }),
    ...aiList(report.risksAndExceptions, en ? "No separate risk or exception was identified in the selected evidence." : "선택 근거에서 별도의 위험 또는 예외가 확인되지 않았습니다."),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(en ? "5. Recommendations" : "5. 검토 권고")] }),
    ...aiList(report.recommendations, en ? "Review the relevant originals together with the latest amendments." : "관련 원문과 최신 변경 문서를 함께 확인하십시오."),
    new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun(en ? "6. Evidence Used" : "6. 사용 근거")] }),
    evidenceTable(hits),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(en ? "7. Limitations and Checks" : "7. 한계 및 확인사항")] }),
    ...aiList([...report.limitations, ...(pendingOcr > 0 ? [en ? `${pendingOcr} pages with incomplete OCR may be absent from the analysis.` : `OCR 미완료 페이지 ${pendingOcr}건은 분석에서 누락될 수 있습니다.`] : [])], en ? "This AI summary is for internal review; verify the original before a final decision." : "AI 요약은 내부 검토용이며 최종 판단 전에 원문을 확인해야 합니다."),
  );
  const document = new Document({
    creator: "AnyScope",
    title: report.title || `검색 결과 요약 보고서 - ${query}`,
    description: "Gemini가 선택된 원문 근거를 바탕으로 생성한 내부 검토용 요약 보고서",
    styles: {
      default: {
        document: { run: { font: FONT, size: 22, color: COLORS.ink }, paragraph: { spacing: { before: 0, after: 120, line: 264 } } },
        heading1: { run: { font: FONT, size: 32, bold: true, color: COLORS.blue }, paragraph: { spacing: { before: 320, after: 160 } } },
        heading2: { run: { font: FONT, size: 26, bold: true, color: COLORS.blue }, paragraph: { spacing: { before: 240, after: 120 } } },
      },
    },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 708, footer: 708 } } },
      headers: { default: new Header({ children: [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "D8E0E2" } }, children: [new TextRun({ text: en ? "AnyScope · Gemini Summary Report" : "AnyScope · Gemini 요약 보고서", font: FONT, size: 18, color: COLORS.muted })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: [en ? "Internal review  ·  " : "내부 검토용  ·  ", PageNumber.CURRENT], font: FONT, size: 18, color: COLORS.muted })] })] }) },
      children: body,
    }],
  });
  return Packer.toBlob(document);
}

export async function downloadWordReport(query: string, hits: ReportHit[], pendingOcr: number, aiReport?: AiSummaryReport | null, language: "ko" | "en" = "ko") {
  const blob = aiReport ? await buildGeminiWordReport(query, hits, pendingOcr, aiReport, language) : await buildWordReport(query, hits, pendingOcr);
  const url = URL.createObjectURL(blob);
  const link = documentObjectLink(url, `AnyScope_요약보고서_${new Date().toISOString().slice(0, 10)}.docx`);
  link.click();
  URL.revokeObjectURL(url);
}

function documentObjectLink(url: string, filename: string) {
  const link = window.document.createElement("a");
  link.href = url;
  link.download = filename;
  return link;
}
