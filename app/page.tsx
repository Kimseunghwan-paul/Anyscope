"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { indexFile } from "./document-tools";
import { ANYSCOPE_VERSION, DEFAULT_WORKSPACE_TITLE } from "./app-config";
import {
  createDocumentTypeId,
  descendantDocumentTypeIds,
  documentTypeDepth,
  documentTypeLabel,
  DOCUMENT_TYPE_COLORS,
  normalizeDocumentTypes,
  recommendDocumentType,
  resolveDocumentTypeId,
  UNCATEGORIZED_TYPE,
  type DocumentTypeDefinition,
} from "./document-types";
import PdfContextPreview from "./pdf-context-preview";
import { downloadWordReport, type AiSummaryReport } from "./report-tools";
import { downloadOcrDocx } from "./ocr-export";
import { displayExcelRange } from "./excel-location";

type CorpusRecord = {
  id: string;
  document_id: string;
  document_type: string;
  document_type_id?: string;
  file_name: string;
  source_kind: "pdf" | "excel" | "word";
  page?: number;
  page_count?: number;
  context_pages?: { from: number; to: number } | null;
  context_mode?: "section" | "cluster";
  sheet?: string;
  range?: string;
  excel_range_is_absolute?: boolean;
  section?: string;
  title: string;
  body: string;
  text_available: boolean;
  ocr_status: "not_needed" | "pending" | "complete";
  ocr_confidence?: number;
  ocr_review_required?: boolean;
  external_source?: "kds";
  external_url?: string;
  kds_code?: string;
  kds_version?: string;
  kds_updated_at?: string;
};

type DocumentInfo = {
  id: string;
  display_name: string;
  type: string;
  type_id?: string;
  source_kind: "pdf" | "excel" | "word";
  page_count?: number;
  record_count?: number;
  text_pages?: number;
  ocr_pending_pages?: number;
  ocr_review_pages?: number;
};

type Manifest = {
  generated_at: string;
  privacy: string;
  workspace_title?: string;
  documents: DocumentInfo[];
  document_types?: DocumentTypeDefinition[];
  record_count: number;
  text_record_count: number;
  ocr_pending_record_count: number;
  ocr?: { engine: string; dpi: number; completed_pages: number; remaining_pages: number; updated_at: string };
};

type SearchHit = {
  record: CorpusRecord;
  score: number;
  rawScore: number;
  snippet: string;
  matchedTerms: string[];
  reasons: { label: string; value: number; strong?: boolean }[];
  bm25fRaw?: number;
  scoreCap?: number;
};

type SearchMode = "and" | "or";
type DocumentTypeStat = DocumentTypeDefinition & {
  count: number;
  totalCount: number;
  children: DocumentTypeStat[];
};

const RESULTS_PER_PAGE = 10;

const EXPANSIONS: Record<string, string[]> = {
  "부가가치세": ["vat", "value added tax", "value-added tax", "value added tax (vat)", "goods and services tax", "gst"],
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
  "시추공": ["borehole", "boreholes", "boring", "borings"],
  "깊이": ["depth", "deep"],
  "기준": ["criteria", "requirements", "minimum"],
  "가능": ["allowed", "permitted", "acceptable", "eligible", "may be", "can be"],
  "허용": ["allow", "allowed", "permitted", "permission", "tolerance"],
  "조건": ["condition", "conditions", "requirement", "requirements", "provision", "criteria"],
  "여부": ["whether", "applicable", "included", "required"],
  "포함": ["include", "included", "including", "inclusive"],
  "제외": ["exclude", "excluded", "excluding", "exception"],
  "요구": ["require", "required", "requirement", "requirements"],
  "필요": ["required", "necessary", "shall", "must"],
  "금지": ["prohibited", "not allowed", "shall not", "forbidden"],
  "최소": ["minimum", "at least", "not less than"],
  "최대": ["maximum", "not more than", "not exceed"],
  "책임": ["responsibility", "responsible", "liability", "liable", "obligation"],
  "발주처": ["employer", "owner", "client"],
  "시공자": ["contractor", "builder"],
  "계약자": ["contractor", "contracting party"],
  "계약": ["contract", "agreement", "contractual"],
  "입찰": ["bid", "bidding", "tender"],
  "질의": ["query", "clarification", "question"],
  "답변": ["response", "reply", "answer"],
  "비용": ["cost", "expense", "payment"],
  "지급": ["payment", "pay", "paid", "disbursement"],
  "보상": ["compensation", "reimbursement", "indemnity"],
  "승인": ["approval", "approved", "consent"],
  "허가": ["permit", "permission", "approval", "license"],
  "보험": ["insurance", "insured", "policy"],
  "보증": ["security", "bond", "guarantee", "warranty"],
  "공정": ["schedule", "programme", "progress"],
  "완료": ["completion", "complete", "completed"],
  "지연": ["delay", "delayed", "extension of time"],
  "공사": ["construction", "works"],
  "설계": ["design", "engineering"],
  "변경": ["change", "variation", "modification"],
  "제출": ["submit", "submission", "provide"],
  "기한": ["deadline", "period", "time limit", "due date"],
  "안전": ["safety", "safe", "health and safety"],
  "품질": ["quality", "quality control", "quality assurance"],
  "시험": ["test", "testing", "laboratory"],
  "강도": ["strength"],
  "실시": ["perform", "performed", "conduct", "conducted", "carry out"],
  "검사": ["inspection", "inspect", "testing"],
  "규격": ["standard", "specification", "requirements"],
  "법률": ["law", "legislation", "regulation"],
  "현지": ["local", "domestic", "in-country"],
  "국제": ["international", "global"],
  "완화": ["mitigation", "reduce", "control", "remedial"],
  "도로": ["road", "highway", "expressway"],
  "교통": ["traffic", "transportation", "traffic management"],
  "배수": ["drainage", "drain", "dewatering"],
  "수문": ["hydrology", "hydraulic", "water resources"],
  "토공": ["earthwork", "earthworks", "embankment"],
  "굴착": ["excavation", "excavate", "cutting"],
  "되메우기": ["backfill", "backfilling"],
  "콘크리트": ["concrete"],
  "철근": ["reinforcement", "rebar", "reinforcing steel"],
  "강재": ["steel", "structural steel"],
  "옹벽": ["retaining wall"],
  "지진": ["seismic", "earthquake"],
  "풍하중": ["wind load", "wind loading"],
  "하중": ["load", "loading", "design load"],
  "구조": ["structure", "structural"],
  "환경영향": ["environmental impact", "environmental assessment"],
  "소음": ["noise", "acoustic"],
  "진동": ["vibration", "vibratory"],
  "폐기물": ["waste", "disposal"],
  "강우": ["rainfall", "precipitation", "rainy season"],
  "조수": ["tide", "tidal"],
  "토질": ["soil", "geotechnical"],
  "지반": ["ground", "soil", "geotechnical"],
  "심도": ["depth", "deep"],
  "부지": ["site", "land", "project area"],
  "접근": ["access", "entry", "right of way"],
  "적용": ["apply", "applicable", "application"],
  "면제": ["exemption", "waiver", "exempt"],
};

const PHRASE_CONCEPTS: Record<string, string[]> = {
  "요구 조건": ["require", "required", "requirement", "requirements", "condition", "conditions", "criteria", "shall", "must"],
  "필요 조건": ["required", "necessary", "requirement", "requirements", "condition", "conditions", "criteria", "shall", "must"],
  "가능 조건": ["allow", "allowed", "permitted", "acceptable", "eligible", "condition", "conditions", "criteria", "may", "can"],
  "포함 여부": ["include", "included", "including", "inclusive", "exclude", "excluded", "excluding", "exclusive", "whether", "subject to", "net of"],
};

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are",
  "what", "when", "where", "which", "who", "how", "please", "find", "show", "tell", "should",
  "을", "를", "이", "가", "은", "는", "에", "의", "와", "과", "에서", "대한", "관련",
  "내용", "조항", "찾아줘", "알려줘", "경우", "언제", "어디서", "무엇", "어떤", "왜", "어떻게", "하나요", "인가요",
]);

function normalize(value: string) {
  return value.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
}

