from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_INDEX = ROOT / "input-documents" / "index" / "search-records.jsonl"

BILINGUAL_EXPANSIONS = {
    "부가가치세": ["vat", "value added tax", "tax"],
    "세금": ["tax", "taxes", "duty"],
    "공사기간": ["construction period", "time for completion", "completion period"],
    "기간 연장": ["extension of time", "time extension", "extend the deadline"],
    "공기 연장": ["extension of time", "time extension", "construction period"],
    "입찰 연장": ["extension of bid submission", "bid deadline extension", "time extension"],
    "하도급": ["subcontract", "subcontractor", "subcontracting"],
    "수위": ["water level", "groundwater level", "ground water table", "tide level"],
    "지하수": ["groundwater", "ground water table", "water table"],
    "지반 조사": ["geotechnical investigation", "soil investigation", "ground investigation", "borehole"],
    "지반조사": ["geotechnical investigation", "soil investigation", "ground investigation", "borehole"],
    "연약지반": ["soft ground", "soft soil", "ground improvement"],
    "침하": ["settlement", "subsidence", "consolidation"],
    "입찰보증": ["bid security", "bid bond"],
    "이행보증": ["performance security", "performance bond"],
    "현장 인도": ["possession of site", "site possession", "access to the site"],
    "홍수": ["flood", "flooding", "inundation"],
    "환율": ["exchange rate", "currency conversion", "rate of exchange"],
    "항행": ["navigation", "navigable", "marine traffic"],
    "교량": ["bridge", "bridges"],
    "시추": ["borehole", "boring", "drilling"],
    "기초": ["foundation", "foundations"],
    "말뚝": ["pile", "piling", "bored pile"],
    "위험": ["risk", "hazard"],
    "환경": ["environmental", "environment"],
    "공사 지연": ["construction delay", "schedule delay", "delay in construction"],
    "가격 조정": ["price adjustment", "escalation"],
    "설계 변경": ["design change", "variation"],
    "준설": ["dredging", "dredge"],
    "우기": ["rainy season", "wet season"],
    "태풍": ["typhoon", "tropical cyclone"],
    "현장": ["site", "field"],
    "침수": ["flooding", "inundation", "waterlogging"],
    "대응": ["mitigation", "response", "treatment"],
    "시추공": ["borehole", "boring"],
    "깊이": ["depth", "deep"],
    "기준": ["criteria", "requirements", "minimum"],
}

STOPWORDS = {
    "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are",
    "을", "를", "이", "가", "은", "는", "에", "의", "와", "과", "에서", "대한", "관련",
    "내용", "조항", "찾아줘", "알려줘", "경우",
}


def normalize(text: str) -> str:
    text = text.lower().replace("–", "-").replace("—", "-")
    return re.sub(r"\s+", " ", text).strip()


def tokens(text: str) -> list[str]:
    raw = re.findall(r"[a-z][a-z0-9'-]{1,}|[가-힣]{2,}|\d+(?:\.\d+)+", normalize(text))
    return [token for token in raw if token not in STOPWORDS]


def expand_query(query: str) -> tuple[list[str], list[str], list[str]]:
    normalized = normalize(query)
    original_terms = tokens(normalized)
    phrases: list[str] = [normalized]
    expanded_terms: list[str] = []
    for korean, english_values in BILINGUAL_EXPANSIONS.items():
        if korean in normalized:
            for value in english_values:
                phrases.append(value)
                expanded_terms.extend(tokens(value))
    all_terms = list(dict.fromkeys([*original_terms, *expanded_terms]))
    return original_terms, all_terms, list(dict.fromkeys(phrases))


def phrase_hits(text: str, phrases: list[str]) -> int:
    return sum(1 for phrase in phrases if len(phrase) >= 3 and " " in phrase and phrase in text)


