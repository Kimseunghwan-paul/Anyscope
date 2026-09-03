type KdsEnv = {
  DOCUMENTS: R2Bucket;
  KCSC_API_KEY?: string;
};

type KdsCatalogItem = {
  codeType?: string;
  code?: string;
  fullCode?: string;
  name?: string;
  version?: string;
  updateDate?: string;
  message?: string | null;
};

type KdsSection = {
  no?: number;
  sort?: number;
  title?: string;
  level?: number;
  label?: string;
  contents?: string;
};

type KdsViewerItem = KdsCatalogItem & { list?: KdsSection[] | null };

const KDS_ORIGIN = "https://kcsc.re.kr";
const CATALOG_KEY = "external/kds/catalog.json";
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const VIEWER_CONCURRENCY = 8;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function normalized(value: string) {
  return value.toLowerCase().replace(/kds\s*/gi, "").replace(/[^0-9a-z가-힣]+/g, " ").trim();
}

function queryTerms(value: string) {
  return normalized(value).split(/\s+/).filter((term) => term.length >= 2 || /^\d+$/.test(term));
}

function decodeHtml(value: string) {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/li>|<\/tr>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"").replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

async function upstreamJson<T>(url: string) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`KCSC API ${response.status}`);
  const value = await response.json() as T;
  return value;
}

async function loadCatalog(env: KdsEnv) {
  const cached = await env.DOCUMENTS.get(CATALOG_KEY);
  if (cached) {
    const cachedAt = Number(cached.customMetadata?.cachedAt ?? 0);
    if (Date.now() - cachedAt < CATALOG_MAX_AGE_MS) return await new Response(cached.body).json() as KdsCatalogItem[];
  }
  const catalog = await upstreamJson<KdsCatalogItem[]>(`${KDS_ORIGIN}/OpenApi/CodeList?key=${encodeURIComponent(env.KCSC_API_KEY ?? "")}`);
  const kdsOnly = catalog.filter((item) => item.codeType?.toUpperCase() === "KDS" && item.code && item.name && !item.message);
  await env.DOCUMENTS.put(CATALOG_KEY, JSON.stringify(kdsOnly), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { cachedAt: String(Date.now()) },
  });
  return kdsOnly;
}

function candidateScore(item: KdsCatalogItem, query: string) {
  const terms = queryTerms(query);
  const code = normalized(`${item.code ?? ""} ${item.fullCode ?? ""}`);
  const name = normalized(item.name ?? "");
  const compactQuery = normalized(query).replace(/\s/g, "");
  let score = code.replace(/\s/g, "").includes(compactQuery) ? 120 : 0;
  if (name.includes(normalized(query))) score += 100;
  for (const term of terms) {
    if (name.includes(term)) score += 24;
    if (code.includes(term)) score += 18;
  }
  return score;
}

async function loadViewer(env: KdsEnv, item: KdsCatalogItem) {
  const code = item.code ?? "";
  const version = item.version ?? "current";
  const key = `external/kds/viewer/${code}-${version}.json`;
  const cached = await env.DOCUMENTS.get(key);
  if (cached) return await new Response(cached.body).json() as KdsViewerItem[];
  const viewer = await upstreamJson<KdsViewerItem[]>(`${KDS_ORIGIN}/OpenApi/CodeViewer/KDS/${encodeURIComponent(code)}?key=${encodeURIComponent(env.KCSC_API_KEY ?? "")}`);
  await env.DOCUMENTS.put(key, JSON.stringify(viewer), { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  return viewer;
}

function toRecords(item: KdsCatalogItem, viewer: KdsViewerItem[]) {
  const source = viewer[0] ?? item;
  const code = source.code ?? item.code ?? "";
  const formattedCode = code.replace(/(\d{2})(\d{2})(\d{2})/, "$1 $2 $3");
  const standardName = source.name ?? item.name ?? `KDS ${formattedCode}`;
  const externalUrl = `${KDS_ORIGIN}/standardCode/viewer/KDS%20${formattedCode.replace(/ /g, "%20")}`;
  return (source.list ?? []).map((section, index) => {
    const body = decodeHtml(section.contents ?? "");
    const title = decodeHtml(section.title ?? section.label ?? `조항 ${index + 1}`);
    return {
      id: `kds-${code}-${section.no ?? section.sort ?? index}`,
      document_id: `kds-${code}`,
      document_type: "KDS 국가설계기준",
      document_type_id: "kds",
      file_name: `KDS ${formattedCode} ${standardName}`,
      source_kind: "word",
      section: title,
      title,
      body: body || title,
      text_available: true,
      ocr_status: "not_needed",
      external_source: "kds",
      external_url: externalUrl,
      kds_code: `KDS ${formattedCode}`,
      kds_version: source.version ?? item.version ?? "",
      kds_updated_at: source.updateDate ?? item.updateDate ?? "",
    };
  });
}

export async function handleKdsRequest(request: Request, env: KdsEnv, url: URL) {
  if (!url.pathname.startsWith("/api/kds/")) return null;
  if (request.method !== "GET" || url.pathname !== "/api/kds/search") return json({ message: "지원하지 않는 KDS 요청입니다." }, 405);
  if (!env.KCSC_API_KEY) return json({ message: "KDS API 인증키가 등록되지 않았습니다." }, 503);
  const query = (url.searchParams.get("q") ?? "").trim();
  if (query.length < 2) return json({ message: "KDS 검색어를 두 글자 이상 입력해 주세요." }, 400);
  try {
    const catalog = await loadCatalog(env);
    const ranked = catalog.map((item) => ({ item, score: candidateScore(item, query) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 16);
    const records: Record<string, unknown>[] = [];
    for (let offset = 0; offset < ranked.length; offset += VIEWER_CONCURRENCY) {
      const batch = ranked.slice(offset, offset + VIEWER_CONCURRENCY);
      const loaded = await Promise.all(batch.map(async ({ item }) => toRecords(item, await loadViewer(env, item))));
      records.push(...loaded.flat());
    }
    return json({ records, candidate_count: ranked.length, catalog_count: catalog.length, source: "KCSC OpenAPI" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown KDS API error";
    return json({ message: "국가건설기준센터에서 KDS 데이터를 불러오지 못했습니다.", detail }, 502);
  }
}