function tokenize(value: string) {
  const matches = normalize(value).match(/[a-z][a-z0-9'-]{1,}|[가-힣]{2,}|\d+(?:\.\d+)+/g) ?? [];
  return matches.filter((term) => !STOPWORDS.has(term));
}

function termMatchesAt(text: string, term: string, position: number) {
  if (!/[a-z0-9]/.test(term)) return true;
  const before = position > 0 ? text[position - 1] : "";
  const after = position + term.length < text.length ? text[position + term.length] : "";
  const needsLeftBoundary = /^[a-z0-9]/.test(term);
  const needsRightBoundary = /[a-z0-9]$/.test(term);
  return (!needsLeftBoundary || !/[a-z0-9]/.test(before)) && (!needsRightBoundary || !/[a-z0-9]/.test(after));
}

export function isSentenceQuery(query: string) {
  const normalized = normalize(query);
  const lexicalTerms = normalized.match(/[a-z][a-z0-9'-]{1,}|[가-힣]{2,}|\d+(?:\.\d+)+/g) ?? [];
  return /[?.!？。]/.test(query)
    || lexicalTerms.length >= 5
    || (lexicalTerms.length >= 3 && /(?:나요|까요|습니까|인가요|해줘|해주세요|알려줘|찾아줘)\s*$/.test(normalized));
}

function termPositions(text: string, term: string, limit = Number.POSITIVE_INFINITY) {
  if (!term) return [];
  const positions: number[] = [];
  let cursor = 0;
  while (positions.length < limit) {
    const position = text.indexOf(term, cursor);
    if (position < 0) break;
    if (termMatchesAt(text, term, position)) positions.push(position);
    cursor = position + Math.max(term.length, 1);
  }
  return positions;
}

function containsTerm(text: string, term: string) {
  return termPositions(text, term, 1).length > 0;
}

function countOccurrences(text: string, term: string) {
  return termPositions(text, term).length;
}

type QueryConceptGroup = { label: string; terms: string[] };

function buildRequiredConceptGroups(query: string): QueryConceptGroup[] {
  const normalized = normalize(query);
  const phraseMatches = Object.entries(PHRASE_CONCEPTS)
    .filter(([phrase]) => normalized.includes(phrase))
    .sort(([left], [right]) => right.length - left.length)
    .filter(([phrase], index, matches) => !matches.slice(0, index).some(([selected]) => selected.includes(phrase)));
  const coveredPhrases = phraseMatches.map(([phrase]) => phrase);
  const expansionMatches = Object.entries(EXPANSIONS)
    .filter(([korean]) => normalized.includes(korean))
    .filter(([korean]) => !coveredPhrases.some((phrase) => phrase.includes(korean)));
  const coveredLabels = [...coveredPhrases, ...expansionMatches.map(([korean]) => korean)];
  const groups: QueryConceptGroup[] = [
    ...phraseMatches.map(([phrase, aliases]) => ({ label: phrase, terms: [phrase, ...tokenize(phrase), ...aliases] })),
    ...expansionMatches.map(([korean, aliases]) => ({ label: korean, terms: [korean, ...aliases] })),
  ];
  tokenize(normalized).forEach((term) => {
    if (coveredLabels.some((label) => label.includes(term) || term.includes(label))) return;
    groups.push({ label: term, terms: [term] });
  });
  const signatures = new Set<string>();
  return groups.map((group) => ({
    label: group.label,
    terms: [...new Set(group.terms.map(normalize).filter((term) => term.length >= 2))],
  })).filter((group) => {
    const signature = group.terms.slice().sort().join("|");
    if (!signature || signatures.has(signature)) return false;
    signatures.add(signature);
    return true;
  });
}

function expandQuery(query: string) {
  const normalized = normalize(query);
  const originalTerms = tokenize(normalized);
  const requiredConceptGroups = buildRequiredConceptGroups(query);
  const expandedPhrases = requiredConceptGroups.flatMap((group) => group.terms)
    .filter((term) => !originalTerms.includes(term));
  const expandedTerms = expandedPhrases.flatMap(tokenize);
  const conceptGroups = requiredConceptGroups.map((group) => ({
    korean: group.label,
    english: group.terms.filter((term) => /[a-z]/.test(term)),
  }));
  return {
    normalized,
    originalTerms: [...new Set(originalTerms)],
    expandedPhrases: [...new Set(expandedPhrases)],
    expandedTerms: [...new Set(expandedTerms.filter((term) => !originalTerms.includes(term)))],
    conceptGroups,
    requiredConceptGroups,
    sentenceMode: isSentenceQuery(query),
  };
}

function minimumRequiredConceptMatches(
  requiredConceptCount: number,
  searchMode: SearchMode,
  sentenceMode: boolean,
) {
  if (sentenceMode) return Math.max(1, Math.ceil(requiredConceptCount * .5));
  return searchMode === "and" ? requiredConceptCount : 1;
}

function makeSnippet(body: string, terms: string[]) {
  const compact = body.replace(/\s+/g, " ").trim();
  if (!compact) return "텍스트 레이어가 없어 OCR 처리가 필요한 페이지입니다.";
  const lower = compact.toLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
  const center = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, center - 120);
  const end = Math.min(compact.length, start + 520);
  return (start ? "…" : "") + compact.slice(start, end) + (end < compact.length ? "…" : "");
}

const NAVIGATION_HEADING_PATTERN = /(?:table of contents|\breferences\b|bibliography|(?:subject|alphabetical) index|list of (?:figures|tables|drawings|appendices)|목차|참고문헌|색인|표 목록|그림 목록)/i;
const NAVIGATION_PREFIX_PATTERN = /^(?:page\s+\d+\s+|[\divx().-]+\s+)?(?:table of contents|references|bibliography|(?:subject|alphabetical) index|list of (?:figures|tables|drawings|appendices)|목차|참고문헌|색인|표 목록|그림 목록)\b/i;
const NORMATIVE_PATTERN = /\b(?:shall|must|required|requirement|requirements|should|prohibited|not permitted|minimum|maximum|at least|not less than|not more than)\b|하여야|해야|필수|금지|허용되지|최소|최대|이상|이하/g;
const DETAIL_PATTERN = /\b(?:astm|aashto|iso|en|aci|bs|dpwh)\s*[a-z-]*\s*\d+[a-z0-9.-]*\b|\b\d+(?:\.\d+)?\s*(?:%|mm|cm|m|km|m²|m2|m³|m3|mpa|kpa|kn|kg|ton|tons|day|days|hour|hours|year|years)\b/gi;

function positionsForTerms(text: string, terms: string[]) {
  return [...new Set(terms.flatMap((term) => termPositions(text, term, 20)))]
    .sort((left, right) => left - right);
}

function minimumConceptSpan(groupPositions: number[][]) {
  if (!groupPositions.length || groupPositions.some((positions) => positions.length === 0)) return Number.POSITIVE_INFINITY;
  if (groupPositions.length === 1) return 0;
  const points = groupPositions.flatMap((positions, groupIndex) => positions.map((position) => ({ position, groupIndex })))
    .sort((left, right) => left.position - right.position);
  const counts = Array(groupPositions.length).fill(0) as number[];
  let covered = 0;
  let left = 0;
  let minimum = Number.POSITIVE_INFINITY;
  for (let right = 0; right < points.length; right += 1) {
    if (counts[points[right].groupIndex] === 0) covered += 1;
    counts[points[right].groupIndex] += 1;
    while (covered === groupPositions.length) {
      minimum = Math.min(minimum, points[right].position - points[left].position);
      counts[points[left].groupIndex] -= 1;
      if (counts[points[left].groupIndex] === 0) covered -= 1;
      left += 1;
    }
  }
  return minimum;
}

type Bm25fField = "title" | "section" | "file_name" | "document_type" | "body";
type Bm25fCorpusStats = {
  documentCount: number;
  averageFieldLengths: Record<Bm25fField, number>;
  documentFrequency: Map<string, number>;
};

const BM25F_FIELDS: { name: Bm25fField; weight: number; lengthNormalization: number }[] = [
  { name: "title", weight: 3, lengthNormalization: .2 },
  { name: "section", weight: 2.2, lengthNormalization: .25 },
  { name: "file_name", weight: 1.4, lengthNormalization: .2 },
  { name: "document_type", weight: 1.2, lengthNormalization: .2 },
  { name: "body", weight: 1, lengthNormalization: .75 },
];

function bm25fFieldText(record: CorpusRecord, field: Bm25fField) {
  return normalize(record[field] ?? "");
}

export function buildBm25fCorpusStats(records: CorpusRecord[], query: string): Bm25fCorpusStats {
  const terms = [...new Set(buildRequiredConceptGroups(query).flatMap((group) => group.terms))];
  const fieldLengthTotals = Object.fromEntries(BM25F_FIELDS.map(({ name }) => [name, 0])) as Record<Bm25fField, number>;
  const documentFrequency = new Map(terms.map((term) => [term, 0]));
  for (const record of records) {
    const fields = Object.fromEntries(BM25F_FIELDS.map(({ name }) => {
      const text = bm25fFieldText(record, name);
      fieldLengthTotals[name] += Math.max(1, tokenize(text).length);
      return [name, text];
    })) as Record<Bm25fField, string>;
    for (const term of terms) {
      if (BM25F_FIELDS.some(({ name }) => containsTerm(fields[name], term))) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
  }
  const documentCount = Math.max(1, records.length);
  return {
    documentCount,
    averageFieldLengths: Object.fromEntries(BM25F_FIELDS.map(({ name }) => [name, Math.max(1, fieldLengthTotals[name] / documentCount)])) as Record<Bm25fField, number>,
    documentFrequency,
  };
}

function bm25fScore(record: CorpusRecord, groups: QueryConceptGroup[], stats: Bm25fCorpusStats) {
  const k1 = 1.2;
  const fields = Object.fromEntries(BM25F_FIELDS.map(({ name }) => [name, bm25fFieldText(record, name)])) as Record<Bm25fField, string>;
  const lengths = Object.fromEntries(BM25F_FIELDS.map(({ name }) => [name, Math.max(1, tokenize(fields[name]).length)])) as Record<Bm25fField, number>;
  return groups.reduce((total, group) => {
    const bestAliasScore = group.terms.reduce((best, term) => {
      const weightedFrequency = BM25F_FIELDS.reduce((sum, { name, weight, lengthNormalization }) => {
        const frequency = countOccurrences(fields[name], term);
        const lengthFactor = 1 - lengthNormalization + lengthNormalization * lengths[name] / stats.averageFieldLengths[name];
        return sum + weight * frequency / Math.max(.1, lengthFactor);
      }, 0);
      if (!weightedFrequency) return best;
      const documentFrequency = stats.documentFrequency.get(term) ?? 0;
      const inverseDocumentFrequency = Math.log(1 + (stats.documentCount - documentFrequency + .5) / (documentFrequency + .5));
      const score = inverseDocumentFrequency * ((k1 + 1) * weightedFrequency) / (k1 + weightedFrequency);
      return Math.max(best, score);
    }, 0);
    return total + bestAliasScore;
  }, 0);
}

export function scoreRecord(record: CorpusRecord, query: string, searchMode: SearchMode = "and", bm25fStats?: Bm25fCorpusStats): SearchHit | null {
  const expanded = expandQuery(query);
  if (!expanded.normalized) return null;
  const title = normalize(record.title ?? "");
  const section = normalize(record.section ?? "");
  const body = normalize(record.body ?? "");
  const searchableText = [title, section, body].join(" ");
  const requiredConceptMatches = expanded.requiredConceptGroups.map((group) => ({
    group,
    matchedTerms: group.terms.filter((term) => containsTerm(searchableText, term)),
  }));
  if (!requiredConceptMatches.length) return null;
  const matchedConceptCount = requiredConceptMatches.filter((match) => match.matchedTerms.length > 0).length;
  const minimumConceptMatches = minimumRequiredConceptMatches(
    requiredConceptMatches.length,
    searchMode,
    expanded.sentenceMode,
  );
  if (matchedConceptCount < minimumConceptMatches) return null;
  const allTerms = [...new Set([...expanded.originalTerms, ...expanded.expandedTerms])];
  const bodyCounts = Object.fromEntries(allTerms.map((term) => [term, countOccurrences(body, term)]));
  const groupBodyPositions = expanded.requiredConceptGroups.map((group) => positionsForTerms(body, group.terms));
  const bodyMatchedGroups = groupBodyPositions.filter((positions) => positions.length > 0).length;
  const bodyCoverage = bodyMatchedGroups / expanded.requiredConceptGroups.length;
  const titleMatchedGroups = expanded.requiredConceptGroups.filter((group) => group.terms.some((term) => containsTerm(title, term))).length;
  const sectionMatchedGroups = expanded.requiredConceptGroups.filter((group) => group.terms.some((term) => containsTerm(section, term))).length;
  const exactTitlePhrase = expanded.normalized.length >= 3 && title.includes(expanded.normalized);
  const exactBodyPhrase = expanded.normalized.length >= 3 && body.includes(expanded.normalized);
  const expandedTitlePhrases = expanded.expandedPhrases.filter((phrase) => phrase.includes(" ") && containsTerm(title, phrase));
  const expandedBodyPhrases = expanded.expandedPhrases.filter((phrase) => phrase.includes(" ") && containsTerm(body, phrase));
  const titleCoverage = titleMatchedGroups / expanded.requiredConceptGroups.length;
  const sectionCoverage = sectionMatchedGroups / expanded.requiredConceptGroups.length;
  const titlePoints = Math.min(24, (titleCoverage === 1 ? 14 : titleCoverage * 10) + (exactTitlePhrase ? 10 : 0) + Math.min(4, expandedTitlePhrases.length * 2));
  const sectionPoints = Math.min(5, sectionCoverage * 5);
  const phrasePoints = Math.min(12, (exactBodyPhrase ? (expanded.originalTerms.length > 1 ? 10 : 5) : 0) + expandedBodyPhrases.length * 3);
  const conceptPoints = 4 + bodyCoverage * 10;
  const matchedGroupBodyPositions = groupBodyPositions.filter((positions) => positions.length > 0);
  const conceptSpan = minimumConceptSpan(expanded.sentenceMode ? matchedGroupBodyPositions : groupBodyPositions);
  const sufficientBodyCoverage = bodyMatchedGroups >= minimumConceptMatches;
  const proximityPoints = !sufficientBodyCoverage ? 0 : matchedGroupBodyPositions.length === 1 ? 7 : conceptSpan <= 80 ? 18 : conceptSpan <= 180 ? 14 : conceptSpan <= 400 ? 9 : conceptSpan <= 800 ? 5 : 2;
  const totalFrequency = allTerms.reduce((sum, term) => sum + (bodyCounts[term] ?? 0), 0);
  const frequencyPoints = Math.min(8, Math.log1p(totalFrequency) * 2.4);
  const contextPositions = groupBodyPositions.flat().slice(0, 16);
  const localContext = contextPositions.map((position) => body.slice(Math.max(0, position - 180), Math.min(body.length, position + 320))).join(" ");
  const normativeMatches = localContext.match(NORMATIVE_PATTERN)?.length ?? 0;
  const detailMatches = localContext.match(DETAIL_PATTERN)?.length ?? 0;
  const normativePoints = normativeMatches ? Math.min(12, 5 + normativeMatches * 2) : 0;
  const detailPoints = Math.min(8, detailMatches * 2);
  const substancePoints = localContext.length >= 180 ? 4 : localContext.length >= 80 ? 2 : 0;
  const clauseBonus = titlePoints >= 10 && /(?:clause|section|subsection|part|item|\d+(?:\.\d+)+)/i.test(record.title) ? 4 : 0;
  const uncappedScore = Math.round(titlePoints + sectionPoints + phrasePoints + conceptPoints + proximityPoints + frequencyPoints + normativePoints + detailPoints + substancePoints + clauseBonus);
  if (uncappedScore < 4) return null;
  const navigationQueryRequested = NAVIGATION_HEADING_PATTERN.test(expanded.normalized);
  const navigationRecord = (NAVIGATION_HEADING_PATTERN.test(`${title} ${section}`) || NAVIGATION_PREFIX_PATTERN.test(body.slice(0, 240))) && !navigationQueryRequested;
  let score = Math.min(100, uncappedScore);
  if (!sufficientBodyCoverage) score = Math.min(score, 42);
  if (score >= 85 && !(titlePoints >= 16 && proximityPoints >= 7 && frequencyPoints >= 4 && (normativePoints >= 5 || detailPoints >= 4))) score = 84;
  if (navigationRecord) score = Math.min(18, Math.max(10, Math.round(score * .22)));
  const rawScore = score;
  const scoreCap = navigationRecord ? 18 : !sufficientBodyCoverage ? 42 : undefined;
  const bm25fRaw = bm25fStats ? bm25fScore(record, expanded.requiredConceptGroups, bm25fStats) : undefined;
  const matchedTerms = allTerms.filter((term) => containsTerm(title, term) || containsTerm(section, term) || (bodyCounts[term] ?? 0) > 0);
  const reasons = [
    { label: navigationRecord ? "목차·참고문헌 감점" : "Clause 제목", value: Math.round(navigationRecord ? score : titlePoints), strong: !navigationRecord && titlePoints >= 16 },
    { label: "문구·근접 문맥", value: Math.round(sectionPoints + phrasePoints + proximityPoints + clauseBonus), strong: proximityPoints >= 14 },
    { label: `${expanded.sentenceMode ? "문장 핵심" : searchMode.toUpperCase()} 개념 ${matchedConceptCount}/${requiredConceptMatches.length}`, value: Math.round(conceptPoints), strong: matchedConceptCount >= minimumConceptMatches },
    { label: "요구·수치 문맥", value: Math.round(normativePoints + detailPoints + substancePoints), strong: normativePoints >= 5 || detailPoints >= 4 },
    { label: "본문 용어 " + totalFrequency + "회", value: Math.round(frequencyPoints) },
  ].filter((reason) => reason.value > 0);
  return { record, score, rawScore, snippet: makeSnippet(record.body, matchedTerms), matchedTerms, reasons, bm25fRaw, scoreCap };
}

export function scoreRecords(records: CorpusRecord[], query: string, searchMode: SearchMode = "and") {
  const stats = buildBm25fCorpusStats(records, query);
  const hits = records.map((record) => scoreRecord(record, query, searchMode, stats))
    .filter((hit): hit is SearchHit => Boolean(hit));
  const maximumBm25f = Math.max(...hits.map((hit) => hit.bm25fRaw ?? 0), 0);
  return hits.map((hit) => {
    const bm25fPercent = maximumBm25f > 0 ? 100 * Math.log1p(hit.bm25fRaw ?? 0) / Math.log1p(maximumBm25f) : 0;
    const hybridScore = Math.round(hit.score * .4 + bm25fPercent * .6);
    const score = Math.min(100, hit.scoreCap ?? 100, hybridScore);
    const bm25fPoints = Math.round(bm25fPercent * .6);
    return {
      ...hit,
      score,
      rawScore: score + (hit.bm25fRaw ?? 0) / 1000,
      reasons: [{ label: "BM25F 필드·희소도", value: bm25fPoints, strong: bm25fPercent >= 80 }, ...hit.reasons],
    };
  });
}

type PdfHeading = {
  documentId: string;
  record: CorpusRecord;
  kind: "ITEM" | "CHAPTER" | "SECTION" | "PART" | "NUMBERED";
  identifier: string;
  heading: string;
  page: number;
  position: number;
  depth: number;
};

const MAJOR_HEADING_PATTERN = /\b(ITEM|CHAPTER|SECTION|PART)\s+([A-Z0-9.()-]+)\s*(?:[-–—:]\s*)?([A-Za-z][A-Za-z0-9 ,/&()'-]{2,100}?)(?=\s+(?:Refer\b|This\b|The\b|A\b|An\b|Contractor\b|Engineer\b|When\b|Where\b|\d{1,4}(?:\.\d+){1,5}\b|ITEM\b|CHAPTER\b|SECTION\b|PART\b)|$)/gi;
const NUMBERED_HEADING_PATTERN = /\b(\d{1,4}(?:\.\d+){1,5})\s+([A-Z][A-Za-z0-9/&()'-]*(?:\s+(?:[A-Z][A-Za-z0-9/&()'-]*|of|and|for|to|the|in|on|or)){0,9})(?=\s+(?:This\b|The\b|A\b|An\b|Contractor\b|Engineer\b|When\b|Where\b|In\b|For\b|\d{1,4}(?:\.\d+){1,5}\b|ITEM\b|CHAPTER\b|SECTION\b|PART\b)|$)/g;

function extractPdfHeadings(record: CorpusRecord): PdfHeading[] {
  if (record.source_kind !== "pdf" || !record.page || !record.body) return [];
  const titleAndSection = `${normalize(record.title)} ${normalize(record.section ?? "")}`;
  if (NAVIGATION_HEADING_PATTERN.test(titleAndSection) || NAVIGATION_PREFIX_PATTERN.test(normalize(record.body).slice(0, 240))) return [];
  const text = record.body.replace(/\s+/g, " ").trim();
  const headings: PdfHeading[] = [];
  for (const match of text.matchAll(MAJOR_HEADING_PATTERN)) {
    const kind = match[1].toUpperCase() as PdfHeading["kind"];
    const identifier = match[2].replace(/[().]/g, "");
    if (kind === "ITEM" && !/^\d+[A-Z]?(?:\.\d+)*$/i.test(identifier)) continue;
    if (kind !== "ITEM" && !/^(?:\d+(?:\.\d+)*|[IVXLC]+|[A-Z])$/i.test(identifier)) continue;
    const subject = match[3].replace(/\s+/g, " ").trim().replace(/\s+[A-Z]$/, "");
    headings.push({ documentId: record.document_id, record, kind, identifier, heading: `${kind} ${match[2]} – ${subject}`, page: record.page, position: match.index ?? 0, depth: 1 });
  }
  for (const match of text.matchAll(NUMBERED_HEADING_PATTERN)) {
    const identifier = match[1];
    if (headings.some((heading) => heading.position <= (match.index ?? 0) && (match.index ?? 0) < heading.position + heading.heading.length)) continue;
    headings.push({ documentId: record.document_id, record, kind: "NUMBERED", identifier, heading: `${identifier} ${match[2].trim()}`, page: record.page, position: match.index ?? 0, depth: identifier.split(".").length });
  }
  return headings.sort((left, right) => left.position - right.position);
}

function headingMatchesQuery(heading: PdfHeading, query: string, searchMode: SearchMode) {
  const expanded = expandQuery(query);
  const headingText = normalize(heading.heading);
  const matches = expanded.requiredConceptGroups.map((group) => group.terms.some((term) => containsTerm(headingText, term)));
  const required = minimumRequiredConceptMatches(matches.length, searchMode, expanded.sentenceMode);
  return matches.filter(Boolean).length >= required;
}

function headingScopeEnd(heading: PdfHeading, headings: PdfHeading[], documentRecords: CorpusRecord[]) {
  const later = headings.filter((candidate) => candidate.documentId === heading.documentId && (candidate.page > heading.page || (candidate.page === heading.page && candidate.position > heading.position)));
  const next = heading.kind === "NUMBERED"
    ? later.find((candidate) => candidate.kind === "NUMBERED" && candidate.depth <= heading.depth && candidate.identifier !== heading.identifier)
    : later.find((candidate) => candidate.kind === heading.kind && candidate.identifier !== heading.identifier);
  const lastPage = Math.max(...documentRecords.map((record) => record.page ?? 0), heading.page);
  if (!next) return lastPage;
  if (next.page === heading.page) return heading.page;
  const nextRecordLength = Math.max(1, next.record.body.length);
  return Math.max(heading.page, next.position > nextRecordLength * .25 ? next.page : next.page - 1);
}

function groupDirectPdfHits(records: CorpusRecord[], hits: SearchHit[]) {
  const fixed = hits.filter((hit) => hit.record.source_kind !== "pdf" || hit.record.context_mode === "section");
  const pdfHits = hits.filter((hit) => hit.record.source_kind === "pdf" && hit.record.context_mode !== "section");
  const byDocument = new Map<string, SearchHit[]>();
  for (const hit of pdfHits) byDocument.set(hit.record.document_id, [...(byDocument.get(hit.record.document_id) ?? []), hit]);
  for (const [documentId, documentHits] of byDocument) {
    const ordered = documentHits.slice().sort((left, right) => (left.record.page ?? 0) - (right.record.page ?? 0));
    const clusters: SearchHit[][] = [];
    for (const hit of ordered) {
      const current = clusters.at(-1);
      if (current && (hit.record.page ?? 0) <= (current.at(-1)?.record.page ?? 0) + 2) current.push(hit); else clusters.push([hit]);
    }
    const documentRecords = records.filter((record) => record.document_id === documentId && record.source_kind === "pdf");
    const lastPage = Math.max(...documentRecords.map((record) => record.page_count ?? record.page ?? 0), 1);
    for (const cluster of clusters) {
      if (cluster.length === 1) {
        fixed.push(cluster[0]);
        continue;
      }
      const best = cluster.reduce((current, candidate) => candidate.rawScore > current.rawScore ? candidate : current);
      const matchedFrom = Math.min(...cluster.map((hit) => hit.record.page ?? 1));
      const matchedTo = Math.max(...cluster.map((hit) => hit.record.page ?? matchedFrom));
      const from = Math.max(1, matchedFrom - 1);
      const to = Math.min(lastPage, matchedTo + 1);
      fixed.push({ ...best, record: { ...best.record, id: `${best.record.id}-cluster-${from}-${to}`, context_pages: { from, to }, context_mode: "cluster" } });
    }
  }
  return fixed;
}

export function applyPdfContextScopes(records: CorpusRecord[], directHits: SearchHit[], query: string, searchMode: SearchMode = "and") {
  const pdfRecords = records.filter((record) => record.source_kind === "pdf" && record.page).sort((left, right) => left.document_id.localeCompare(right.document_id) || (left.page ?? 0) - (right.page ?? 0));
  const headings = pdfRecords.flatMap(extractPdfHeadings);
  const seenHeadings = new Set<string>();
  const scopes = headings.filter((heading) => {
    const key = `${heading.documentId}:${heading.kind}:${heading.identifier}`;
    if (seenHeadings.has(key) || !headingMatchesQuery(heading, query, searchMode)) return false;
    seenHeadings.add(key);
    return true;
  }).map((heading) => {
    const documentRecords = pdfRecords.filter((record) => record.document_id === heading.documentId);
    return { heading, from: heading.page, to: headingScopeEnd(heading, headings, documentRecords) };
  }).sort((left, right) => left.heading.documentId.localeCompare(right.heading.documentId) || left.from - right.from || left.heading.depth - right.heading.depth)
    .filter((scope, index, all) => !all.slice(0, index).some((selected) => selected.heading.documentId === scope.heading.documentId && selected.from <= scope.from && selected.to >= scope.to));
  const coveredHitIds = new Set<string>();
  const scopeHits: SearchHit[] = [];
  for (const scope of scopes) {
    const covered = directHits.filter((hit) => hit.record.document_id === scope.heading.documentId && (hit.record.page ?? 0) >= scope.from && (hit.record.page ?? 0) <= scope.to);
    for (const hit of covered) coveredHitIds.add(hit.record.id);
    const anchor = covered.find((hit) => hit.record.id === scope.heading.record.id) ?? scoreRecord(scope.heading.record, query, searchMode);
    if (!anchor) continue;
    const scopeScore = Math.max(anchor.score, scope.heading.kind === "NUMBERED" ? 86 : 92);
    scopeHits.push({
      ...anchor,
      score: scopeScore,
      rawScore: scopeScore,
      snippet: `${scope.heading.heading} 제목이 적용되는 연속 범위입니다. 해당 제목 아래의 p. ${scope.from}–${scope.to} 전체를 함께 표시합니다.`,
      record: {
        ...scope.heading.record,
        id: `${scope.heading.record.id}-scope-${scope.heading.kind}-${scope.heading.identifier}`,
        title: scope.heading.heading,
        section: `${scope.heading.kind === "NUMBERED" ? "Clause" : scope.heading.kind} ${scope.heading.identifier}`,
        page: scope.from,
        context_pages: { from: scope.from, to: scope.to },
        context_mode: "section",
      },
    });
  }
  if (searchMode === "or") {
    // OR must remain a superset of AND. Keeping every direct page hit prevents
    // broader matches from being collapsed into fewer adjacent-page clusters.
    return [...directHits, ...scopeHits];
  }
  const remaining = directHits.filter((hit) => !coveredHitIds.has(hit.record.id));
  return groupDirectPdfHits(records, [...remaining, ...scopeHits]);
}

function locationLabel(record: CorpusRecord) {
  if (record.external_source === "kds") return record.kds_code ?? "KDS";
  if (record.source_kind === "pdf") {
    if (record.context_mode && record.context_pages) return `p. ${record.context_pages.from}–${record.context_pages.to}`;
    return "p. " + record.page;
  }
  if (record.source_kind === "word") return "문맥 구간 " + record.page;
  return record.sheet + "!" + displayExcelRange(record);
}

function pdfContextLabel(record: CorpusRecord) {
  const from = record.context_pages?.from ?? Math.max(1, (record.page ?? 1) - 1);
  const to = record.context_pages?.to ?? (record.page ?? 1) + 1;
  const count = Math.max(1, to - from + 1);
  if (record.context_mode === "section") return `제목 범위 ${count}페이지`;
  if (record.context_mode === "cluster") return `연속 관련 ${count}페이지`;
  return `${count}페이지 원문`;
}

function pdfContextDescription(record: CorpusRecord) {
  if (record.context_mode === "section") return " 관련 키워드가 포함된 제목부터 다음 같은 단계 제목 전까지의 모든 페이지를 표시합니다.";
  if (record.context_mode === "cluster") return " 연속해서 검색된 페이지와 그 범위의 앞·뒤 1페이지를 한 번에 표시합니다.";
  return " 본문에서 검색된 페이지와 앞·뒤 1페이지를 표시합니다. 문서 전체는 아래 ‘원본 전체 열기’를 이용하세요.";
}

function clauseReference(record: CorpusRecord) {
  const candidates = [record.section, record.title].filter((value): value is string => Boolean(value?.trim()));
  const patterns = [
    /(?:Chapter|Clause|Section|Subsection|Part|Item)\s+[A-Z0-9]+(?:[.\-][A-Z0-9]+)*/i,
    /제\s*\d+\s*(?:장|절|조)/,
    /\b[A-Z](?:\.\d+){1,6}\b/i,
    /\b\d+(?:[.\-]\d+){1,6}\b/,
  ];
  for (const candidate of candidates) {
    for (const pattern of patterns) {
      const match = candidate.match(pattern);
      if (match) return match[0];
    }
  }
  return "—";
}

function spreadsheetSafe(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  return /^[=+\-@]/.test(compact) ? `'${compact}` : compact;
}

type PendingUpload = { file: File; documentTypeId: string };
type CurrentUser = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
  mustChangePassword: boolean;
  quotaBytes: number;
  maxDocuments: number;
};
type ManagedUser = {
  id: string;
  username: string;
  display_name: string;
  role: "admin" | "user";
  active: number;
  must_change_password: number;
  archived_at: string | null;
  quota_bytes: number;
  max_documents: number;
  document_count: number;
  used_bytes: number;
};
type LegacyMigrationPreview = {
  connected: boolean;
  document_count: number;
  corpus_record_count: number;
  total_original_bytes: number;
  missing_original_count: number;
};
function formatStorage(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`;
}

export default function Home() {
  const [authState, setAuthState] = useState<"checking" | "bootstrap" | "anonymous" | "authenticated">("checking");
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [appVersion, setAppVersion] = useState(ANYSCOPE_VERSION);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [legacyPasscode, setLegacyPasscode] = useState("");
  const [authError, setAuthError] = useState("");
  const [authenticating, setAuthenticating] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordChange, setPasswordChange] = useState({ current: "", next: "", confirm: "" });
  const [passwordChangeError, setPasswordChangeError] = useState("");
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [records, setRecords] = useState<CorpusRecord[]>([]);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("and");
  const [searchedMode, setSearchedMode] = useState<SearchMode>("and");
  const [includeKds, setIncludeKds] = useState(true);
  const [searchedIncludeKds, setSearchedIncludeKds] = useState(true);
  const [kdsRecords, setKdsRecords] = useState<CorpusRecord[]>([]);
  const [kdsSearching, setKdsSearching] = useState(false);
  const [kdsError, setKdsError] = useState("");
  const [activeTypeIds, setActiveTypeIds] = useState(new Set<string>());
  const [minScore, setMinScore] = useState(30);
  const [sort, setSort] = useState("score");
  const [currentPage, setCurrentPage] = useState(1);
  const [scoreHelpOpen, setScoreHelpOpen] = useState(false);
  const [ocrHelpOpen, setOcrHelpOpen] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [viewer, setViewer] = useState<CorpusRecord | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportGenerated, setReportGenerated] = useState(false);
  const [reportDownloading, setReportDownloading] = useState(false);
  const [reportGenerating, setReportGenerating] = useState(false);
  const [reportError, setReportError] = useState("");
  const [reportLanguage, setReportLanguage] = useState<"ko" | "en">("ko");
  const [aiReport, setAiReport] = useState<AiSummaryReport | null>(null);
  const [uploadNotice, setUploadNotice] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [newTypeName, setNewTypeName] = useState("");
  const [newTypeParentId, setNewTypeParentId] = useState("");
  const [savingDocumentTypes, setSavingDocumentTypes] = useState(false);
  const [workspaceTitleDraft, setWorkspaceTitleDraft] = useState(DEFAULT_WORKSPACE_TITLE);
  const [savingWorkspaceTitle, setSavingWorkspaceTitle] = useState(false);
  const [documentManagerOpen, setDocumentManagerOpen] = useState(false);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState(new Set<string>());
  const [documentAction, setDocumentAction] = useState<"docx" | "xlsx" | null>(null);
  const [documentActionNotice, setDocumentActionNotice] = useState("");
  const [deletingDocuments, setDeletingDocuments] = useState(false);
  const [ocrProcessing, setOcrProcessing] = useState(false);
  const [ocrProgress, setOcrProgress] = useState("");
  const [ocrStopRequested, setOcrStopRequested] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [managedUsers, setManagedUsers] = useState<ManagedUser[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminNotice, setAdminNotice] = useState("");
  const [appVersionDraft, setAppVersionDraft] = useState(ANYSCOPE_VERSION);
  const [newUser, setNewUser] = useState({ username: "", displayName: "", password: "", quotaGb: "5", maxDocuments: "500" });
  const [legacyPreview, setLegacyPreview] = useState<LegacyMigrationPreview | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const ocrCancelRef = useRef(false);

  async function loadCorpus() {
    setLoadError("");
    const [nextManifest, nextRecords] = await Promise.all([
      fetch("/api/manifest").then((response) => {
        if (!response.ok) throw new Error("문서 현황을 불러오지 못했습니다.");
        return response.json() as Promise<Manifest>;
      }),
      fetch("/api/corpus").then(async (response) => {
        if (!response.ok) throw new Error("검색 인덱스를 불러오지 못했습니다.");
        const text = await response.text();
        return text.split(String.fromCharCode(10)).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as CorpusRecord);
      }),
    ]);
    setManifest(nextManifest);
    setWorkspaceTitleDraft(nextManifest.workspace_title || DEFAULT_WORKSPACE_TITLE);
    setRecords(nextRecords);
    const nextTypes = normalizeDocumentTypes(nextManifest.document_types, nextManifest.documents);
    setActiveTypeIds(new Set(nextTypes.map((type) => type.id)));
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/status", { cache: "no-store" })
      .then((response) => response.json() as Promise<{ authenticated?: boolean; bootstrap_required?: boolean; user?: CurrentUser; app_version?: string }>)
      .then(async (status) => {
        if (cancelled) return;
        if (status.app_version) {
          setAppVersion(status.app_version);
          setAppVersionDraft(status.app_version);
        }
        if (!status.authenticated) {
          setAuthState(status.bootstrap_required ? "bootstrap" : "anonymous");
          return;
        }
        setCurrentUser(status.user ?? null);
        setAuthState("authenticated");
        if (!status.user?.mustChangePassword) await loadCorpus();
      })
      .catch(() => {
        if (!cancelled) setAuthState("anonymous");
      });
    return () => { cancelled = true; };
  }, []);

  const documentTypes = useMemo(
    () => normalizeDocumentTypes(manifest?.document_types, manifest?.documents),
    [manifest],
  );
  const documentTypeById = useMemo(
    () => new Map(documentTypes.map((type) => [type.id, type])),
    [documentTypes],
  );
  const typeStats = useMemo(() => {
    const directCounts = new Map(documentTypes.map((type) => [type.id, 0]));
    for (const document of manifest?.documents ?? []) {
      const typeId = resolveDocumentTypeId(document, documentTypes);
      directCounts.set(typeId, (directCounts.get(typeId) ?? 0) + 1);
    }
    const buildStat = (type: DocumentTypeDefinition): DocumentTypeStat => {
      const children = documentTypes
        .filter((candidate) => candidate.parent_id === type.id)
        .map(buildStat);
      const count = directCounts.get(type.id) ?? 0;
      return {
        ...type,
        count,
        totalCount: count + children.reduce((sum, child) => sum + child.totalCount, 0),
        children,
      };
    };
    return documentTypes.filter((type) => !type.parent_id).map(buildStat);
  }, [manifest, documentTypes]);
  const ocrPendingByDocument = useMemo(() => {
    const counts = new Map<string, number>();
    for (const record of records) {
      if (record.source_kind !== "pdf" || record.ocr_status !== "pending" || !record.page) continue;
      counts.set(record.document_id, (counts.get(record.document_id) ?? 0) + 1);
    }
    return counts;
  }, [records]);
  const totalOcrPendingPages = useMemo(
    () => [...ocrPendingByDocument.values()].reduce((sum, count) => sum + count, 0),
    [ocrPendingByDocument],
  );

  function typeDefinitionFor(source: DocumentInfo | CorpusRecord) {
    if ("external_source" in source && source.external_source === "kds") return { ...UNCATEGORIZED_TYPE, name: "KDS 국가설계기준", color: "teal" as const };
    return documentTypeById.get(resolveDocumentTypeId(source, documentTypes)) ?? UNCATEGORIZED_TYPE;
  }

  function typeLabelFor(source: DocumentInfo | CorpusRecord) {
    if ("external_source" in source && source.external_source === "kds") return "KDS 국가설계기준";
    return documentTypeLabel(resolveDocumentTypeId(source, documentTypes), documentTypes);
  }

  const searchHits = useMemo(() => {
    if (!searchedQuery.trim()) return [];
    const selectedRecords = searchedIncludeKds ? [...records, ...kdsRecords] : records;
    const directHits = scoreRecords(selectedRecords, searchedQuery, searchedMode);
    const hits = applyPdfContextScopes(selectedRecords, directHits, searchedQuery, searchedMode).filter((hit) => {
        if (hit.record.external_source === "kds") return hit.score >= minScore;
        const typeId = resolveDocumentTypeId(hit.record, documentTypes);
        return activeTypeIds.has(typeId) && hit.score >= minScore;
      });
    hits.sort((a, b) => sort === "score" ? b.rawScore - a.rawScore : a.record.file_name.localeCompare(b.record.file_name));
    return hits;
  }, [records, kdsRecords, searchedQuery, searchedMode, searchedIncludeKds, activeTypeIds, documentTypes, minScore, sort]);

  const pageCount = Math.max(1, Math.ceil(searchHits.length / RESULTS_PER_PAGE));
  const displayPage = Math.min(currentPage, pageCount);
  const paginatedHits = useMemo(() => {
    const start = (displayPage - 1) * RESULTS_PER_PAGE;
    return searchHits.slice(start, start + RESULTS_PER_PAGE);
  }, [searchHits, displayPage]);
  const visiblePages = useMemo(() => {
    const pages = new Set([1, pageCount, displayPage - 1, displayPage, displayPage + 1]);
    return [...pages].filter((page) => page >= 1 && page <= pageCount).sort((a, b) => a - b);
  }, [displayPage, pageCount]);

  const selectedHits = useMemo(() => searchHits.filter((hit) => selected.has(hit.record.id)), [searchHits, selected]);
  const reportLabels = reportLanguage === "en" ? {
    dateLocale: "en-US",
    internal: "Internal review",
    summary: "1. Executive Summary",
    assessment: "Overall assessment",
    findings: "2. Key Findings",
    evidence: "Evidence",
    selectedSource: "Selected source",
    requirements: "3. Requirements, Conditions, and Figures",
    noRequirements: "No explicit requirement or figure was identified.",
    risks: "4. Risks, Exceptions, and Ambiguities",
    noRisks: "No separate risk or exception was identified.",
    recommendations: "5. Recommendations",
    limitations: "Limitations and checks",
    defaultLimitation: "Verify the original before making a final decision.",
  } : {
    dateLocale: "ko-KR",
    internal: "내부 검토용",
    summary: "1. 요약 분석",
    assessment: "종합 판단",
    findings: "2. 주요 내용",
    evidence: "근거",
    selectedSource: "선택 원문",
    requirements: "3. 요구사항·조건·수치",
    noRequirements: "명시적인 요구사항 또는 수치가 확인되지 않았습니다.",
    risks: "4. 위험·예외·불명확 사항",
    noRisks: "별도의 위험 또는 예외가 확인되지 않았습니다.",
    recommendations: "5. 검토 권고",
    limitations: "한계 및 확인사항",
    defaultLimitation: "최종 판단 전에 반드시 원문을 확인해야 합니다.",
  };
  const selectedOnCurrentPage = paginatedHits.filter((hit) => selected.has(hit.record.id)).length;
  const allCurrentPageSelected = paginatedHits.length > 0 && selectedOnCurrentPage === paginatedHits.length;

  const contextRecords = useMemo(() => {
    if (!viewer) return [];
    if (viewer.external_source === "kds") return kdsRecords.filter((record) => record.document_id === viewer.document_id);
    if ((viewer.source_kind === "pdf" || viewer.source_kind === "word") && viewer.page) {
      const from = viewer.context_pages?.from ?? Math.max(1, viewer.page - 1);
      const to = viewer.context_pages?.to ?? viewer.page + 1;
      return records.filter((record) => record.document_id === viewer.document_id && record.source_kind === viewer.source_kind && (record.page ?? 0) >= from && (record.page ?? 0) <= to)
        .sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
    }
    const sameSheet = records.filter((record) => record.document_id === viewer.document_id && record.source_kind === "excel" && record.sheet === viewer.sheet);
    const index = sameSheet.findIndex((record) => record.id === viewer.id);
    return sameSheet.slice(Math.max(0, index - 1), index + 2);
  }, [viewer, records, kdsRecords]);

  async function executeSearch(nextQuery: string, shouldIncludeKds = includeKds) {
    const cleanQuery = nextQuery.trim();
    setSearchedQuery(cleanQuery);
    setSearchedMode(searchMode);
    setSearchedIncludeKds(shouldIncludeKds);
    setSelected(new Set());
    setCurrentPage(1);
    setKdsError("");
    if (!cleanQuery || !shouldIncludeKds) {
      setKdsRecords([]);
      return;
    }
    setKdsSearching(true);
    try {
      const response = await fetch(`/api/kds/search?q=${encodeURIComponent(cleanQuery)}`, { cache: "no-store" });
      const result = await response.json() as { records?: CorpusRecord[]; message?: string; detail?: string };
      if (!response.ok) throw new Error(result.message || "KDS 검색에 실패했습니다.");
      setKdsRecords(result.records ?? []);
    } catch (error) {
      setKdsRecords([]);
      setKdsError(error instanceof Error ? error.message : "KDS 검색에 실패했습니다.");
    } finally {
      setKdsSearching(false);
    }
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    void executeSearch(query);
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setAuthenticating(true);
    setAuthError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const result = await response.json() as { message?: string; user?: CurrentUser };
      if (!response.ok) throw new Error(result.message || "로그인하지 못했습니다.");
      setCurrentUser(result.user ?? null);
      setAuthState("authenticated");
      setPassword("");
      if (!result.user?.mustChangePassword) await loadCorpus();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "로그인하지 못했습니다.");
    } finally {
      setAuthenticating(false);
    }
  }

  async function handleBootstrap(event: FormEvent) {
    event.preventDefault();
    setAuthenticating(true);
    setAuthError("");
    try {
      const response = await fetch("/api/auth/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          legacy_passcode: legacyPasscode,
          username,
          display_name: displayName,
          password,
        }),
      });
      const result = await response.json() as { message?: string; user?: CurrentUser };
      if (!response.ok || !result.user) throw new Error(result.message || "최초 관리자를 만들지 못했습니다.");
      setCurrentUser(result.user);
      setLegacyPasscode("");
      setPassword("");
      setAuthState("authenticated");
      await loadCorpus();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "최초 관리자를 만들지 못했습니다.");
    } finally {
      setAuthenticating(false);
    }
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setManifest(null);
    setRecords([]);
    setCurrentUser(null);
    setAuthState("anonymous");
  }

  async function submitPasswordChange(event: FormEvent) {
    event.preventDefault();
    setAuthenticating(true);
    setPasswordChangeError("");
    try {
      if (passwordChange.next !== passwordChange.confirm) {
        throw new Error("새 비밀번호 확인이 일치하지 않습니다.");
      }
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_password: passwordChange.current,
          new_password: passwordChange.next,
        }),
      });
      const payload = await response.json() as { message?: string; user?: CurrentUser };
      if (!response.ok || !payload.user) throw new Error(payload.message || "비밀번호를 변경하지 못했습니다.");
      const wasRequired = Boolean(currentUser?.mustChangePassword);
      setCurrentUser(payload.user);
      setPasswordChange({ current: "", next: "", confirm: "" });
      setPasswordOpen(false);
      if (wasRequired) await loadCorpus();
    } catch (error) {
      setPasswordChangeError(error instanceof Error ? error.message : "비밀번호를 변경하지 못했습니다.");
    } finally {
      setAuthenticating(false);
    }
  }

  async function loadAdminData() {
    setAdminLoading(true);
    setAdminNotice("");
    try {
      const [usersResponse, migrationResponse, settingsResponse] = await Promise.all([
        fetch("/api/admin/users", { cache: "no-store" }),
        fetch("/api/admin/migrations/legacy/preview", { cache: "no-store" }),
        fetch("/api/admin/settings", { cache: "no-store" }),
      ]);
      const usersPayload = await usersResponse.json() as { users?: ManagedUser[]; message?: string };
      const migrationPayload = await migrationResponse.json() as LegacyMigrationPreview & { message?: string };
      const settingsPayload = await settingsResponse.json() as { app_version?: string; message?: string };
      if (!usersResponse.ok) throw new Error(usersPayload.message || "사용자 목록을 불러오지 못했습니다.");
      if (!migrationResponse.ok) throw new Error(migrationPayload.message || "기존 자료 상태를 확인하지 못했습니다.");
      if (!settingsResponse.ok) throw new Error(settingsPayload.message || "표시 버전을 불러오지 못했습니다.");
      setManagedUsers(usersPayload.users ?? []);
      setLegacyPreview(migrationPayload);
      if (settingsPayload.app_version) {
        setAppVersion(settingsPayload.app_version);
        setAppVersionDraft(settingsPayload.app_version);
      }
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "관리 정보를 불러오지 못했습니다.");
    } finally {
      setAdminLoading(false);
    }
  }

  async function openAdmin() {
    setAdminOpen(true);
    await loadAdminData();
  }

  async function saveAppVersion(event: FormEvent) {
    event.preventDefault();
    setAdminLoading(true);
    setAdminNotice("");
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_version: appVersionDraft }),
      });
      const payload = await response.json() as { app_version?: string; message?: string };
      if (!response.ok || !payload.app_version) throw new Error(payload.message || "표시 버전을 저장하지 못했습니다.");
      setAppVersion(payload.app_version);
      setAppVersionDraft(payload.app_version);
      setAdminNotice(`AnyScope 표시 버전을 ${payload.app_version}(으)로 변경했습니다.`);
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "표시 버전을 저장하지 못했습니다.");
    } finally {
      setAdminLoading(false);
    }
  }

  async function createManagedUser(event: FormEvent) {
    event.preventDefault();
    setAdminLoading(true);
    setAdminNotice("");
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: newUser.username,
          display_name: newUser.displayName,
          password: newUser.password,
          quota_bytes: Math.round(Number(newUser.quotaGb) * 1024 * 1024 * 1024),
          max_documents: Number(newUser.maxDocuments),
        }),
      });
      const payload = await response.json() as { message?: string };
      if (!response.ok) throw new Error(payload.message || "사용자를 만들지 못했습니다.");
      setNewUser({ username: "", displayName: "", password: "", quotaGb: "5", maxDocuments: "500" });
      setAdminNotice("빈 작업공간을 가진 새 사용자 계정을 만들었습니다.");
      await loadAdminData();
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "사용자를 만들지 못했습니다.");
      setAdminLoading(false);
    }
  }

  async function updateManagedUser(user: ManagedUser, changes: Record<string, unknown>) {
    setAdminLoading(true);
    setAdminNotice("");
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const payload = await response.json() as { message?: string };
      if (!response.ok) throw new Error(payload.message || "사용자 설정을 변경하지 못했습니다.");
      setAdminNotice("사용자 설정을 변경했습니다.");
      await loadAdminData();
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "사용자 설정을 변경하지 못했습니다.");
      setAdminLoading(false);
    }
  }

  async function runUserLifecycle(user: ManagedUser, action: "archive" | "transfer" | "delete") {
    if (action === "archive") {
      if (!window.confirm(`${user.display_name} 계정을 보관할까요? 문서와 검색 색인은 그대로 유지됩니다.`)) return;
    }
    let destinationUser: ManagedUser | undefined;
    if (action === "transfer") {
      const candidates = managedUsers.filter((candidate) => (
        candidate.id !== user.id && Boolean(candidate.active) && !candidate.archived_at
      ));
      const guide = candidates.map((candidate) => `${candidate.username} (${candidate.display_name})`).join("\n");
      const username = window.prompt(`문서를 받을 활성 사용자의 아이디를 입력하세요.\n\n${guide}`);
      if (!username) return;
      destinationUser = candidates.find((candidate) => candidate.username === username.trim().toLocaleLowerCase());
      if (!destinationUser) {
        setAdminNotice("문서를 받을 활성 사용자를 찾지 못했습니다.");
        return;
      }
      if (!window.confirm(`${user.display_name}의 문서 ${user.document_count}개를 ${destinationUser.display_name}에게 비파괴 이전할까요? R2 원본은 이동하지 않습니다.`)) return;
    }
    let confirmation = "";
    if (action === "delete") {
      confirmation = window.prompt(
        `최종 삭제하면 ${user.display_name}의 계정과 남아 있는 개인 문서가 복구 불가능하게 삭제됩니다.\n계속하려면 사용자 아이디 ${user.username}을 입력하세요.`,
      ) ?? "";
      if (confirmation !== user.username) {
        if (confirmation) setAdminNotice("사용자 아이디가 일치하지 않아 최종 삭제하지 않았습니다.");
        return;
      }
    }
    setAdminLoading(true);
    setAdminNotice("");
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}/${action}`, {
        method: action === "delete" ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "transfer"
            ? { destination_user_id: destinationUser?.id }
            : action === "delete"
              ? { confirmation }
              : {},
        ),
      });
      const payload = await response.json() as { message?: string; transferred_documents?: number; deleted_documents?: number };
      if (!response.ok) throw new Error(payload.message || "계정 처리 작업을 완료하지 못했습니다.");
      setAdminNotice(
        action === "archive"
          ? "계정을 보관했습니다. 문서와 검색 색인은 유지됩니다."
          : action === "transfer"
            ? `문서 ${payload.transferred_documents ?? 0}개를 비파괴 이전했습니다.`
            : `계정과 개인 문서 ${payload.deleted_documents ?? 0}개를 최종 삭제했습니다.`,
      );
      await loadAdminData();
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "계정 처리 작업을 완료하지 못했습니다.");
      setAdminLoading(false);
    }
  }

  async function connectLegacyWorkspace() {
    if (!window.confirm("기존 R2 객체를 이동하거나 삭제하지 않고, 현재 관리자 계정 소유로 D1에 연결할까요?")) return;
    setAdminLoading(true);
    setAdminNotice("");
    try {
      const response = await fetch("/api/admin/migrations/legacy/connect", { method: "POST" });
      const payload = await response.json() as { message?: string; document_count?: number };
      if (!response.ok) throw new Error(payload.message || "기존 자료를 연결하지 못했습니다.");
      setAdminNotice(`기존 문서 ${payload.document_count ?? 0}개를 비파괴 방식으로 연결했습니다.`);
      await Promise.all([loadAdminData(), loadCorpus()]);
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "기존 자료를 연결하지 못했습니다.");
      setAdminLoading(false);
    }
  }

  function toggleType(typeId: string) {
    setCurrentPage(1);
    setActiveTypeIds((current) => {
      const next = new Set(current);
      const relatedIds = [typeId, ...descendantDocumentTypeIds(typeId, documentTypes)];
      const willEnable = relatedIds.some((id) => !next.has(id));
      for (const id of relatedIds) {
        if (willEnable) next.add(id); else next.delete(id);
      }
      return next;
    });
  }

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function handleUploadSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length) {
      setPendingUploads((current) => [
        ...current,
        ...files.map((file) => ({
          file,
          documentTypeId: recommendDocumentType(file.name, documentTypes),
        })),
      ]);
      setDocumentManagerOpen(true);
    }
    event.target.value = "";
  }

  function toggleCurrentPageSelection() {
    setSelected((current) => {
      const next = new Set(current);
      if (allCurrentPageSelected) {
        for (const hit of paginatedHits) next.delete(hit.record.id);
      } else {
        for (const hit of paginatedHits) next.add(hit.record.id);
      }
      return next;
    });
  }

  function updatePendingType(index: number, documentTypeId: string) {
    setPendingUploads((current) => current.map((item, itemIndex) => (
      itemIndex === index ? { ...item, documentTypeId } : item
    )));
  }

  async function saveDocumentTypes(nextTypes: DocumentTypeDefinition[]) {
    setSavingDocumentTypes(true);
    setUploadNotice("");
    try {
      // "미분류"는 저장 데이터가 아니라 화면에서 항상 제공하는 기본 선택지다.
      // 서버에 함께 보내면 빈 라이브러리에서 첫 사용자 유형을 추가할 때
      // 기본 선택지까지 사용자 정의 유형으로 검증·저장되는 문제가 생긴다.
      const persistedTypes = nextTypes.filter((type) => type.id !== UNCATEGORIZED_TYPE.id);
      const response = await fetch("/api/library/document-types", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_types: persistedTypes }),
      });
      const result = await response.json() as { document_types?: DocumentTypeDefinition[]; message?: string };
      if (!response.ok || !result.document_types) {
        throw new Error(result.message || "문서 유형을 저장하지 못했습니다.");
      }
      setManifest((current) => current ? { ...current, document_types: result.document_types } : current);
      setActiveTypeIds(new Set([
        UNCATEGORIZED_TYPE.id,
        ...result.document_types.map((type) => type.id),
      ]));
      return result.document_types;
    } catch (error) {
      setUploadNotice(error instanceof Error ? error.message : "문서 유형을 저장하지 못했습니다.");
      return null;
    } finally {
      setSavingDocumentTypes(false);
    }
  }

  async function createDocumentType(event: FormEvent) {
    event.preventDefault();
    const name = newTypeName.replace(/\s+/g, " ").trim();
    if (!name) {
      setUploadNotice("새 문서 유형의 이름을 입력해 주세요.");
      return;
    }
    if (documentTypes.some((type) => (
      (type.parent_id ?? "") === newTypeParentId
      && type.name.toLocaleLowerCase() === name.toLocaleLowerCase()
    ))) {
      setUploadNotice("같은 상위 유형 안에 동일한 이름의 문서 유형이 이미 있습니다.");
      return;
    }
    const id = createDocumentTypeId(name, documentTypes.map((type) => type.id));
    const nextType: DocumentTypeDefinition = {
      id,
      name,
      parent_id: newTypeParentId || undefined,
      color: DOCUMENT_TYPE_COLORS[documentTypes.length % DOCUMENT_TYPE_COLORS.length],
      keywords: [],
      sort_order: (documentTypes.length + 1) * 10,
    };
    const saved = await saveDocumentTypes([...documentTypes, nextType]);
    if (!saved) return;
    setPendingUploads((current) => current.map((item) => (
      item.documentTypeId === UNCATEGORIZED_TYPE.id ? { ...item, documentTypeId: id } : item
    )));
    setNewTypeName("");
    setNewTypeParentId("");
    setUploadNotice(`‘${name}’ 문서 유형을 추가했습니다.`);
  }

  async function deleteDocumentType(typeId: string) {
    const type = documentTypeById.get(typeId);
    if (!type || type.id === UNCATEGORIZED_TYPE.id) return;
    const inUse = (manifest?.documents ?? []).some((document) => resolveDocumentTypeId(document, documentTypes) === typeId);
    const hasChildren = documentTypes.some((candidate) => candidate.parent_id === typeId);
    if (inUse || hasChildren) {
      setUploadNotice("문서가 연결되어 있거나 하위 유형이 있는 문서 유형은 삭제할 수 없습니다.");
      return;
    }
    const saved = await saveDocumentTypes(documentTypes.filter((candidate) => candidate.id !== typeId));
    if (saved) setUploadNotice(`‘${type.name}’ 문서 유형을 삭제했습니다.`);
  }

  async function moveDocumentType(typeId: string, action: "first" | "up" | "down" | "last") {
    const type = documentTypeById.get(typeId);
    if (!type || type.id === UNCATEGORIZED_TYPE.id) return;
    const siblings = documentTypes.filter((candidate) => (
      candidate.id !== UNCATEGORIZED_TYPE.id
      && (candidate.parent_id ?? "") === (type.parent_id ?? "")
    ));
    const index = siblings.findIndex((candidate) => candidate.id === typeId);
    if (index < 0) return;
    const destinationIndex = action === "first"
      ? 0
      : action === "last"
        ? siblings.length - 1
        : index + (action === "up" ? -1 : 1);
    if (destinationIndex < 0 || destinationIndex >= siblings.length || destinationIndex === index) return;
    const reordered = [...siblings];
    const [moving] = reordered.splice(index, 1);
    reordered.splice(destinationIndex, 0, moving);
    const nextOrder = new Map(reordered.map((candidate, order) => [candidate.id, (order + 1) * 10]));
    const nextTypes = documentTypes.map((candidate) => (
      nextOrder.has(candidate.id) ? { ...candidate, sort_order: nextOrder.get(candidate.id) } : candidate
    ));
    const saved = await saveDocumentTypes(nextTypes);
    if (saved) setUploadNotice(`‘${type.name}’ 유형의 순서를 변경했습니다.`);
  }

  async function saveWorkspaceTitle(event: FormEvent) {
    event.preventDefault();
    const workspaceTitle = workspaceTitleDraft.replace(/\s+/g, " ").trim();
    if (!workspaceTitle) {
      setUploadNotice("AnyScope 제목을 입력해 주세요.");
      return;
    }
    setSavingWorkspaceTitle(true);
    setUploadNotice("");
    try {
      const response = await fetch("/api/library/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_title: workspaceTitle }),
      });
      const result = await response.json() as { workspace_title?: string; message?: string };
      if (!response.ok || !result.workspace_title) {
        throw new Error(result.message || "AnyScope 제목을 저장하지 못했습니다.");
      }
      setManifest((current) => current ? { ...current, workspace_title: result.workspace_title } : current);
      setWorkspaceTitleDraft(result.workspace_title);
      setUploadNotice("AnyScope 제목을 저장했습니다.");
    } catch (error) {
      setUploadNotice(error instanceof Error ? error.message : "AnyScope 제목을 저장하지 못했습니다.");
    } finally {
      setSavingWorkspaceTitle(false);
    }
  }

  function closeDocumentManager() {
    if (uploading || deletingDocuments || ocrProcessing || savingDocumentTypes || savingWorkspaceTitle || documentAction) return;
    setDocumentManagerOpen(false);
    setPendingUploads([]);
    setSelectedDocumentIds(new Set());
    setUploadProgress("");
    setDocumentActionNotice("");
  }

  function toggleManagedDocument(id: string) {
    setSelectedDocumentIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAllManagedDocuments() {
    const documents = manifest?.documents ?? [];
    setSelectedDocumentIds((current) => current.size === documents.length ? new Set() : new Set(documents.map((document) => document.id)));
  }

  async function deleteManagedDocuments() {
    const ids = [...selectedDocumentIds];
    if (!ids.length || !manifest) return;
    const names = manifest.documents.filter((document) => selectedDocumentIds.has(document.id)).map((document) => document.display_name);
    if (!window.confirm(`${names.length}개 문서를 삭제하시겠습니까?\n\n${names.join("\n")}\n\n원본 파일과 검색 색인이 함께 삭제되며 복구할 수 없습니다.`)) return;
    setDeletingDocuments(true);
    setUploadProgress(`${names.length}개 문서의 원본과 검색 색인을 삭제하는 중`);
    try {
      const response = await fetch("/api/library/documents", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_ids: ids }),
      });
      const detail = await response.json().catch(() => ({})) as { message?: string; deleted_records?: number; deleted_document_type_names?: string[] };
      if (!response.ok) throw new Error(detail.message || "문서를 삭제하지 못했습니다.");
      await loadCorpus();
      setSelectedDocumentIds(new Set());
      setSelected((current) => new Set([...current].filter((recordId) => !records.some((record) => ids.includes(record.document_id) && record.id === recordId))));
      if (viewer && ids.includes(viewer.document_id)) setViewer(null);
      const deletedTypeNotice = detail.deleted_document_type_names?.length
        ? ` 사용되지 않는 문서 유형 ${detail.deleted_document_type_names.length}개도 정리했습니다.`
        : "";
      setUploadNotice(`${names.length}개 문서와 ${detail.deleted_records ?? 0}개 검색 레코드를 삭제했습니다.${deletedTypeNotice}`);
    } catch (error) {
      setUploadNotice(error instanceof Error ? error.message : "문서를 삭제하지 못했습니다.");
    } finally {
      setUploadProgress("");
      setDeletingDocuments(false);
    }
  }

  function showDocumentActionNotice(message: string, isError = false) {
    setDocumentActionNotice(message);
    setUploadNotice(message);
    if (isError) window.alert(message);
  }

  async function exportSelectedOcr(format: "docx" | "xlsx") {
    setDocumentAction(format);
    setDocumentActionNotice(`${format.toUpperCase()} 파일을 준비하고 있습니다…`);
    try {
      const documents = (manifest?.documents ?? []).filter((document) => selectedDocumentIds.has(document.id));
      const ocrRecords = records.filter((record) => (
        selectedDocumentIds.has(record.document_id)
        && record.ocr_status === "complete"
        && record.body.trim()
      ));
      if (!documents.length) throw new Error("OCR 결과를 내보낼 문서를 선택해 주세요.");
      if (!ocrRecords.length) throw new Error("선택한 문서에 내보낼 OCR 완료 결과가 없습니다. OCR 처리가 완료된 문서를 선택해 주세요.");
      if (format === "docx") {
        await downloadOcrDocx(documents, ocrRecords);
      } else {
        const XLSX = await import("xlsx");
        const documentById = new Map(documents.map((document) => [document.id, document]));
        const rows = [...ocrRecords]
          .sort((left, right) => (
            left.file_name.localeCompare(right.file_name)
            || (left.page ?? 0) - (right.page ?? 0)
          ))
          .map((record) => ({
            문서명: spreadsheetSafe(documentById.get(record.document_id)?.display_name ?? record.file_name),
            페이지: record.page ?? "",
            제목: spreadsheetSafe(record.title),
            "OCR 본문": spreadsheetSafe(record.body),
            "OCR 신뢰도": record.ocr_confidence ?? "",
            "확인 필요": record.ocr_review_required ? "예" : "아니오",
          }));
        const worksheet = XLSX.utils.json_to_sheet(rows);
        worksheet["!cols"] = [{ wch: 42 }, { wch: 9 }, { wch: 50 }, { wch: 120 }, { wch: 13 }, { wch: 12 }];
        if (worksheet["!ref"]) worksheet["!autofilter"] = { ref: worksheet["!ref"] };
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "OCR 결과");
        XLSX.writeFile(workbook, `AnyScope_OCR_결과_${new Date().toISOString().slice(0, 10)}.xlsx`);
      }
      showDocumentActionNotice(`${documents.length}개 문서의 OCR 결과 ${format.toUpperCase()} 다운로드를 시작했습니다.`);
    } catch (error) {
      showDocumentActionNotice(error instanceof Error ? error.message : "OCR 결과를 내보내지 못했습니다.", true);
    } finally {
      setDocumentAction(null);
    }
  }

  async function runOcr(documentIds?: string[]) {
    if (!manifest || ocrProcessing) return;
    const targetIds = documentIds ? new Set(documentIds) : null;
    const plans = manifest.documents
      .filter((document) => document.source_kind === "pdf" && (!targetIds || targetIds.has(document.id)))
      .map((document) => ({
        document,
        targets: records
          .filter((record) => record.document_id === document.id && record.source_kind === "pdf" && record.ocr_status === "pending" && record.page)
          .map((record) => ({ recordId: record.id, page: record.page as number })),
      }))
      .filter((plan) => plan.targets.length > 0);
    const targetPageCount = plans.reduce((sum, plan) => sum + plan.targets.length, 0);
    if (!plans.length) {
      setUploadNotice("OCR 처리가 필요한 PDF 페이지가 없습니다.");
      return;
    }
    if (!targetIds) {
      const breakdown = plans
        .slice(0, 6)
        .map((plan) => `• ${plan.document.display_name}: ${plan.targets.length}페이지`)
        .join("\n");
      const remainder = plans.length > 6 ? `\n• 그 외 ${plans.length - 6}개 문서` : "";
      if (!window.confirm(`모든 문서의 OCR을 시작하시겠습니까?\n\n대상 ${plans.length}개 문서 · 총 ${targetPageCount}페이지\n${breakdown}${remainder}\n\n특정 문서만 처리하려면 해당 문서의 ‘이 문서 OCR’ 버튼을 사용하세요.`)) return;
    }
    setOcrProcessing(true);
    setOcrStopRequested(false);
    ocrCancelRef.current = false;
    let completed = 0;
    let reviewRequired = 0;
    let embeddedTextPages = 0;
    let tesseractPages = 0;
    const failures: string[] = [];
    try {
      const { recognizePdfPages } = await import("./ocr-tools");
      for (const { document, targets } of plans) {
        if (ocrCancelRef.current) break;
        try {
          let unreadable = 0;
          const saveRecognizedBatch = async (results: Array<{ record_id: string; page: number; body: string; title: string; confidence: number; method: "embedded_text" | "tesseract" }>) => {
            const updates = results.filter((result) => result.body.length >= 3).map((result) => ({ ...result, document_id: document.id }));
            unreadable += results.length - updates.length;
            if (!updates.length) return;
            setOcrProgress(`${document.display_name}: 검색 색인 저장 중 · ${completed + updates.length}/${targetPageCount}`);
            const response = await fetch("/api/library/ocr", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ updates }),
            });
            const detail = await response.json().catch(() => ({})) as { message?: string; completed_records?: number; review_required_records?: number };
            if (!response.ok) throw new Error(detail.message || "OCR 검색 색인을 저장하지 못했습니다.");
            completed += detail.completed_records ?? updates.length;
            reviewRequired += detail.review_required_records ?? 0;
          };
          const recognized = await recognizePdfPages(
            document.id,
            document.display_name,
            targets,
            setOcrProgress,
            () => ocrCancelRef.current,
            saveRecognizedBatch,
          );
          embeddedTextPages += recognized.embeddedTextPages;
          tesseractPages += recognized.tesseractPages;
          if (unreadable > 0) failures.push(`${document.display_name}: ${unreadable}페이지에서 글자를 충분히 인식하지 못함`);
        } catch (error) {
          failures.push(`${document.display_name}: ${error instanceof Error ? error.message : "OCR 처리 실패"}`);
        }
      }
      if (completed) await loadCorpus();
      const stopped = ocrCancelRef.current ? " · 중지 요청 이후 남은 페이지는 처리하지 않음" : "";
      const review = reviewRequired ? ` · 저신뢰도 ${reviewRequired}페이지 확인 필요` : "";
      const method = embeddedTextPages ? ` · 내장 텍스트 고속 복구 ${embeddedTextPages}페이지` : "";
      const ocr = tesseractPages ? ` · 실제 OCR ${tesseractPages}페이지` : "";
      const failure = failures.length ? ` · ${failures.join(" / ")}` : "";
      setUploadNotice(`${completed}/${targetPageCount}페이지 검색 가능${method}${ocr}${review}${stopped}${failure}`);
    } finally {
      setOcrProgress("");
      setOcrProcessing(false);
      setOcrStopRequested(false);
      ocrCancelRef.current = false;
    }
  }

  async function launchWindowsOcr(documentId: string) {
    if (ocrProcessing) return;
    try {
      const response = await fetch("/api/auth/ocr-launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: documentId }),
      });
      const payload = await response.json() as { launch_url?: string; message?: string };
      if (!response.ok || !payload.launch_url) {
        throw new Error(payload.message || "Windows OCR을 시작하지 못했습니다.");
      }
      const launcher = document.createElement("a");
      launcher.href = payload.launch_url;
      launcher.style.display = "none";
      document.body.appendChild(launcher);
      launcher.click();
      launcher.remove();
      setUploadNotice("Windows OCR 도우미를 실행했습니다. 열리지 않으면 ‘Windows OCR 연결’을 최초 한 번 설치해 주세요.");
    } catch (error) {
      setUploadNotice(error instanceof Error ? error.message : "Windows OCR을 시작하지 못했습니다.");
    }
  }

  function requestOcrStop() {
    ocrCancelRef.current = true;
    setOcrStopRequested(true);
    setOcrProgress("현재 페이지 처리 후 OCR을 중지합니다.");
  }

  async function confirmUploads() {
    if (!pendingUploads.length) return;
    setUploading(true);
    let uploaded = 0;
    const failures: string[] = [];
    for (const item of pendingUploads) {
      try {
        const type = documentTypeById.get(item.documentTypeId) ?? UNCATEGORIZED_TYPE;
        const indexed = await indexFile(item.file, type.id, type.name, setUploadProgress);
        setUploadProgress(`${item.file.name}: 원본을 비공개 저장소에 올리는 중`);
        const uploadResponse = await fetch("/api/documents/" + indexed.document.id, {
          method: "PUT",
          headers: { "Content-Type": item.file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(item.file.name) },
          body: item.file,
        });
        if (!uploadResponse.ok) throw new Error("원본 파일 저장에 실패했습니다.");
        setUploadProgress(`${item.file.name}: 검색 색인을 저장하는 중`);
        const indexResponse = await fetch("/api/library/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(indexed),
        });
        if (!indexResponse.ok) {
          const detail = await indexResponse.json().catch(() => ({})) as { message?: string };
          throw new Error(detail.message || "검색 색인 저장에 실패했습니다.");
        }
        uploaded += 1;
      } catch (error) {
        failures.push(`${item.file.name}: ${error instanceof Error ? error.message : "처리 실패"}`);
      }
    }
    if (uploaded) {
      await loadCorpus();
      setCurrentPage(1);
    }
    setUploadNotice(failures.length ? `${uploaded}개 추가 완료 · ${failures.join(" / ")}` : `${uploaded}개 문서의 원본 저장과 검색 색인이 완료되었습니다.`);
    setUploadProgress("");
    setUploading(false);
    if (!failures.length) setPendingUploads([]);
  }

  function reportContextText(hit: SearchHit) {
    const record = hit.record;
    let related: CorpusRecord[] = [];
    if ((record.source_kind === "pdf" || record.source_kind === "word") && record.page) {
      const from = record.context_pages?.from ?? Math.max(1, record.page - 1);
      const to = record.context_pages?.to ?? record.page + 1;
      related = records.filter((candidate) => candidate.document_id === record.document_id && candidate.source_kind === record.source_kind && (candidate.page ?? 0) >= from && (candidate.page ?? 0) <= to)
        .sort((left, right) => (left.page ?? 0) - (right.page ?? 0));
    } else if (record.source_kind === "excel") {
      const sameSheet = records.filter((candidate) => candidate.document_id === record.document_id && candidate.source_kind === "excel" && candidate.sheet === record.sheet);
      const index = sameSheet.findIndex((candidate) => candidate.id === record.id);
      related = index >= 0 ? sameSheet.slice(Math.max(0, index - 1), index + 2) : [record];
    }
    if (!related.length) related = [record];
    const text = related.map((item) => `[${locationLabel(item)}] ${item.title}\n${item.body || ""}`).join("\n\n");
    return text.slice(0, 9000);
  }

  async function handleGenerateReport() {
    if (!selectedHits.length || reportGenerating) return;
    setReportGenerating(true);
    setReportError("");
    setAiReport(null);
    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: searchedQuery,
          language: reportLanguage,
          evidence: selectedHits.slice(0, 10).map((hit) => ({
            documentId: hit.record.document_id,
            documentType: typeLabelFor(hit.record),
            fileName: hit.record.file_name,
            title: hit.record.title,
            location: locationLabel(hit.record),
            score: hit.score,
            text: reportContextText(hit),
          })),
        }),
      });
      const payload = await response.json() as { report?: AiSummaryReport; message?: string };
      if (!response.ok || !payload.report) throw new Error(payload.message || "요약 보고서를 생성하지 못했습니다.");
      setAiReport(payload.report);
      setReportGenerated(true);
    } catch (error) {
      setReportError(error instanceof Error ? error.message : "요약 보고서를 생성하지 못했습니다.");
    } finally {
      setReportGenerating(false);
    }
  }

  async function handleReportDownload() {
    if (!selectedHits.length || !aiReport) return;
    setReportDownloading(true);
    try {
      await downloadWordReport(searchedQuery, selectedHits, manifest?.ocr_pending_record_count ?? 0, aiReport, reportLanguage);
    } finally {
      setReportDownloading(false);
    }
  }

  async function downloadSearchResultsExcel() {
    if (!searchHits.length) return;
    const XLSX = await import("xlsx");
    const rows = searchHits.map((hit, index) => ({
      순위: index + 1,
      검색어: spreadsheetSafe(searchedQuery),
      "문서 유형": spreadsheetSafe(hit.record.document_type),
      문서명: spreadsheetSafe(hit.record.file_name),
      "Chapter / Clause": spreadsheetSafe(clauseReference(hit.record)),
      "페이지 / 위치": spreadsheetSafe(locationLabel(hit.record)),
      "관련 내용": spreadsheetSafe(hit.snippet),
      "관련성 (%)": hit.score,
      "OCR 상태": hit.record.ocr_status === "pending" ? "OCR 필요" : hit.record.ocr_status === "complete" ? "OCR 완료" : "텍스트 추출",
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet["!cols"] = [
      { wch: 7 }, { wch: 25 }, { wch: 20 }, { wch: 42 }, { wch: 24 },
      { wch: 18 }, { wch: 100 }, { wch: 13 }, { wch: 13 },
    ];
    if (worksheet["!ref"]) worksheet["!autofilter"] = { ref: worksheet["!ref"] };
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "검색 결과");
    const date = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, `AnyScope_검색결과_${date}.xlsx`);
  }

  function openFullOriginal(record: CorpusRecord) {
    if (record.external_source === "kds" && record.external_url) {
      window.open(record.external_url, "_blank", "noopener,noreferrer");
      return;
    }
    const page = record.page ? `#page=${record.page}` : "";
    window.open(`/api/documents/${encodeURIComponent(record.document_id)}${page}`, "_blank", "noopener,noreferrer");
  }

  function renderTypeFilter(item: DocumentTypeStat, depth = 1): React.ReactNode {
    const relatedIds = [item.id, ...descendantDocumentTypeIds(item.id, documentTypes)];
    const checked = relatedIds.every((id) => activeTypeIds.has(id));
    return (
      <div key={item.id} className={"type-group " + (item.children.length ? "standard-type-group" : "")}>
        <label className={`type-option ${depth > 1 ? "standard-subtype" : ""} ${item.totalCount === 0 ? "disabled-option" : ""}`}>
          <input type="checkbox" checked={checked} onChange={() => toggleType(item.id)} disabled={item.totalCount === 0} />
          <span className="checkbox-visual" aria-hidden="true">{checked ? "✓" : ""}</span>
          {depth === 1 && <span className={"custom-check " + item.color} />}
          <span className="type-name">{item.name}</span><span className="type-count">{item.totalCount}</span>
        </label>
        {item.children.length > 0 && <div className={`standard-subtypes level-${depth + 1}`}>
          {item.children.map((child) => renderTypeFilter(child, depth + 1))}
        </div>}
      </div>
    );
  }

  function renderPasswordForm(required: boolean) {
    return (
      <form onSubmit={submitPasswordChange} className="auth-form">
        <label htmlFor={required ? "required-current-password" : "current-password"}>현재 비밀번호</label>
        <input
          id={required ? "required-current-password" : "current-password"}
          type="password"
          autoComplete="current-password"
          value={passwordChange.current}
          onChange={(event) => setPasswordChange((value) => ({ ...value, current: event.target.value }))}
          autoFocus
        />
        <label htmlFor={required ? "required-new-password" : "new-password"}>새 비밀번호</label>
        <input
          id={required ? "required-new-password" : "new-password"}
          type="password"
          autoComplete="new-password"
          value={passwordChange.next}
          onChange={(event) => setPasswordChange((value) => ({ ...value, next: event.target.value }))}
          placeholder="현재 비밀번호와 다른 10자 이상"
        />
        <label htmlFor={required ? "required-confirm-password" : "confirm-password"}>새 비밀번호 확인</label>
        <input
          id={required ? "required-confirm-password" : "confirm-password"}
          type="password"
          autoComplete="new-password"
          value={passwordChange.confirm}
          onChange={(event) => setPasswordChange((value) => ({ ...value, confirm: event.target.value }))}
        />
        {passwordChangeError && <p className="auth-error" role="alert">{passwordChangeError}</p>}
        <button
          type="submit"
          disabled={authenticating || !passwordChange.current || passwordChange.next.length < 10 || !passwordChange.confirm}
        >
          {authenticating ? "변경 중…" : "새 비밀번호로 변경"}
        </button>
      </form>
    );
  }

  if (authState !== "authenticated") {
    return (
      <main className="auth-shell">
        <section className="auth-card" aria-live="polite">
          <div className="auth-brand"><span className="brand-mark" aria-hidden="true"><i /></span><span>AnyScope <small>(Ver. {appVersion})</small></span></div>
          {authState === "checking" ? (
            <div className="auth-checking"><span /><b>보호 상태를 확인하는 중입니다</b></div>
          ) : (
            <>
              <span className="auth-kicker">DOCUMENT INTELLIGENCE</span>
              <h1>찾으시는 내용을<br />신속·정확하게 검색하세요!</h1>
              <p>{authState === "bootstrap" ? "최초 관리자 계정을 만들고 기존 운영 자료를 안전하게 연결하세요." : "개인 계정으로 로그인하면 본인의 문서와 검색 색인만 표시됩니다."}</p>
              <form onSubmit={authState === "bootstrap" ? handleBootstrap : handleLogin} className="auth-form">
                {authState === "bootstrap" && <><label htmlFor="legacy-passcode">기존 운영 비밀번호</label><input id="legacy-passcode" type="password" autoComplete="off" value={legacyPasscode} onChange={(event) => setLegacyPasscode(event.target.value)} placeholder="현재 팀 비밀번호" autoFocus /><label htmlFor="display-name">표시 이름</label><input id="display-name" autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="예: 홍길동" maxLength={80} /></>}
                <label htmlFor="personal-username">개인 아이디</label>
                <input id="personal-username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="영문 소문자·숫자 3자 이상" autoFocus={authState !== "bootstrap"} />
                <label htmlFor="personal-password">{authState === "bootstrap" ? "새 개인 비밀번호" : "개인 비밀번호"}</label>
                <input id="personal-password" type="password" autoComplete={authState === "bootstrap" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="10자 이상 입력하세요" />
                {authError && <p className="auth-error" role="alert">{authError}</p>}
                <button type="submit" disabled={!username || !password || authenticating || authState === "bootstrap" && (!legacyPasscode || !displayName)}>{authenticating ? "확인 중…" : authState === "bootstrap" ? "최초 관리자 만들기" : "AnyScope 열기"}</button>
              </form>
              <small>{authState === "bootstrap" ? "최초 관리자 생성 후 이 초기 설정 경로는 자동으로 닫힙니다." : "계정은 AnyScope 관리자가 발급합니다."}</small>
            </>
          )}
        </section>
      </main>
    );
  }

  if (currentUser?.mustChangePassword) {
    return (
      <main className="auth-shell">
        <section className="auth-card" aria-live="polite">
          <div className="auth-brand"><span className="brand-mark" aria-hidden="true"><i /></span><span>AnyScope <small>(Ver. {appVersion})</small></span></div>
          <span className="auth-kicker">SECURITY CHECK</span>
          <h1>임시 비밀번호를<br />변경해 주세요.</h1>
          <p>본인만 아는 새 비밀번호를 설정해야 개인 작업공간을 열 수 있습니다.</p>
          {renderPasswordForm(true)}
          <button className="logout-button password-logout" type="button" onClick={handleLogout}>로그아웃</button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true"><i /></span><span>AnyScope <small>(Ver. {appVersion})</small></span></div>
        <div className="workspace-title" title={manifest?.workspace_title || DEFAULT_WORKSPACE_TITLE}>{manifest?.workspace_title || DEFAULT_WORKSPACE_TITLE}</div>
        <div className="top-actions">
          <span className="corpus-status"><i /> {manifest ? manifest.documents.length + "개 문서" : "문서 불러오는 중"}</span>
          <span className="account-label">{currentUser?.displayName || currentUser?.username}</span>
          <input ref={uploadRef} type="file" multiple accept=".pdf,.xls,.xlsx,.doc,.docx" className="visually-hidden" onChange={handleUploadSelection} />
          <button className="button secondary document-manager-trigger" disabled={uploading || deletingDocuments || ocrProcessing} onClick={() => setDocumentManagerOpen(true)}>{uploading ? "문서 추가 중…" : deletingDocuments ? "문서 삭제 중…" : ocrProcessing ? "OCR 처리 중…" : "문서 관리"}</button>
          {currentUser?.role === "admin" && <button className="button secondary admin-trigger" onClick={openAdmin}>사용자 관리</button>}
          <button className="button secondary" onClick={() => { setPasswordChangeError(""); setPasswordOpen(true); }}>비밀번호 변경</button>
          <button className="logout-button" onClick={handleLogout}>로그아웃</button>
        </div>
      </header>

      {uploadNotice && <button className="toast" onClick={() => setUploadNotice("")} aria-label="알림 닫기"><b>✓</b> {uploadNotice} <span>×</span></button>}

      <section className="hero real-corpus-hero">
        <p className="hero-search-description">영어와 한글 키워드·문장 검색</p>
        <form className="search-box" onSubmit={submitSearch}>
          <span className="search-glyph" aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="문서 검색" placeholder="찾고 싶은 내용을 키워드 또는 문장으로 입력하세요" />
          <div className="search-mode-selector" role="group" aria-label="검색 조건">
            <button type="button" className={searchMode === "and" ? "active" : ""} aria-pressed={searchMode === "and"} onClick={() => setSearchMode("and")}>AND</button>
            <button type="button" className={searchMode === "or" ? "active" : ""} aria-pressed={searchMode === "or"} onClick={() => setSearchMode("or")}>OR</button>
          </div>
          <button type="submit" disabled={kdsSearching}>{kdsSearching ? "KDS 조회 중…" : "검색"}</button>
        </form>
        <div className="suggestions" aria-label="추천 검색어">
          <span>검색어 예시 :</span>
          {["Settlement", "Concrete Strength", "Termination", "Monitoring"].map((item) => (
            <button key={item} onClick={() => { setQuery(item); void executeSearch(item); }}>{item}</button>
          ))}
        </div>
      </section>

      <section className="corpus-overview">
        <div><span>연결 문서</span><strong>{manifest?.documents.length ?? "—"}</strong><small>{manifest ? ["pdf", "excel", "word"].map((kind) => `${kind === "pdf" ? "PDF" : kind === "excel" ? "Excel" : "Word"} ${manifest.documents.filter((document) => document.source_kind === kind).length}`).join(" · ") : "PDF · Excel · Word"}</small></div>
        <div><span>검색 레코드</span><strong>{manifest?.record_count.toLocaleString() ?? "—"}</strong><small>페이지·셀 위치 보존</small></div>
        <div><span>텍스트 검색 가능</span><strong>{manifest?.text_record_count.toLocaleString() ?? "—"}</strong><small>실제 추출 완료</small></div>
        <div className="warning-stat">
          <span className="stat-label">OCR 필요 (전체) <button type="button" className="stat-help-button" aria-label="OCR 필요 상태 설명" aria-expanded={ocrHelpOpen} onClick={() => setOcrHelpOpen((open) => !open)}>?</button></span>
          <strong>{manifest ? totalOcrPendingPages.toLocaleString() : "—"}</strong>
          <small>모든 문서의 미처리 페이지 합계</small>
          {ocrHelpOpen && <div className="ocr-help-popover" role="dialog" aria-label="OCR 필요 상태 안내"><div><b>OCR 필요란?</b><button type="button" onClick={() => setOcrHelpOpen(false)} aria-label="OCR 안내 닫기">×</button></div><p>PDF 페이지에 선택·검색할 수 있는 텍스트가 없고 이미지나 스캔으로만 들어 있어 글자 인식이 필요한 상태입니다. 위 숫자는 특정 파일이 아니라 모든 문서의 합계입니다.</p><ul><li><b>Windows 권장</b><span>최초 한 번 연결한 뒤 문서별 Windows OCR 버튼으로 바로 처리</span></li><li><b>브라우저 대안</b><span>설치 없이 현재 화면에서도 문서별·전체 OCR 처리 가능</span></li><li><b>임시 파일</b><span>Windows 도우미가 내려받은 원본과 페이지 이미지는 처리 후 삭제</span></li></ul></div>}
        </div>
      </section>

      <section className="workspace search-surface">
        <aside className="filters">
          <div className="filter-heading"><div><span>SEARCH OPTIONS</span><h2>검색 조건</h2></div><button className="reset-button" onClick={() => { setActiveTypeIds(new Set()); setIncludeKds(true); setMinScore(30); setCurrentPage(1); }}>초기화</button></div>
          <div className="filter-group">
            <div className="filter-label-row"><h3>문서 유형</h3><span className="real-data-label">실제 문서 수</span></div>
            <div className="type-list">
              {typeStats.map((item) => renderTypeFilter(item))}
              <label className="type-option kds-type-option">
                <input type="checkbox" checked={includeKds} onChange={(event) => { const checked = event.target.checked; setIncludeKds(checked); setCurrentPage(1); if (searchedQuery) void executeSearch(searchedQuery, checked); }} />
                <span className="checkbox-visual" aria-hidden="true">{includeKds ? "✓" : ""}</span>
                <span className="custom-check teal" />
                <span className="type-name">KDS 국가설계기준</span><span className="type-count">API</span>
              </label>
            </div>
          </div>
          <div className="filter-group relevance-filter">
            <div className="filter-label-row">
              <div className="score-help-wrap"><h3>최소 관련도</h3><button type="button" className="score-help-button" aria-label="관련도 점수 설명" aria-expanded={scoreHelpOpen} onClick={() => setScoreHelpOpen((open) => !open)}>?</button>
                {scoreHelpOpen && <div className="score-help-popover" role="dialog" aria-label="관련도 점수 안내"><div><b>관련도 점수 안내</b><button type="button" onClick={() => setScoreHelpOpen(false)} aria-label="점수 안내 닫기">×</button></div><ul><li><strong>10–29</strong><span>목차·참고문헌·색인 또는 단순 키워드 노출</span></li><li><strong>30–49</strong><span>개념은 있으나 서로 멀거나 요구사항 문맥이 약함</span></li><li><strong>50–69</strong><span>같은 문단 주변에서 개념과 일부 조건·수치가 확인됨</span></li><li><strong>70–84</strong><span>실제 Clause 문맥에서 제목·조건·수치가 강하게 일치</span></li><li><strong>85–100</strong><span>제목·근접 문맥·반복 빈도와 요구사항 증거가 모두 강함</span></li></ul><p>AND는 모든 검색 개념을 포함한 결과를, OR은 하나 이상의 검색 개념을 포함한 결과를 찾습니다. 목차·참고문헌·색인·표/그림 목록은 최대 18점으로 제한합니다.</p></div>}
              </div><strong>{minScore}점 이상</strong>
            </div>
            <input type="range" min="10" max="90" step="5" value={minScore} onChange={(event) => { setMinScore(Number(event.target.value)); setCurrentPage(1); }} aria-label="최소 관련도" style={{ "--range-value": ((minScore - 10) / 80) * 100 + "%" } as React.CSSProperties} />
            <div className="range-labels"><span>넓게</span><span>정확하게</span></div>
          </div>
        </aside>

        <section className="results-panel">
          <div className="results-toolbar">
            <div><h2><b>{searchHits.length}</b>개의 실제 관련 결과</h2></div>
            <div className="toolbar-actions"><select value={sort} onChange={(event) => { setSort(event.target.value); setCurrentPage(1); }} aria-label="정렬 순서"><option value="score">관련도 높은 순</option><option value="document">문서명 순</option></select><button type="button" className="excel-download-button" disabled={!searchHits.length} onClick={downloadSearchResultsExcel}>목록 내려받기</button><button type="button" className="summary-report-button" disabled={!searchHits.length} onClick={() => { setReportGenerated(false); setAiReport(null); setReportError(""); setReportOpen(true); }}>요약 보고서 만들기</button></div>
          </div>
          {loadError && <div className="system-error"><b>검색 데이터를 불러오지 못했습니다.</b><p>{loadError}</p></div>}
          {kdsError && <div className="system-error"><b>KDS 데이터를 불러오지 못했습니다.</b><p>{kdsError}</p></div>}
          {kdsSearching && <div className="loading-state"><span /><b>국가건설기준센터에서 관련 KDS 기준을 확인하는 중입니다</b></div>}
          {!manifest && !loadError && <div className="loading-state"><span /><b>실제 문서 색인을 불러오는 중입니다</b></div>}

          {paginatedHits.length > 0 && <div className="results-table-wrap">
            <table className="results-table">
              <thead><tr><th scope="col" className="selection-column"><button type="button" className={"select-page-results " + (selectedOnCurrentPage > 0 ? "selected" : "")} role="checkbox" aria-checked={allCurrentPageSelected ? "true" : selectedOnCurrentPage > 0 ? "mixed" : "false"} aria-label={allCurrentPageSelected ? "현재 페이지 결과 전체 선택 해제" : "현재 페이지 결과 전체 선택"} title={allCurrentPageSelected ? "현재 페이지 전체 선택 해제" : "현재 페이지 전체 선택"} onClick={toggleCurrentPageSelection}><span>{allCurrentPageSelected ? "✓" : selectedOnCurrentPage > 0 ? "−" : ""}</span></button></th><th scope="col">문서 유형</th><th scope="col">문서명</th><th scope="col">Chapter / Clause</th><th scope="col">페이지 / 위치</th><th scope="col">관련 내용</th><th scope="col" className="relevance-column">관련성</th></tr></thead>
              <tbody>{paginatedHits.map((hit) => {
                const result = hit.record;
                const resultType = typeDefinitionFor(result);
                return <tr key={result.id} className={selected.has(result.id) ? "selected" : ""} role="button" tabIndex={0} aria-label={`${result.file_name} ${locationLabel(result)} 상세 보기`} onClick={() => setViewer(result)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setViewer(result); } }}>
                  <td className="selection-cell" onClick={(event) => event.stopPropagation()}><label className="table-select-result" title="요약 보고서에 포함"><input type="checkbox" checked={selected.has(result.id)} onChange={() => toggleSelected(result.id)} /><span>{selected.has(result.id) ? "✓" : ""}</span></label></td>
                  <td><span className={"type-pill " + resultType.color}>{typeLabelFor(result)}</span></td>
                  <td className="document-name-cell">{result.file_name}</td>
                  <td className="clause-reference-cell">{clauseReference(result)}</td>
                  <td className="location-cell">{locationLabel(result)}</td>
                  <td className="related-content-cell"><span>{hit.snippet}</span>{result.ocr_status === "pending" && <b>OCR 필요</b>}</td>
                  <td className="relevance-cell">{hit.score}%</td>
                </tr>;
              })}</tbody>
            </table>
          </div>}
          {manifest && !searchedQuery.trim() && <div className="empty-state initial-empty-state"><span className="search-glyph" /><h3>검색어를 입력해 주세요</h3><p>한글 또는 영어 키워드와 문장으로 연결된 문서를 검색할 수 있습니다.</p></div>}
          {manifest && searchedQuery.trim() && !kdsSearching && searchHits.length === 0 && <div className="empty-state"><span className="search-glyph" /><h3>현재 조건에 맞는 결과가 없습니다</h3><p>{searchedIncludeKds && activeTypeIds.size === 0 ? "KDS 코드나 기준명에 포함된 핵심 용어로 다시 검색해 보세요." : "최소 관련도를 낮추거나 다른 문서 유형을 선택해 보세요. OCR 필요 페이지는 처리 전까지 검색되지 않습니다."}</p><button onClick={() => { setMinScore(15); setCurrentPage(1); }}>관련도 15점으로 낮추기</button></div>}
          {searchHits.length > RESULTS_PER_PAGE && <nav className="pagination" aria-label="검색 결과 페이지"><button type="button" onClick={() => setCurrentPage(Math.max(1, displayPage - 1))} disabled={displayPage === 1}>이전</button><div>{visiblePages.map((page, index) => <span key={page}>{index > 0 && page - visiblePages[index - 1] > 1 && <i>…</i>}<button type="button" className={page === displayPage ? "active" : ""} aria-current={page === displayPage ? "page" : undefined} onClick={() => setCurrentPage(page)}>{page}</button></span>)}</div><button type="button" onClick={() => setCurrentPage(Math.min(pageCount, displayPage + 1))} disabled={displayPage === pageCount}>다음</button><small>{(displayPage - 1) * RESULTS_PER_PAGE + 1}–{Math.min(displayPage * RESULTS_PER_PAGE, searchHits.length)} / {searchHits.length}</small></nav>}
        </section>
      </section>

      {documentManagerOpen && (
        <div className="modal-backdrop upload-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) closeDocumentManager(); }}>
          <section className="upload-modal document-manager-modal" role="dialog" aria-modal="true" aria-label="문서 관리">
            <header><div><span>DOCUMENT LIBRARY</span><h2>문서 관리</h2><p>문서 유형을 직접 구성하고 파일을 분류해 검색 공간을 만드세요.</p></div><button className="close-button" disabled={uploading || deletingDocuments || ocrProcessing || savingDocumentTypes || savingWorkspaceTitle} onClick={closeDocumentManager} aria-label="문서 관리 닫기">×</button></header>
            <div className="document-manager-body">
              <section className="manager-section workspace-settings-section">
                <div className="manager-section-head"><div><h3>AnyScope 제목</h3><p>상단 가운데에 표시되어 여러 AnyScope 작업공간을 구분합니다.</p></div></div>
                <form className="workspace-title-form" onSubmit={saveWorkspaceTitle}>
                  <label><span>현재 작업공간 제목</span><input value={workspaceTitleDraft} onChange={(event) => setWorkspaceTitleDraft(event.target.value)} maxLength={80} placeholder="예: A Project용 AnyScope" disabled={savingWorkspaceTitle} /></label>
                  <button className="button secondary" type="submit" disabled={!workspaceTitleDraft.trim() || savingWorkspaceTitle}>{savingWorkspaceTitle ? "저장 중…" : "제목 저장"}</button>
                </form>
              </section>
              <section className="manager-section">
                <div className="manager-section-head"><div><h3>현재 문서 <span>{manifest?.documents.length ?? 0}</span></h3><p>삭제하면 원본 파일과 해당 검색 색인이 함께 제거됩니다.</p></div><div>{manifest && totalOcrPendingPages > 0 && <a className="button windows-ocr-button" href="/downloads/anyscope-windows-ocr.zip" download>Windows OCR 연결 (최초 1회)</a>}{manifest && totalOcrPendingPages > 0 && (ocrProcessing ? <button type="button" className="button ocr-stop-button" disabled={ocrStopRequested} onClick={requestOcrStop}>{ocrStopRequested ? "중지 요청됨" : "OCR 중지"}</button> : <button type="button" className="button ocr-action-button" disabled={uploading || deletingDocuments} onClick={() => runOcr()}>브라우저 OCR 전체 ({totalOcrPendingPages}페이지)</button>)}<button type="button" className="manager-text-button" disabled={!manifest?.documents.length || uploading || deletingDocuments || ocrProcessing} onClick={toggleAllManagedDocuments}>{manifest?.documents.length && selectedDocumentIds.size === manifest.documents.length ? "전체 해제" : "전체 선택"}</button><button type="button" className="button secondary" disabled={uploading || deletingDocuments || ocrProcessing} onClick={() => uploadRef.current?.click()}>＋ 문서 추가</button></div></div>
                <div className="managed-document-list">
                  {manifest?.documents.map((document) => (
                    <div className={"managed-document-row " + (selectedDocumentIds.has(document.id) ? "selected" : "")} key={document.id}>
                      <label className="managed-document-check" title="삭제할 문서 선택"><input type="checkbox" disabled={uploading || deletingDocuments || ocrProcessing} checked={selectedDocumentIds.has(document.id)} onChange={() => toggleManagedDocument(document.id)} /><span>{selectedDocumentIds.has(document.id) ? "✓" : ""}</span></label>
                      <div className="file-kind">{document.display_name.split(".").pop()?.toUpperCase()}</div>
                      <div className="managed-document-name"><b>{document.display_name}</b><span>{typeLabelFor(document)} · {document.source_kind === "pdf" ? "PDF" : document.source_kind === "excel" ? "Excel" : "Word"} · {(document.record_count ?? 0).toLocaleString()}개 레코드{ocrPendingByDocument.get(document.id) ? ` · OCR 필요 ${ocrPendingByDocument.get(document.id)}페이지` : ""}{document.ocr_review_pages ? ` · 확인 필요 ${document.ocr_review_pages}` : ""}</span></div>
                      <div className="managed-document-actions">{Boolean(ocrPendingByDocument.get(document.id)) && <><button type="button" className="manager-windows-ocr-button" disabled={uploading || deletingDocuments || ocrProcessing} onClick={() => launchWindowsOcr(document.id)}>Windows OCR</button><button type="button" className="manager-ocr-button" disabled={uploading || deletingDocuments || ocrProcessing} onClick={() => runOcr([document.id])}>브라우저 OCR ({ocrPendingByDocument.get(document.id)}페이지)</button></>}<button type="button" className="manager-original-button" disabled={ocrProcessing} onClick={() => window.open(`/api/documents/${encodeURIComponent(document.id)}`, "_blank", "noopener,noreferrer")}>원본 열기 ↗</button></div>
                    </div>
                  ))}
                  {manifest && manifest.documents.length === 0 && <div className="manager-empty">현재 연결된 문서가 없습니다. ‘문서 추가’를 눌러 시작하세요.</div>}
                </div>
              </section>

              <section className="manager-section document-type-manager-section">
                <div className="manager-section-head"><div><h3>문서 유형 <span>{documentTypes.length}</span></h3><p>새 유형을 등록하면 모든 업로드와 검색 필터에 바로 적용됩니다.</p></div></div>
                <div className="document-type-manager-grid">
                  <form className="document-type-create-form" onSubmit={createDocumentType}>
                    <label><span>새 유형 이름</span><input value={newTypeName} onChange={(event) => setNewTypeName(event.target.value)} placeholder="예: 회의록, 계약서, 시험성적서" maxLength={80} disabled={savingDocumentTypes} /></label>
                    <label><span>상위 유형 (선택)</span><select value={newTypeParentId} onChange={(event) => setNewTypeParentId(event.target.value)} disabled={savingDocumentTypes}><option value="">상위 유형 없음</option>{documentTypes.filter((type) => type.id !== UNCATEGORIZED_TYPE.id && documentTypeDepth(type.id, documentTypes) < 3).map((type) => <option key={type.id} value={type.id}>{documentTypeLabel(type.id, documentTypes)}</option>)}</select></label>
                    <button className="button secondary" type="submit" disabled={!newTypeName.trim() || savingDocumentTypes}>{savingDocumentTypes ? "저장 중…" : "＋ 유형 추가"}</button>
                  </form>
                  <div className="document-type-catalog">
                    {documentTypes.map((type) => {
                      const count = (manifest?.documents ?? []).filter((document) => resolveDocumentTypeId(document, documentTypes) === type.id).length;
                      const hasChildren = documentTypes.some((candidate) => candidate.parent_id === type.id);
                      const siblings = documentTypes.filter((candidate) => candidate.id !== UNCATEGORIZED_TYPE.id && (candidate.parent_id ?? "") === (type.parent_id ?? ""));
                      const siblingIndex = siblings.findIndex((candidate) => candidate.id === type.id);
                      const depth = documentTypeDepth(type.id, documentTypes);
                      return <div key={type.id} className={depth > 1 ? `child-type level-${depth}` : ""}><span className={"custom-check " + type.color} /><div><b>{type.name}</b><span>{type.parent_id ? `${documentTypeLabel(type.parent_id, documentTypes)} 아래` : "최상위 유형"}</span></div><strong>{count}</strong><span className="type-order-controls"><button type="button" disabled={type.id === UNCATEGORIZED_TYPE.id || siblingIndex <= 0 || savingDocumentTypes} onClick={() => moveDocumentType(type.id, "first")} aria-label={`${type.name} 유형 맨 위로 이동`} title="맨 위로 이동"><span className="move-icon move-first" aria-hidden="true" /></button><button type="button" disabled={type.id === UNCATEGORIZED_TYPE.id || siblingIndex < 0 || siblingIndex >= siblings.length - 1 || savingDocumentTypes} onClick={() => moveDocumentType(type.id, "last")} aria-label={`${type.name} 유형 맨 아래로 이동`} title="맨 아래로 이동"><span className="move-icon move-last" aria-hidden="true" /></button><button type="button" disabled={type.id === UNCATEGORIZED_TYPE.id || siblingIndex <= 0 || savingDocumentTypes} onClick={() => moveDocumentType(type.id, "up")} aria-label={`${type.name} 유형 한 칸 위로 이동`} title="한 칸 위로 이동"><span className="move-icon move-up" aria-hidden="true" /></button><button type="button" disabled={type.id === UNCATEGORIZED_TYPE.id || siblingIndex < 0 || siblingIndex >= siblings.length - 1 || savingDocumentTypes} onClick={() => moveDocumentType(type.id, "down")} aria-label={`${type.name} 유형 한 칸 아래로 이동`} title="한 칸 아래로 이동"><span className="move-icon move-down" aria-hidden="true" /></button></span><button type="button" disabled={type.id === UNCATEGORIZED_TYPE.id || count > 0 || hasChildren || savingDocumentTypes} onClick={() => deleteDocumentType(type.id)} aria-label={`${type.name} 유형 삭제`}>삭제</button></div>;
                    })}
                  </div>
                </div>
              </section>

              {pendingUploads.length > 0 && <section className="manager-section pending-upload-section">
                <div className="manager-section-head"><div><h3>추가 예정 <span>{pendingUploads.length}</span></h3><p>문서 유형을 확인한 후 아래 ‘추가 및 색인’을 누르세요.</p></div><button type="button" className="manager-text-button" disabled={uploading || ocrProcessing} onClick={() => setPendingUploads([])}>목록 비우기</button></div>
                <div className="upload-file-list">
                  {pendingUploads.map((item, index) => <div className="upload-file-row" key={item.file.name + index}><div className="file-kind">{item.file.name.split(".").pop()?.toUpperCase()}</div><div className="upload-file-name"><b>{item.file.name}</b><span>{(item.file.size / 1024 / 1024).toFixed(1)} MB</span></div><label><span>문서 유형</span><select disabled={uploading || savingDocumentTypes} value={item.documentTypeId} onChange={(event) => updatePendingType(index, event.target.value)}>{documentTypes.map((type) => <option key={type.id} value={type.id}>{documentTypeLabel(type.id, documentTypes)}</option>)}</select></label></div>)}
                </div>
              </section>}
              <div className="upload-guidance"><b>처리 방식</b><span>PDF는 페이지별, Excel은 행별, Word는 문맥 구간별로 검색됩니다. 스캔 PDF의 텍스트 없는 페이지는 OCR 필요 상태로 표시됩니다.</span></div>
              {uploadProgress && <div className="upload-progress"><span /><b>{uploadProgress}</b></div>}
              {ocrProgress && <div className="upload-progress ocr-progress"><span /><b>{ocrProgress}</b></div>}
              {documentActionNotice && <div className="document-action-notice" role="status"><b>{documentAction ? "처리 중" : "안내"}</b><span>{documentActionNotice}</span><button type="button" onClick={() => setDocumentActionNotice("")} aria-label="작업 안내 닫기">×</button></div>}
            </div>
            <footer className="document-manager-footer"><button className="button delete-button" disabled={!selectedDocumentIds.size || uploading || deletingDocuments || ocrProcessing || savingDocumentTypes || savingWorkspaceTitle || adminLoading} onClick={deleteManagedDocuments}>{deletingDocuments ? "삭제 중…" : `선택 문서 삭제${selectedDocumentIds.size ? ` (${selectedDocumentIds.size})` : ""}`}</button><button className="button secondary" disabled={!selectedDocumentIds.size || uploading || deletingDocuments || ocrProcessing || Boolean(documentAction)} onClick={() => void exportSelectedOcr("docx")}>{documentAction === "docx" ? "DOCX 만드는 중…" : "OCR 결과 DOCX"}</button><button className="button secondary" disabled={!selectedDocumentIds.size || uploading || deletingDocuments || ocrProcessing || Boolean(documentAction)} onClick={() => void exportSelectedOcr("xlsx")}>{documentAction === "xlsx" ? "XLSX 만드는 중…" : "OCR 결과 XLSX"}</button><i /><button className="button secondary" disabled={uploading || deletingDocuments || ocrProcessing || savingDocumentTypes || savingWorkspaceTitle || adminLoading} onClick={closeDocumentManager}>닫기</button><button className="button primary" disabled={!pendingUploads.length || uploading || deletingDocuments || ocrProcessing || savingDocumentTypes || savingWorkspaceTitle || adminLoading} onClick={confirmUploads}>{uploading ? "추출·저장 중…" : `추가 및 색인${pendingUploads.length ? ` (${pendingUploads.length})` : ""}`}</button></footer>
          </section>
        </div>
      )}

      {adminOpen && currentUser?.role === "admin" && (
        <div className="modal-backdrop admin-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !adminLoading) setAdminOpen(false); }}>
          <section className="admin-modal" role="dialog" aria-modal="true" aria-label="사용자 관리">
            <header><div><span>ADMINISTRATION</span><h2>사용자와 개인 작업공간 관리</h2><p>계정·상태·용량만 관리하며 다른 사용자의 문서 내용은 열람하지 않습니다.</p></div><button className="close-button" disabled={adminLoading} onClick={() => setAdminOpen(false)} aria-label="사용자 관리 닫기">×</button></header>
            <div className="admin-body">
              {adminNotice && <p className="admin-notice" role="status">{adminNotice}</p>}
              <section className="admin-section app-version-section">
                <div><h3>AnyScope 표시 버전</h3><p>로그인 화면과 상단 로고 옆의 Ver. 숫자를 변경합니다.</p></div>
                <form onSubmit={saveAppVersion}>
                  <label><span>버전 번호</span><input value={appVersionDraft} maxLength={20} onChange={(event) => setAppVersionDraft(event.target.value)} placeholder="예: 1.1" /></label>
                  <button className="button primary" type="submit" disabled={adminLoading || !appVersionDraft.trim() || appVersionDraft === appVersion}>버전 저장</button>
                </form>
              </section>

              <section className="admin-section legacy-section">
                <div><h3>기존 운영 자료</h3><p>현재 R2 객체는 이동·수정·삭제하지 않고 관리자 계정의 소유권만 D1에 기록합니다.</p></div>
                {legacyPreview ? <dl><div><dt>기존 문서</dt><dd>{legacyPreview.document_count.toLocaleString()}개</dd></div><div><dt>검색 레코드</dt><dd>{legacyPreview.corpus_record_count.toLocaleString()}개</dd></div><div><dt>원본 용량</dt><dd>{formatStorage(legacyPreview.total_original_bytes)}</dd></div></dl> : <span>확인 중…</span>}
                <button className="button primary" disabled={adminLoading || !legacyPreview || legacyPreview.connected || legacyPreview.missing_original_count > 0} onClick={connectLegacyWorkspace}>{legacyPreview?.connected ? "비파괴 연결 완료" : legacyPreview?.missing_original_count ? "누락 원본 확인 필요" : "내 작업공간에 비파괴 연결"}</button>
              </section>

              <section className="admin-section">
                <div className="admin-section-title"><div><h3>새 사용자</h3><p>새 계정은 문서와 문서 유형이 없는 빈 작업공간으로 시작합니다.</p></div></div>
                <form className="admin-create-form" onSubmit={createManagedUser}>
                  <label><span>개인 아이디</span><input value={newUser.username} onChange={(event) => setNewUser((value) => ({ ...value, username: event.target.value }))} placeholder="예: team.member" /></label>
                  <label><span>표시 이름</span><input value={newUser.displayName} onChange={(event) => setNewUser((value) => ({ ...value, displayName: event.target.value }))} placeholder="사용자 이름" /></label>
                  <label><span>임시 비밀번호</span><input type="password" autoComplete="new-password" value={newUser.password} onChange={(event) => setNewUser((value) => ({ ...value, password: event.target.value }))} placeholder="10자 이상" /></label>
                  <label><span>용량(GB)</span><input type="number" min="0" step="0.5" value={newUser.quotaGb} onChange={(event) => setNewUser((value) => ({ ...value, quotaGb: event.target.value }))} /></label>
                  <label><span>최대 문서</span><input type="number" min="1" step="1" value={newUser.maxDocuments} onChange={(event) => setNewUser((value) => ({ ...value, maxDocuments: event.target.value }))} /></label>
                  <button className="button primary" type="submit" disabled={adminLoading || !newUser.username || !newUser.displayName || newUser.password.length < 10}>빈 작업공간 계정 만들기</button>
                </form>
              </section>

              <section className="admin-section">
                <div className="admin-section-title"><div><h3>등록 사용자 <span>{managedUsers.length}</span></h3><p>비활성화 → 문서 이전 또는 보관 → 최종 삭제 순서로 안전하게 관리합니다.</p></div></div>
                <div className="admin-user-list">
                  {managedUsers.map((user) => <div className="admin-user-row" key={user.id}>
                    <div><b>{user.display_name}</b><span>{user.username} · {user.role === "admin" ? "관리자" : "일반 사용자"}</span></div>
                    <div><b>{Number(user.document_count).toLocaleString()}개 문서</b><span>{formatStorage(Number(user.used_bytes))} / {formatStorage(Number(user.quota_bytes))} · 최대 {Number(user.max_documents).toLocaleString()}개</span></div>
                    <span className={user.archived_at ? "user-archived" : user.active ? "user-active" : "user-inactive"}>{user.archived_at ? "보관" : user.active ? "활성" : "비활성"}</span>
                    <div className="admin-user-actions">
                      {!user.archived_at && <button type="button" disabled={adminLoading || user.id === currentUser.id} onClick={() => updateManagedUser(user, { active: !Boolean(user.active) })}>{user.active ? "비활성화" : "활성화"}</button>}
                      <button type="button" disabled={adminLoading || Boolean(user.archived_at)} onClick={() => { const value = window.prompt(`${user.display_name}의 새 임시 비밀번호를 입력하세요. 다음 로그인에서 사용자가 직접 변경합니다. (10자 이상)`); if (value) void updateManagedUser(user, { password: value }); }}>비밀번호 초기화</button>
                      <button type="button" disabled={adminLoading} onClick={() => { const value = window.prompt(`${user.display_name}의 용량 한도(GB)를 입력하세요.`, String(Number(user.quota_bytes) / 1024 ** 3)); if (value !== null && Number(value) >= 0) void updateManagedUser(user, { quota_bytes: Math.round(Number(value) * 1024 ** 3) }); }}>용량 변경</button>
                      {!user.active && user.role !== "admin" && Number(user.document_count) > 0 && <button type="button" disabled={adminLoading} onClick={() => void runUserLifecycle(user, "transfer")}>문서 이전</button>}
                      {!user.active && !user.archived_at && user.role !== "admin" && <button type="button" disabled={adminLoading} onClick={() => void runUserLifecycle(user, "archive")}>계정 보관</button>}
                      {Boolean(user.archived_at) && user.role !== "admin" && <button type="button" className="danger-action" disabled={adminLoading} onClick={() => void runUserLifecycle(user, "delete")}>최종 삭제</button>}
                    </div>
                  </div>)}
                  {!adminLoading && managedUsers.length === 0 && <div className="manager-empty">등록된 사용자가 없습니다.</div>}
                </div>
              </section>
            </div>
            <footer><button className="button secondary" disabled={adminLoading} onClick={() => setAdminOpen(false)}>닫기</button></footer>
          </section>
        </div>
      )}

      {passwordOpen && !currentUser?.mustChangePassword && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !authenticating) setPasswordOpen(false); }}>
          <section className="password-modal" role="dialog" aria-modal="true" aria-label="비밀번호 변경">
            <header>
              <div><span>ACCOUNT SECURITY</span><h2>비밀번호 변경</h2><p>현재 비밀번호를 확인한 뒤 새 비밀번호로 변경합니다.</p></div>
              <button className="close-button" disabled={authenticating} onClick={() => setPasswordOpen(false)} aria-label="비밀번호 변경 닫기">×</button>
            </header>
            <div className="password-modal-body">{renderPasswordForm(false)}</div>
          </section>
        </div>
      )}

      {viewer && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setViewer(null); }}>
          <section className="document-modal actual-document-modal" role="dialog" aria-modal="true" aria-label="원문 문맥 미리보기">
            <header><div><span className={"type-pill " + typeDefinitionFor(viewer).color}>{typeLabelFor(viewer)}</span><h2>{viewer.file_name}</h2><p>{viewer.title} · {locationLabel(viewer)}</p></div><button className="close-button" onClick={() => setViewer(null)} aria-label="미리보기 닫기">×</button></header>
            <div className="viewer-banner"><span>{viewer.source_kind === "pdf" ? pdfContextLabel(viewer) : viewer.source_kind === "word" ? "3-section context" : "adjacent rows"}</span>{viewer.source_kind === "pdf" ? pdfContextDescription(viewer) : viewer.source_kind === "word" ? " 검색 결과가 포함된 Word 문맥 구간과 앞·뒤 구간을 표시합니다." : " 적중 행과 앞·뒤 인접 행을 함께 표시합니다."}</div>
            {viewer.source_kind === "pdf" ? <PdfContextPreview key={`${viewer.document_id}:${viewer.context_pages?.from ?? Math.max(1, (viewer.page ?? 1) - 1)}:${viewer.context_pages?.to ?? (viewer.page ?? 1) + 1}`} documentId={viewer.document_id} from={viewer.context_pages?.from ?? Math.max(1, (viewer.page ?? 1) - 1)} to={viewer.context_pages?.to ?? (viewer.page ?? 1) + 1} activePage={viewer.page ?? 1} /> : <div className="page-strip actual-pages">
              {contextRecords.map((record) => <article className={"paper-page " + (record.id === viewer.id ? "active-page" : "muted-page")} key={record.id}><div className="paper-head"><span>{record.file_name}</span><b>{locationLabel(record)}</b></div><h4>{record.title}</h4><p className="actual-page-text">{record.body || "텍스트를 읽을 수 없는 행입니다."}</p></article>)}
            </div>}
            <footer><div><b>표시 범위</b><span>{viewer.source_kind === "pdf" ? "p. " + (viewer.context_pages?.from ?? Math.max(1, (viewer.page ?? 1) - 1)) + "–" + (viewer.context_pages?.to ?? (viewer.page ?? 1) + 1) : viewer.source_kind === "word" ? "앞·뒤 문맥 구간" : locationLabel(viewer) + " 인접 행"}</span></div><button className="button secondary" onClick={() => toggleSelected(viewer.id)}>{selected.has(viewer.id) ? "✓ 요약 보고서에 포함됨" : "＋ 요약 보고서에 포함"}</button><button className="button secondary" onClick={() => openFullOriginal(viewer)}>원본 전체 열기 ↗</button><button className="button primary" onClick={() => setViewer(null)}>닫기</button></footer>
          </section>
        </div>
      )}

      {reportOpen && (
        <div className="drawer-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !reportGenerating) setReportOpen(false); }}>
          <aside className="report-drawer" role="dialog" aria-modal="true" aria-label="요약 보고서 만들기">
            <header><div className="report-icon">CS</div><div><span>GEMINI SUMMARY REPORT</span><h2>검색 결과 요약 보고서</h2></div><button className="close-button" disabled={reportGenerating} onClick={() => setReportOpen(false)} aria-label="보고서 닫기">×</button></header>
            {!reportGenerated || !aiReport ? (
              <div className="report-setup">
                <div className="report-question"><span>요약 주제</span><p>{searchedQuery}</p></div>
                <div className="report-language-select"><span>보고서 언어</span><div><button type="button" className={reportLanguage === "ko" ? "active" : ""} disabled={reportGenerating} onClick={() => setReportLanguage("ko")}>한국어</button><button type="button" className={reportLanguage === "en" ? "active" : ""} disabled={reportGenerating} onClick={() => setReportLanguage("en")}>English</button></div></div>
                <div className="setup-section"><div className="setup-title"><h3>요약할 검색 결과</h3><span>{selectedHits.length}개</span></div><div className="evidence-list">{selectedHits.map((hit) => <div key={hit.record.id}><span className={"mini-dot " + typeDefinitionFor(hit.record).color} /><div><b>{hit.record.title}</b><span>{hit.record.file_name} · {locationLabel(hit.record)}</span></div><strong>{hit.score}</strong></div>)}{selectedHits.length === 0 && <p className="no-evidence">검색 결과 목록에서 요약할 항목을 선택해 주세요.</p>}</div></div>
                <div className="grounding-note"><b>✓</b><p><strong>선택한 원문 문맥만 Gemini로 분석</strong><span>{reportLanguage === "ko" ? "주요 내용·요구사항·수치·예외·위험·권고사항을 한국어로 정리합니다." : "Key content, requirements, figures, exceptions, risks, and recommendations will be written in English."}</span></p></div>
                <div className="ai-summary-connected-note"><b>Gemini 연결 완료</b><span>무료 API 사용 한도에 도달하면 잠시 후 다시 시도해야 할 수 있습니다.</span></div>
                {selectedHits.length > 10 && <p className="ai-report-limit-note">한 번에 관련도순 10개 결과까지만 분석합니다.</p>}
                {reportError && <div className="ai-report-error" role="alert">{reportError}</div>}
                <button className="generate-button" disabled={!selectedHits.length || reportGenerating} onClick={handleGenerateReport}>{reportGenerating ? "Gemini가 원문을 분석하는 중…" : "요약 보고서 생성"}</button>
              </div>
            ) : (
              <div className="report-preview">
                <div className="report-complete"><b>✓</b><div><strong>Gemini 요약 보고서가 생성되었습니다</strong><span>{Math.min(selectedHits.length, 10)}개 선택 근거 · Word·PDF 출력 가능</span></div></div>
                <article><div className="report-cover"><span>ANYSCOPE · GEMINI SUMMARY</span><h1>{aiReport.title || searchedQuery}</h1><p>{new Date().toLocaleDateString(reportLabels.dateLocale)} · {reportLabels.internal}</p></div><h2>{reportLabels.summary}</h2><p>{aiReport.executiveSummary}</p><div className="report-callout conclusion"><b>{reportLabels.assessment}</b><p>{aiReport.overallAssessment}</p></div><h2>{reportLabels.findings}</h2><ol>{aiReport.keyFindings.map((finding, index) => <li key={finding.heading + index}><b>{finding.heading}</b><p>{finding.summary}</p><span>{reportLabels.evidence}: {finding.evidenceRefs.join(", ") || reportLabels.selectedSource}</span></li>)}</ol><h2>{reportLabels.requirements}</h2><ul>{aiReport.requirements.length ? aiReport.requirements.map((item, index) => <li key={item + index}>{item}</li>) : <li>{reportLabels.noRequirements}</li>}</ul><h2>{reportLabels.risks}</h2><ul>{aiReport.risksAndExceptions.length ? aiReport.risksAndExceptions.map((item, index) => <li key={item + index}>{item}</li>) : <li>{reportLabels.noRisks}</li>}</ul><h2>{reportLabels.recommendations}</h2><ul>{aiReport.recommendations.map((item, index) => <li key={item + index}>{item}</li>)}</ul><div className="report-callout"><b>{reportLabels.limitations}</b><p>{aiReport.limitations.join(" ") || reportLabels.defaultLimitation}</p></div></article>
                <div className="report-export"><button className="button secondary" onClick={() => { setReportGenerated(false); setAiReport(null); }}>근거 다시 선택</button><button className="button secondary" onClick={() => window.print()}>PDF 저장/인쇄</button><button className="button primary" disabled={reportDownloading} onClick={handleReportDownload}>{reportDownloading ? "Word 만드는 중…" : "Word 내려받기"} <span>↓</span></button></div>
              </div>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}
