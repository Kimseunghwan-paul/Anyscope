"use client";

import { useEffect, useState } from "react";
import { loadPdfJs, PDFJS_DOCUMENT_OPTIONS } from "./pdfjs-config";

type RenderedPage = { page: number; image: string; width: number; height: number };

export default function PdfContextPreview({ documentId, from, to, activePage }: { documentId: string; from: number; to: number; activePage: number }) {
  const requestedPageCount = Math.max(1, to - from + 1);
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const [status, setStatus] = useState(`선택한 ${requestedPageCount}페이지를 준비하는 중입니다…`);

  useEffect(() => {
    let cancelled = false;
    const objectUrls: string[] = [];
    (async () => {
      try {
        const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}`);
        if (!response.ok) throw new Error("원본 PDF를 불러오지 못했습니다.");
        const pdfjs = await loadPdfJs();
        const pdf = await pdfjs.getDocument({
          data: new Uint8Array(await response.arrayBuffer()),
          ...PDFJS_DOCUMENT_OPTIONS,
        }).promise;
        const rendered: RenderedPage[] = [];
        const actualFrom = Math.max(1, from);
        const actualTo = Math.min(to, pdf.numPages);
        const actualPageCount = Math.max(1, actualTo - actualFrom + 1);
        const renderScale = actualPageCount > 10 ? 1.5 : actualPageCount > 3 ? 1.7 : 2;
        for (let pageNumber = actualFrom; pageNumber <= actualTo; pageNumber += 1) {
          if (cancelled) return;
          setStatus(`PDF ${pageNumber}페이지를 표시하는 중입니다…`);
          const page = await pdf.getPage(pageNumber);
          const viewport = page.getViewport({ scale: renderScale });
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) throw new Error("PDF 화면을 만들 수 없습니다.");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PDF 이미지를 만들 수 없습니다.")), "image/jpeg", 0.88));
          const image = URL.createObjectURL(blob);
          objectUrls.push(image);
          rendered.push({ page: pageNumber, image, width: canvas.width, height: canvas.height });
          if (!cancelled) setPages([...rendered]);
        }
        if (!cancelled) {
          setStatus("");
        }
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : "PDF를 표시하지 못했습니다.");
      }
    })();
    return () => {
      cancelled = true;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [documentId, from, to, requestedPageCount]);

  return (
    <div className="pdf-page-strip" aria-live="polite">
      {status && <div className="preview-loading"><span />{status}</div>}
      {pages.map((page) => (
        <figure key={page.page} className={page.page === activePage ? "active" : ""}>
          <figcaption>{page.page === activePage ? "검색 결과 페이지" : "인접 페이지"} · p. {page.page}</figcaption>
          {/* PDF.js renders local object URLs that Next Image cannot optimize. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={page.image} width={page.width} height={page.height} alt={`원본 PDF ${page.page}페이지`} />
        </figure>
      ))}
    </div>
  );
}
