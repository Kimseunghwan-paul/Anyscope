import { loadPdfJs, PDFJS_DOCUMENT_OPTIONS } from "./pdfjs-config";

export type OcrPageTarget = { recordId: string; page: number };

export type OcrPageResult = {
  record_id: string;
  page: number;
  body: string;
  title: string;
  confidence: number;
  method: "embedded_text" | "tesseract";
};

type OcrProgress = (message: string) => void;

function cleanOcrText(value: string) {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function titleFromOcr(text: string, fallback: string) {
  return (text.split("\n").map((line) => line.trim()).find((line) => line.length >= 3) || fallback).slice(0, 180);
}

function statusLabel(status: string) {
  if (status.includes("loading tesseract core")) return "OCR 엔진을 불러오는 중";
  if (status.includes("loading language")) return "한글·영문 언어 자료를 불러오는 중";
  if (status.includes("initializing")) return "OCR 엔진을 준비하는 중";
  if (status.includes("recognizing")) return "글자를 인식하는 중";
  return "OCR 처리 중";
}

export async function recognizePdfPages(
  documentId: string,
  fileName: string,
  targets: OcrPageTarget[],
  progress: OcrProgress,
  shouldCancel: () => boolean,
  saveBatch?: (results: OcrPageResult[]) => Promise<void>,
) {
  const [pdfjs, Tesseract] = await Promise.all([loadPdfJs(), import("tesseract.js")]);
  const pdf = await pdfjs.getDocument({
    url: `/api/documents/${encodeURIComponent(documentId)}`,
    rangeChunkSize: 262_144,
    disableAutoFetch: true,
    disableStream: true,
    ...PDFJS_DOCUMENT_OPTIONS,
  }).promise.catch(() => { throw new Error(`${fileName}: 원본 PDF를 불러오지 못했습니다.`); });
  let activePage = targets[0]?.page ?? 1;
  let activeIndex = 0;
  let worker: Awaited<ReturnType<typeof Tesseract.createWorker>> | null = null;
  let embeddedTextPages = 0;
  let tesseractPages = 0;
  const results: OcrPageResult[] = [];
  const pendingBatch: OcrPageResult[] = [];
  async function addResult(result: OcrPageResult) {
    results.push(result);
    if (!saveBatch) return;
    pendingBatch.push(result);
    if (pendingBatch.length < 100) return;
    const batch = pendingBatch.slice();
    await saveBatch(batch);
    pendingBatch.splice(0, batch.length);
  }
  try {
    for (let index = 0; index < targets.length; index += 1) {
      if (shouldCancel()) break;
      const target = targets[index];
      activePage = target.page;
      activeIndex = index;
      progress(`${fileName}: ${target.page}페이지 내장 텍스트를 다시 확인하는 중 · ${index + 1}/${targets.length}`);
      const page = await pdf.getPage(target.page);
      const content = await page.getTextContent();
      const embeddedText = cleanOcrText(content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" "));
      if (embeddedText.replace(/\s+/g, "").length >= 20) {
        embeddedTextPages += 1;
        await addResult({
          record_id: target.recordId,
          page: target.page,
          body: embeddedText,
          title: titleFromOcr(embeddedText, `${fileName} · Page ${target.page}`),
          confidence: 100,
          method: "embedded_text",
        });
        progress(`${fileName}: ${target.page}페이지 내장 텍스트 복구 완료 · ${index + 1}/${targets.length}`);
        continue;
      }

      if (!worker) {
        worker = await Tesseract.createWorker(["kor", "eng"], Tesseract.OEM.LSTM_ONLY, {
          logger: (message) => {
            const percent = Math.max(0, Math.min(100, Math.round((message.progress || 0) * 100)));
            progress(`${fileName}: ${activePage}페이지 ${statusLabel(message.status)} ${percent}% · ${activeIndex + 1}/${targets.length}`);
          },
        });
        await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.AUTO, preserve_interword_spaces: "1", user_defined_dpi: "180" });
      }

      progress(`${fileName}: ${target.page}페이지 OCR 이미지를 준비하는 중 · ${index + 1}/${targets.length}`);
      let scale = 2.5;
      let viewport = page.getViewport({ scale });
      const maxPixels = 12_000_000;
      if (viewport.width * viewport.height > maxPixels) {
        scale *= Math.sqrt(maxPixels / (viewport.width * viewport.height));
        viewport = page.getViewport({ scale });
      }
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("OCR용 PDF 이미지를 만들지 못했습니다.");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const recognized = await worker.recognize(canvas);
      tesseractPages += 1;
      const body = cleanOcrText(recognized.data.text || "");
      await addResult({
        record_id: target.recordId,
        page: target.page,
        body,
        title: titleFromOcr(body, `${fileName} · Page ${target.page}`),
        confidence: Math.round(recognized.data.confidence || 0),
        method: "tesseract",
      });
      canvas.width = 1;
      canvas.height = 1;
    }
  } finally {
    try {
      if (saveBatch && pendingBatch.length) {
        const batch = pendingBatch.slice();
        await saveBatch(batch);
        pendingBatch.splice(0, batch.length);
      }
    } finally {
      if (worker) await worker.terminate();
      await pdf.destroy();
    }
  }
  return { results, cancelled: shouldCancel(), embeddedTextPages, tesseractPages };
}
