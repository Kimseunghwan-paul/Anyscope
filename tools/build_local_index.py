from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from pypdf import PdfReader


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE_DIR = ROOT / "input-documents" / "raw"
DEFAULT_OUTPUT_DIR = ROOT / "input-documents" / "index"

PDF_DOCUMENTS = (
    {"id": "cp1b-bidding-documents", "file": "cp1b-bidding-documents.pdf", "display_name": "CP1B Bidding Documents.pdf", "type": "입찰문서"},
    {"id": "gi-report-sept-2025", "file": "gi-report-sept-2025.pdf", "display_name": "LLRN-P1_CP1B-S1_GI Report_Sept 2025.pdf", "type": "입찰문서"},
    {"id": "dgcs-bridge-design-volume-5", "file": "dgcs-bridge-design-volume-5.pdf", "display_name": "DGCS_Bridge Design_Volume_5 2015.pdf", "type": "Local Standard"},
)

EXCEL_DOCUMENTS = (
    {"id": "bid-bulletin-summary", "display_name": "260605 (검토) 251029_BB Summary No 3 4_의견반영.xlsx", "type": "Bid Bulletin"},
    {"id": "project-risk-register", "display_name": "260616 LLRN CP-1B 주요 Project Risk 정리.xlsx", "type": "Risk Register"},
)

HEADING_PREFIX = re.compile(
    r"^(?:(?:section|part|volume|chapter|appendix|annex|schedule|clause|sub-?clause|item)\b|(?:\d+(?:\.\d+){0,5}|[A-Z](?:\.\d+){0,4})[.)]?\s+[A-Z(]|(?:[IVXLC]+)[.)]\s+[A-Z])",
    re.IGNORECASE,
)
CLAUSE_REFERENCE = re.compile(
    r"\b(?:sub-?clause|clause|section|part|appendix|annex)\s+[A-Z0-9][A-Z0-9.()\-/]*",
    re.IGNORECASE,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    value = value.replace("\x00", " ").replace("\r", "\n")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n[ \t]+", "\n", value)
    return re.sub(r"\n{3,}", "\n\n", value).strip()


def clean_line(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def looks_like_heading(line: str) -> bool:
    line = clean_line(line)
    if not line or len(line) > 220:
        return False
    if HEADING_PREFIX.match(line):
        return True
    letters = [char for char in line if char.isalpha()]
    if 5 <= len(letters) <= 90:
        uppercase = sum(1 for char in letters if char.isupper())
        return uppercase / len(letters) >= 0.88 and not line.endswith((".", ";", ","))
    return False


def page_title(text: str, fallback: str) -> str:
    candidates = [clean_line(line) for line in text.splitlines()[:80] if looks_like_heading(line)]
    if candidates:
        clause_candidates = [line for line in candidates if CLAUSE_REFERENCE.search(line)]
        return (clause_candidates or candidates)[0][:220]
    return fallback


def keyword_counts(text: str) -> dict[str, int]:
    words = re.findall(r"[A-Za-z][A-Za-z0-9'-]{2,}|[가-힣]{2,}", text.lower())
    return dict(Counter(words).most_common(40))


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def extract_pdf(document: dict[str, str], source_dir: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    path = source_dir / document["file"]
    reader = PdfReader(str(path), strict=False)
    page_count = len(reader.pages)
    records: list[dict[str, Any]] = []
    text_pages = 0
    image_only_pages = 0
    errors: list[dict[str, Any]] = []

    for page_index, page in enumerate(reader.pages):
        page_number = page_index + 1
        try:
            extracted = clean_text(page.extract_text(extraction_mode="layout"))
        except Exception as exc:
            extracted = ""
            errors.append({"page": page_number, "error": str(exc)[:300]})

        has_text = len(re.sub(r"\s+", "", extracted)) >= 20
        text_pages += int(has_text)
        image_only_pages += int(not has_text)
        title = page_title(extracted, f"{document['display_name']} · p.{page_number}")
        records.append({
            "id": f"{document['id']}-p{page_number}",
            "document_id": document["id"],
            "document_type": document["type"],
            "file_name": document["display_name"],
            "source_kind": "pdf",
            "page": page_number,
            "page_count": page_count,
            "context_pages": {"from": max(1, page_number - 1), "to": min(page_count, page_number + 1)},
            "title": title,
            "body": extracted,
            "text_available": has_text,
            "ocr_status": "not_needed" if has_text else "pending",
            "term_counts": keyword_counts(f"{title}\n{extracted}"),
        })
        if page_number % 50 == 0 or page_number == page_count:
            print(f"[{document['id']}] {page_number}/{page_count}", flush=True)

    metadata = {
        **document,
        "source_kind": "pdf",
        "bytes": path.stat().st_size,
        "sha256": file_sha256(path),
        "page_count": page_count,
        "text_pages": text_pages,
        "ocr_pending_pages": image_only_pages,
        "extraction_errors": errors,
    }
    return metadata, records


def load_excel_records(output_dir: Path) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    data = json.loads((output_dir / "excel-records.json").read_text(encoding="utf-8"))
    records: list[dict[str, Any]] = data["records"]
    counts: Counter[str] = Counter()
    for record in records:
        record["source_kind"] = "excel"
        record["text_available"] = True
        record["ocr_status"] = "not_needed"
        record["context_pages"] = None
        record["term_counts"] = keyword_counts(f"{record.get('title', '')}\n{record.get('body', '')}")
        counts[record["document_id"]] += 1
    metadata = {item["id"]: {**item, "source_kind": "excel", "record_count": counts[item["id"]]} for item in EXCEL_DOCUMENTS}
    return records, metadata


def write_jsonl(path: Path, records: Iterable[dict[str, Any]]) -> int:
    count = 0
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            count += 1
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the private ClauseScope local search corpus.")
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_SOURCE_DIR)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args()
    source_dir = args.source_dir.resolve()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    documents: list[dict[str, Any]] = []
    pdf_records: list[dict[str, Any]] = []
    for document in PDF_DOCUMENTS:
        metadata, records = extract_pdf(document, source_dir)
        documents.append(metadata)
        pdf_records.extend(records)

    excel_records, excel_metadata = load_excel_records(output_dir)
    documents.extend(excel_metadata.values())
    all_records = [*pdf_records, *excel_records]
    record_count = write_jsonl(output_dir / "search-records.jsonl", all_records)
    manifest = {
        "schema_version": 1,
        "generated_at": utc_now(),
        "privacy": "local_only",
        "documents": documents,
        "record_count": record_count,
        "pdf_record_count": len(pdf_records),
        "excel_record_count": len(excel_records),
        "text_record_count": sum(bool(record.get("text_available")) for record in all_records),
        "ocr_pending_record_count": sum(record.get("ocr_status") == "pending" for record in all_records),
        "scoring": {"title_phrase": 38, "title_terms": 7, "body_phrase": 16, "body_frequency_cap": 28, "section_terms": 5},
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()