def score_record(record: dict[str, Any], query: str) -> tuple[float, dict[str, Any]]:
    original_terms, all_terms, phrases = expand_query(query)
    title = normalize(str(record.get("title", "")))
    section = normalize(str(record.get("section", "")))
    body = normalize(str(record.get("body", "")))

    title_phrase_hits = phrase_hits(title, phrases)
    body_phrase_hits = phrase_hits(body, phrases)
    title_terms = [term for term in all_terms if term in title]
    section_terms = [term for term in all_terms if term in section]
    body_counts = {term: len(re.findall(rf"(?<!\w){re.escape(term)}(?!\w)", body)) for term in all_terms}
    body_frequency = sum(body_counts.values())

    score = 0.0
    score += min(38.0, title_phrase_hits * 38.0)
    score += min(35.0, len(title_terms) * 7.0)
    if original_terms and all(term in title for term in original_terms):
        score += 10.0
    score += min(15.0, len(section_terms) * 5.0)
    score += min(16.0, body_phrase_hits * 16.0)
    score += min(28.0, 4.5 * math.log1p(body_frequency))
    if original_terms and all(body_counts.get(term, 0) > 0 for term in original_terms):
        score += 6.0

    score = min(100.0, round(score, 1))
    reasons = {
        "title_phrase": title_phrase_hits,
        "title_term_hits": len(title_terms),
        "section_term_hits": len(section_terms),
        "body_phrase": body_phrase_hits,
        "body_frequency": body_frequency,
        "matched_terms": [term for term in all_terms if term in title or term in section or body_counts.get(term, 0)],
        "expanded_phrases": phrases[1:],
    }
    return score, reasons


def snippet(record: dict[str, Any], matched_terms: list[str], width: int = 420) -> str:
    body = re.sub(r"\s+", " ", str(record.get("body", ""))).strip()
    if not body:
        return "텍스트를 추출하지 못한 페이지입니다. OCR 처리가 필요합니다."
    normalized = body.lower()
    positions = [normalized.find(term) for term in matched_terms if normalized.find(term) >= 0]
    center = min(positions) if positions else 0
    start = max(0, center - width // 3)
    end = min(len(body), start + width)
    prefix = "…" if start else ""
    suffix = "…" if end < len(body) else ""
    return prefix + body[start:end].strip() + suffix


def load_records(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def main() -> None:
    parser = argparse.ArgumentParser(description="Search the private ClauseScope local corpus.")
    parser.add_argument("query")
    parser.add_argument("--index", type=Path, default=DEFAULT_INDEX)
    parser.add_argument("--type", action="append", dest="types")
    parser.add_argument("--min-score", type=float, default=8.0)
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    results = []
    for record in load_records(args.index.resolve()):
        if args.types and record.get("document_type") not in args.types:
            continue
        score, reasons = score_record(record, args.query)
        if score < args.min_score:
            continue
        results.append({
            "score": score,
            "id": record.get("id"),
            "document_id": record.get("document_id"),
            "document_type": record.get("document_type"),
            "file_name": record.get("file_name"),
            "title": record.get("title"),
            "page": record.get("page"),
            "sheet": record.get("sheet"),
            "range": record.get("range"),
            "context_pages": record.get("context_pages"),
            "ocr_status": record.get("ocr_status"),
            "snippet": snippet(record, reasons["matched_terms"]),
            "reasons": reasons,
        })

    results.sort(key=lambda item: (-item["score"], item["file_name"], item["page"] or 0))
    payload = {"query": args.query, "total": len(results), "results": results[: args.limit]}
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return

    print(f"검색: {args.query} | {len(results)}건 (상위 {min(args.limit, len(results))}건)")
    for index, item in enumerate(results[: args.limit], start=1):
        location = f"p.{item['page']}" if item["page"] else f"{item['sheet']}!{item['range']}"
        print(f"\n{index}. [{item['score']:.1f}] {item['title']} — {item['file_name']} / {location}")
        print(f"   {item['snippet']}")
        print(f"   근거: {item['reasons']}")


if __name__ == "__main__":
    main()