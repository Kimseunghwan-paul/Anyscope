import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const wranglerPackage = require.resolve("wrangler/package.json");
const miniflareEntry = require.resolve("miniflare", { paths: [dirname(wranglerPackage)] });
const { Miniflare } = await import(pathToFileURL(miniflareEntry).href);
const miniflareInstances = [];
const migrationSql = await readFile(new URL("../drizzle/0000_mixed_malice.sql", import.meta.url), "utf8");
const lifecycleMigrationSql = await readFile(new URL("../drizzle/0001_brainy_lionheart.sql", import.meta.url), "utf8");
const ocrShardMigrationSql = await readFile(new URL("../drizzle/0002_ocr_record_shards.sql", import.meta.url), "utf8");
const appSettingsMigrationSql = await readFile(new URL("../drizzle/0003_cold_hardball.sql", import.meta.url), "utf8");

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", String(process.pid) + "-" + String(Date.now()) + "-" + Math.random());
  return (await import(workerUrl.href)).default;
}

function createBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, body, options = {}) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { bytes, httpMetadata: options.httpMetadata || {}, customMetadata: options.customMetadata || {} });
    },
    async head(key) {
      const object = objects.get(key);
      return object ? { size: object.bytes.byteLength, httpMetadata: object.httpMetadata, customMetadata: object.customMetadata } : null;
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return { body: new Response(object.bytes).body, size: object.bytes.byteLength, httpMetadata: object.httpMetadata, customMetadata: object.customMetadata, httpEtag: "test-etag", writeHttpMetadata() {} };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
}

async function createDatabase() {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: ["DB"],
  });
  miniflareInstances.push(miniflare);
  const database = await miniflare.getD1Database("DB");
  for (const statement of `${migrationSql}\n--> statement-breakpoint\n${lifecycleMigrationSql}\n--> statement-breakpoint\n${ocrShardMigrationSql}\n--> statement-breakpoint\n${appSettingsMigrationSql}`.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
    await database.prepare(statement).run();
  }
  return database;
}

async function environment(bucket = createBucket()) {
  return {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    DB: await createDatabase(),
    DOCUMENTS: bucket,
    CLAUSESCOPE_PASSCODE: "test-team-passcode",
  };
}

const context = { waitUntil() {}, passThroughOnException() {} };
test.after(async () => Promise.all(miniflareInstances.map((instance) => instance.dispose())));

async function bootstrapAdmin(worker, env, username = "admin", password = "test-admin-password") {
  const response = await worker.fetch(new Request("https://example.test/api/auth/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      legacy_passcode: "test-team-passcode",
      username,
      display_name: "Test Administrator",
      password,
    }),
  }), env, context);
  assert.equal(response.status, 201);
  const passwordRow = await env.DB.prepare(
    "SELECT password_iterations FROM users WHERE username = ?",
  ).bind(username).first();
  assert.equal(passwordRow.password_iterations, 100_000);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  return cookie;
}

async function uploadTestOriginal(worker, env, cookie, documentId = "report-document-123") {
  const response = await worker.fetch(new Request(`https://example.test/api/documents/${documentId}`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent("test.pdf") },
    body: new Uint8Array([1, 2, 3]),
  }), env, context);
  assert.equal(response.status, 200);
  return documentId;
}

async function loginUser(worker, env, username, password) {
  const response = await worker.fetch(new Request("https://example.test/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }), env, context);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const payload = await response.clone().json();
  if (!payload.user?.mustChangePassword) return cookie;
  const changed = await worker.fetch(new Request("https://example.test/api/auth/password", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ current_password: password, new_password: `${password}-changed` }),
  }), env, context);
  assert.equal(changed.status, 200);
  const changedCookie = changed.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(changedCookie);
  return changedCookie;
}

test("server-renders the AnyScope team access gate", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), await environment(), context);
  assert.equal(response.status, 200);
  assert.ok((response.headers.get("content-type") ?? "").startsWith("text/html"));
  const html = await response.text();
  assert.ok(html.includes("AnyScope"));
  assert.ok(html.includes("보호 상태를 확인하는 중입니다"));
});

test("requires a valid team session for indexes", async () => {
  const worker = await loadWorker();
  const bucket = createBucket();
  const env = await environment(bucket);
  const denied = await worker.fetch(new Request("https://example.test/api/corpus"), env, context);
  assert.equal(denied.status, 401);
  const wrong = await worker.fetch(new Request("https://example.test/api/auth/bootstrap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ legacy_passcode: "wrong", username: "admin", display_name: "Admin", password: "test-admin-password" }) }), env, context);
  assert.equal(wrong.status, 401);
  const cookie = await bootstrapAdmin(worker, env);
  const loaded = await worker.fetch(new Request("https://example.test/api/manifest", { headers: { Cookie: cookie } }), env, context);
  assert.equal(loaded.status, 200);
  const loadedManifest = await loaded.json();
  assert.equal(typeof loadedManifest.generated_at, "string");
  delete loadedManifest.generated_at;
  assert.deepEqual(loadedManifest, {
    documents: [],
    record_count: 0,
    privacy: "personal-workspace",
    workspace_title: "프로젝트 문서 검색",
    document_types: [],
    text_record_count: 0,
    ocr_pending_record_count: 0,
  });
});

test("administrator can update the displayed AnyScope version", async () => {
  const worker = await loadWorker();
  const env = await environment();
  const cookie = await bootstrapAdmin(worker, env);
  const initialResponse = await worker.fetch(new Request("https://example.test/api/auth/status", { headers: { Cookie: cookie } }), env, context);
  assert.equal(initialResponse.status, 200);
  assert.equal((await initialResponse.json()).app_version, "1.0");

  const updateResponse = await worker.fetch(new Request("https://example.test/api/admin/settings", {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ app_version: "1.1" }),
  }), env, context);
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).app_version, "1.1");

  const updatedResponse = await worker.fetch(new Request("https://example.test/api/auth/status", { headers: { Cookie: cookie } }), env, context);
  assert.equal((await updatedResponse.json()).app_version, "1.1");
});

test("does not ship the corpus as a public static asset", async () => {
  const [hostingText, pageText, documentToolsText, ocrText, cssText, pdfPreviewText, pdfConfigText, workerText, reportToolsText] = await Promise.all([
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/document-tools.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/ocr-tools.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/pdf-context-preview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/pdfjs-config.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/report-tools.ts", import.meta.url), "utf8"),
  ]);
  assert.equal(JSON.parse(hostingText).r2, "DOCUMENTS");
  assert.ok(pageText.includes("/api/corpus"));
  assert.ok(!pageText.includes("/data/corpus.ndjson"));
  assert.ok(pageText.includes("RESULTS_PER_PAGE = 10"));
  assert.ok(pageText.includes("searchMode === \"and\""));
  assert.ok(pageText.includes("searchMode === \"or\""));
  assert.ok(pageText.includes('className="search-mode-selector"'));
  assert.ok(pageText.includes("AND는 모든 검색 개념을 포함한 결과를"));
  assert.ok(pageText.includes("찾고 싶은 내용을 키워드 또는 문장으로 입력하세요"));
  assert.ok(pageText.includes("현재 페이지 결과 전체 선택"));
  assert.ok(pageText.includes("workspace-title"));
  assert.ok(pageText.includes("DOCUMENT INTELLIGENCE"));
  assert.ok(pageText.includes("찾으시는 내용을"));
  assert.ok(pageText.includes("신속·정확하게 검색하세요!"));
  assert.ok(!pageText.includes("TEAM DOCUMENT INTELLIGENCE"));
  assert.ok(!pageText.includes(">팀 비밀번호</label>"));
  assert.ok(pageText.includes("moveDocumentType"));
  assert.ok(pageText.includes("맨 위로 이동"));
  assert.ok(pageText.includes("OCR 결과 DOCX"));
  assert.ok(!pageText.includes("다른 사용자에게 복사"));
  assert.ok(!workerText.includes("/api/admin/documents/copy"));
  assert.ok(pageText.includes("AnyScope 표시 버전"));
  assert.ok(pageText.includes("최대 18점으로 제한합니다"));
  assert.ok(pageText.includes("minimumConceptSpan"));
  assert.ok(pageText.includes("NORMATIVE_PATTERN"));
  assert.ok(pageText.includes("applyPdfContextScopes"));
  assert.ok(pageText.includes("MAJOR_HEADING_PATTERN"));
  assert.ok(pageText.includes('context_mode: "section"'));
  assert.ok(pageText.includes("OCR 필요란?"));
  assert.ok(pageText.includes("브라우저 OCR 전체"));
  assert.ok(pageText.includes("Windows OCR 연결 (최초 1회)"));
  assert.ok(pageText.includes("launchWindowsOcr"));
  assert.ok(pageText.includes("/api/auth/ocr-launch"));
  assert.ok(pageText.includes("/downloads/anyscope-windows-ocr.zip"));
  assert.ok(pageText.includes("OCR 필요 (전체)"));
  assert.ok(pageText.includes("브라우저 OCR"));
  assert.ok(ocrText.includes("pendingBatch.length < 100"));
  assert.ok(ocrText.includes("await saveBatch(batch)"));
  assert.ok(pageText.includes('/api/library/ocr'));
  assert.ok(ocrText.includes('Tesseract.createWorker(["kor", "eng"]'));
  assert.ok(ocrText.includes("disableAutoFetch: true"));
  assert.ok(ocrText.includes("내장 텍스트를 다시 확인하는 중"));
  assert.ok(ocrText.includes('method: "embedded_text"'));
  assert.ok(pageText.includes("문서 관리"));
  assert.ok(pageText.includes("선택 문서 삭제"));
  assert.ok(pageText.includes("영어와 한글 키워드·문장 검색"));
  assert.ok(pageText.includes("검색어 예시 :"));
  assert.ok(pageText.includes('["Settlement", "Concrete Strength", "Termination", "Monitoring"]'));
  assert.ok(!pageText.includes('className="index-date"'));
  assert.ok(cssText.includes(".search-surface"));
  assert.ok(pageText.includes('const [query, setQuery] = useState("")'));
  assert.ok(pageText.includes('const [searchedQuery, setSearchedQuery] = useState("")'));
  assert.ok(!pageText.includes('className="query-caption"'));
  assert.ok(!pageText.includes("<em>TEAM</em>"));
  assert.ok(!pageText.includes("팀 비밀번호 보호"));
  assert.ok(!pageText.includes("실제 문서에서 찾고"));
  assert.ok(pageText.includes("PdfContextPreview"));
  assert.ok(pdfPreviewText.includes("PDFJS_DOCUMENT_OPTIONS"));
  assert.ok(documentToolsText.includes("PDFJS_DOCUMENT_OPTIONS"));
  assert.ok(ocrText.includes("PDFJS_DOCUMENT_OPTIONS"));
  assert.ok(pdfConfigText.includes('wasmUrl: "/pdfjs/wasm/"'));
  assert.ok(pdfConfigText.includes('iccUrl: "/pdfjs/iccs/"'));
  await Promise.all([
    access(new URL("../public/pdfjs/wasm/openjpeg.wasm", import.meta.url)),
    access(new URL("../public/pdfjs/wasm/jbig2.wasm", import.meta.url)),
    access(new URL("../public/pdfjs/iccs/CGATS001Compat-v2-micro.icc", import.meta.url)),
    access(new URL("../public/pdfjs/cmaps/Adobe-GB1-UCS2.bcmap", import.meta.url)),
    access(new URL("../public/pdfjs/standard_fonts/FoxitFixed.pfb", import.meta.url)),
  ]);
  assert.ok(pageText.includes("원본 전체 열기"));
  assert.ok(pageText.includes("window.open"));
  assert.ok(pageText.includes("Word 내려받기"));
  assert.ok(pageText.includes("results-table"));
  assert.ok(pageText.includes("목록 내려받기"));
  assert.ok(pageText.includes("요약 보고서 만들기"));
  assert.ok(!pageText.includes(">근거 보고서 만들기"));
  assert.ok(pageText.includes("Gemini 연결 완료"));
  assert.ok(pageText.includes('fetch("/api/report"'));
  assert.ok(pageText.includes("PDF 저장/인쇄"));
  assert.ok(!pageText.includes("AI 요약 연결 대기"));
  assert.ok(workerText.includes("GEMINI_API_KEY"));
  assert.ok(workerText.includes('"x-goog-api-key"'));
  assert.ok(workerText.includes('"gemini-3.5-flash"'));
  assert.ok(reportToolsText.includes("buildGeminiWordReport"));
  assert.ok(pageText.includes("XLSX.writeFile"));
  assert.ok(pageText.includes("/api/library/document-types"));
  assert.ok(pageText.includes("documentTypeLabel"));
  assert.ok(pageText.includes("recommendDocumentType"));
  assert.ok(!pageText.includes("자동 추천 키워드"));
  assert.ok(!pageText.includes("newTypeKeywords"));
  assert.ok(documentToolsText.includes("document_type_id"));
  assert.ok(!pageText.includes("STANDARD_TYPES"));
  assert.ok(!pageText.includes("STANDARD_CATEGORIES"));
  assert.ok(!pageText.includes("실제 점수 정책"));
  assert.ok(!pageText.includes("filter-group weighting"));
  assert.ok(cssText.includes("grid-template-columns: minmax(0,1fr) !important"));
  assert.ok(cssText.includes("display: flex !important"));
  assert.ok(cssText.includes('Arial,"Malgun Gothic","맑은 고딕",sans-serif'));
  assert.ok(pdfPreviewText.includes("renderScale"));
  assert.ok(pdfPreviewText.includes("URL.createObjectURL"));
  assert.ok(pdfPreviewText.includes("width={page.width}"));
  assert.ok(!pageText.includes("<iframe"));
  await assert.rejects(access(new URL("../public/data/corpus.ndjson", import.meta.url)));
});

test("ships Windows OCR launch and one-time setup files in Windows PowerShell 5 compatible encodings", async () => {
  const [scriptBytes, launcherBytes, installerBytes, installerLauncherBytes] = await Promise.all([
    readFile(new URL("../public/downloads/anyscope-windows-ocr/AnyScope-Windows-OCR.ps1", import.meta.url)),
    readFile(new URL("../public/downloads/anyscope-windows-ocr/Run-AnyScope-OCR.cmd", import.meta.url)),
    readFile(new URL("../public/downloads/anyscope-windows-ocr/Install-AnyScope-OCR.ps1", import.meta.url)),
    readFile(new URL("../public/downloads/anyscope-windows-ocr/Install-AnyScope-OCR.cmd", import.meta.url)),
  ]);
  assert.deepEqual([...scriptBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.deepEqual([...installerBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(!scriptBytes.toString("utf8").replace(/\r\n/g, "").includes("\n"));
  assert.ok(!launcherBytes.toString("utf8").replace(/\r\n/g, "").includes("\n"));
  assert.ok(!installerBytes.toString("utf8").replace(/\r\n/g, "").includes("\n"));
  assert.ok(!installerLauncherBytes.toString("utf8").replace(/\r\n/g, "").includes("\n"));
});

test("starts empty and persists user-defined document types", async () => {
  const worker = await loadWorker();
  const env = await environment();
  const cookie = await bootstrapAdmin(worker, env);

  const emptyManifest = await worker.fetch(new Request("https://example.test/api/manifest", {
    headers: { Cookie: cookie },
  }), env, context).then((response) => response.json());
  assert.deepEqual(emptyManifest.documents, []);
  assert.deepEqual(emptyManifest.document_types, []);

  const documentTypes = [
    { id: "international", name: "International Standard", color: "navy", keywords: ["international"], sort_order: 10 },
    { id: "international-design", name: "Design", parent_id: "international", color: "orange", keywords: ["design"], sort_order: 10 },
    { id: "local", name: "Local Standard", color: "teal", keywords: ["local"], sort_order: 20 },
    { id: "local-design", name: "Design", parent_id: "local", color: "violet", keywords: ["design"], sort_order: 10 },
  ];
  const saved = await worker.fetch(new Request("https://example.test/api/library/document-types", {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ document_types: documentTypes }),
  }), env, context);
  assert.equal(saved.status, 200);

  const savedSettings = await worker.fetch(new Request("https://example.test/api/library/settings", {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ workspace_title: "A Project용 AnyScope" }),
  }), env, context);
  assert.equal(savedSettings.status, 200);

  const manifest = await worker.fetch(new Request("https://example.test/api/manifest", {
    headers: { Cookie: cookie },
  }), env, context).then((response) => response.json());
  assert.deepEqual(manifest.document_types, documentTypes);
  assert.equal(manifest.workspace_title, "A Project용 AnyScope");

  const corpus = await worker.fetch(new Request("https://example.test/api/corpus", {
    headers: { Cookie: cookie },
  }), env, context);
  assert.equal(corpus.status, 200);
  assert.equal(await corpus.text(), "");
});

test("accepts a newly named document and appends its searchable records", async () => {
  const worker = await loadWorker();
  const bucket = createBucket();
  const env = await environment(bucket);
  const cookie = await bootstrapAdmin(worker, env);
  const id = "document-12345-abcdef";
  const original = await worker.fetch(new Request(`https://example.test/api/documents/${id}`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent("새 입찰자료.pdf") }, body: new Uint8Array([1, 2, 3]) }), env, context);
  assert.equal(original.status, 200);
  const saved = await worker.fetch(new Request("https://example.test/api/library/documents", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ document: { id, display_name: "새 입찰자료.pdf", type: "입찰문서", source_kind: "pdf", record_count: 1, text_pages: 0, ocr_pending_pages: 1 }, records: [{ id: `${id}-page-1`, document_id: id, document_type: "입찰문서", file_name: "새 입찰자료.pdf", page: 1, title: "Page 1", body: "", text_available: false, ocr_status: "pending" }] }) }), env, context);
  assert.equal(saved.status, 200);
  const manifest = await worker.fetch(new Request("https://example.test/api/manifest", { headers: { Cookie: cookie } }), env, context).then((response) => response.json());
  assert.equal(manifest.documents.length, 1);
  assert.equal(manifest.record_count, 1);
  const loadedOriginal = await worker.fetch(new Request(`https://example.test/api/documents/${id}`, { headers: { Cookie: cookie } }), env, context);
  assert.equal(loadedOriginal.status, 200);
  assert.match(loadedOriginal.headers.get("content-disposition") || "", /%EC%83%88/);
  const pendingOcr = await worker.fetch(new Request("https://example.test/api/library/ocr/pending", { headers: { Cookie: cookie } }), env, context);
  assert.equal(pendingOcr.status, 200);
  assert.deepEqual(await pendingOcr.json(), {
    documents: [{ id, display_name: "새 입찰자료.pdf", pending_count: 1 }],
    records: [{ id: `${id}-page-1`, document_id: id, page: 1, title: "Page 1" }],
  });
  const launchResponse = await worker.fetch(new Request("https://example.test/api/auth/ocr-launch", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ document_id: id }) }), env, context);
  assert.equal(launchResponse.status, 200);
  const launchUrl = new URL((await launchResponse.json()).launch_url);
  assert.equal(launchUrl.protocol, "anyscope-ocr:");
  assert.equal(launchUrl.searchParams.get("document"), id);
  const ocrToken = launchUrl.searchParams.get("token");
  assert.ok(ocrToken);
  const tokenHeaders = { "X-AnyScope-OCR-Token": ocrToken };
  const tokenPending = await worker.fetch(new Request("https://example.test/api/library/ocr/pending", { headers: tokenHeaders }), env, context);
  assert.equal(tokenPending.status, 200);
  assert.equal((await tokenPending.json()).documents[0].id, id);
  const tokenOriginal = await worker.fetch(new Request(`https://example.test/api/documents/${id}`, { headers: tokenHeaders }), env, context);
  assert.equal(tokenOriginal.status, 200);
  const unrelatedOriginal = await worker.fetch(new Request("https://example.test/api/documents/document-other-123", { headers: tokenHeaders }), env, context);
  assert.equal(unrelatedOriginal.status, 401);
  const ocrSaved = await worker.fetch(new Request("https://example.test/api/library/ocr", { method: "PATCH", headers: { ...tokenHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ engine: "Windows.Media.Ocr (Windows native helper)", dpi: 150, updates: [{ record_id: `${id}-page-1`, document_id: id, body: "Geotextile shall meet the specified requirements.", title: "Geotextile Requirements" }] }) }), env, context);
  assert.equal(ocrSaved.status, 200);
  assert.equal((await ocrSaved.json()).completed_records, 1);
  const manifestAfterOcr = await worker.fetch(new Request("https://example.test/api/manifest", { headers: { Cookie: cookie } }), env, context).then((response) => response.json());
  assert.equal(manifestAfterOcr.text_record_count, 1);
  assert.equal(manifestAfterOcr.ocr_pending_record_count, 0);
  assert.equal(manifestAfterOcr.documents[0].ocr_pending_pages, 0);
  assert.equal(manifestAfterOcr.ocr.engine, "Windows.Media.Ocr (Windows native helper)");
  assert.equal(manifestAfterOcr.ocr.dpi, 150);
  const corpusAfterOcr = await worker.fetch(new Request("https://example.test/api/corpus", { headers: { Cookie: cookie } }), env, context).then((response) => response.text());
  assert.match(corpusAfterOcr, /Geotextile shall meet/);
  const adminId = (await env.DB.prepare("SELECT id FROM users WHERE username = 'admin'").first()).id;
  const baseCorpus = new TextDecoder().decode(bucket.objects.get(`users/${adminId}/indexes/corpus.ndjson`).bytes);
  assert.match(baseCorpus, /"ocr_status":"pending"/);
  assert.doesNotMatch(baseCorpus, /Geotextile shall meet/);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS count FROM record_shards WHERE user_id = ?").bind(adminId).first()).count, 1);
  const duplicateSave = await worker.fetch(new Request("https://example.test/api/library/ocr", { method: "PATCH", headers: { ...tokenHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ updates: [{ record_id: `${id}-page-1`, document_id: id, body: "Geotextile shall meet the specified requirements.", title: "Geotextile Requirements" }] }) }), env, context);
  assert.equal(duplicateSave.status, 200);
  assert.equal((await duplicateSave.json()).completed_records, 0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS count FROM record_shards WHERE user_id = ?").bind(adminId).first()).count, 1);
  const deleted = await worker.fetch(new Request("https://example.test/api/library/documents", { method: "DELETE", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ document_ids: [id] }) }), env, context);
  assert.equal(deleted.status, 200);
  const deletionResult = await deleted.json();
  assert.equal(deletionResult.deleted_records, 1);
  assert.equal(deletionResult.deleted_original_files, 1);
  const manifestAfterDelete = await worker.fetch(new Request("https://example.test/api/manifest", { headers: { Cookie: cookie } }), env, context).then((response) => response.json());
  assert.equal(manifestAfterDelete.documents.length, 0);
  assert.equal(manifestAfterDelete.record_count, 0);
  const corpusAfterDelete = await worker.fetch(new Request("https://example.test/api/corpus", { headers: { Cookie: cookie } }), env, context).then((response) => response.text());
  assert.equal(corpusAfterDelete, "");
  const missingOriginal = await worker.fetch(new Request(`https://example.test/api/documents/${id}`, { headers: { Cookie: cookie } }), env, context);
  assert.equal(missingOriginal.status, 404);
});

test("forces new users to replace temporary passwords before opening a workspace", async () => {
  const worker = await loadWorker();
  const env = await environment();
  const adminCookie = await bootstrapAdmin(worker, env);
  const created = await worker.fetch(new Request("https://example.test/api/admin/users", {
    method: "POST",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "password.user",
      display_name: "Password User",
      password: "temporary-password-123",
      quota_bytes: 1024 ** 3,
      max_documents: 25,
    }),
  }), env, context);
  assert.equal(created.status, 201);
  assert.equal((await created.json()).user.mustChangePassword, true);

  const login = await worker.fetch(new Request("https://example.test/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "password.user", password: "temporary-password-123" }),
  }), env, context);
  assert.equal(login.status, 200);
  const loginPayload = await login.clone().json();
  assert.equal(loginPayload.user.mustChangePassword, true);
  const temporaryCookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(temporaryCookie);

  const blocked = await worker.fetch(new Request("https://example.test/api/manifest", {
    headers: { Cookie: temporaryCookie },
  }), env, context);
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).code, "PASSWORD_CHANGE_REQUIRED");

  const changed = await worker.fetch(new Request("https://example.test/api/auth/password", {
    method: "POST",
    headers: { Cookie: temporaryCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      current_password: "temporary-password-123",
      new_password: "personal-password-456",
    }),
  }), env, context);
  assert.equal(changed.status, 200);
  assert.equal((await changed.clone().json()).user.mustChangePassword, false);
  const personalCookie = changed.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(personalCookie);
  const opened = await worker.fetch(new Request("https://example.test/api/manifest", {
    headers: { Cookie: personalCookie },
  }), env, context);
  assert.equal(opened.status, 200);

  const oldLogin = await worker.fetch(new Request("https://example.test/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "password.user", password: "temporary-password-123" }),
  }), env, context);
  assert.equal(oldLogin.status, 401);
  const newLogin = await worker.fetch(new Request("https://example.test/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "password.user", password: "personal-password-456" }),
  }), env, context);
  assert.equal(newLogin.status, 200);
});

test("isolates documents, indexes, settings, and direct document URLs between personal accounts", async () => {
  const worker = await loadWorker();
  const bucket = createBucket();
  const env = await environment(bucket);
  const adminCookie = await bootstrapAdmin(worker, env);
  const adminDocumentId = "admin-private-document-123";
  await uploadTestOriginal(worker, env, adminCookie, adminDocumentId);
  const indexed = await worker.fetch(new Request("https://example.test/api/library/documents", {
    method: "POST",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      document: { id: adminDocumentId, display_name: "admin.pdf", type: "관리자 자료", source_kind: "pdf", record_count: 1, text_pages: 1, ocr_pending_pages: 0 },
      records: [{ id: `${adminDocumentId}-page-1`, document_id: adminDocumentId, document_type: "관리자 자료", file_name: "admin.pdf", source_kind: "pdf", page: 1, title: "Private", body: "Administrator only evidence", text_available: true, ocr_status: "not_needed" }],
    }),
  }), env, context);
  assert.equal(indexed.status, 200);

  const createUser = await worker.fetch(new Request("https://example.test/api/admin/users", {
    method: "POST",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "team.member", display_name: "Team Member", password: "member-password-123", quota_bytes: 1024 ** 3, max_documents: 25 }),
  }), env, context);
  assert.equal(createUser.status, 201);
  const memberCookie = await loginUser(worker, env, "team.member", "member-password-123");

  const memberManifest = await worker.fetch(new Request("https://example.test/api/manifest", {
    headers: { Cookie: memberCookie },
  }), env, context).then((response) => response.json());
  assert.deepEqual(memberManifest.documents, []);
  assert.deepEqual(memberManifest.document_types, []);

  const memberCorpus = await worker.fetch(new Request("https://example.test/api/corpus", {
    headers: { Cookie: memberCookie },
  }), env, context);
  assert.equal(await memberCorpus.text(), "");

  const directAccess = await worker.fetch(new Request(`https://example.test/api/documents/${adminDocumentId}`, {
    headers: { Cookie: memberCookie },
  }), env, context);
  assert.equal(directAccess.status, 404);

  const crossDelete = await worker.fetch(new Request("https://example.test/api/library/documents", {
    method: "DELETE",
    headers: { Cookie: memberCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ document_ids: [adminDocumentId] }),
  }), env, context);
  assert.equal(crossDelete.status, 404);

  const memberSettings = await worker.fetch(new Request("https://example.test/api/library/settings", {
    method: "PUT",
    headers: { Cookie: memberCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ workspace_title: "팀원 개인 작업공간" }),
  }), env, context);
  assert.equal(memberSettings.status, 200);
  const adminManifest = await worker.fetch(new Request("https://example.test/api/manifest", {
    headers: { Cookie: adminCookie },
  }), env, context).then((response) => response.json());
  assert.notEqual(adminManifest.workspace_title, "팀원 개인 작업공간");
  assert.equal(adminManifest.documents.length, 1);
});

test("deactivates, transfers without moving R2 originals, archives, and finally deletes user accounts", async () => {
  const worker = await loadWorker();
  const bucket = createBucket();
  const env = await environment(bucket);
  const adminCookie = await bootstrapAdmin(worker, env);

  async function createMember(username, displayName) {
    const response = await worker.fetch(new Request("https://example.test/api/admin/users", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        display_name: displayName,
        password: "temporary-password-123",
        quota_bytes: 1024 ** 3,
        max_documents: 25,
      }),
    }), env, context);
    assert.equal(response.status, 201);
    return (await response.json()).user;
  }

  const sourceUser = await createMember("source.user", "Source User");
  const destinationUser = await createMember("destination.user", "Destination User");
  const sourceCookie = await loginUser(worker, env, "source.user", "temporary-password-123");
  const destinationCookie = await loginUser(worker, env, "destination.user", "temporary-password-123");
  const documentId = "transfer-document-123";
  await uploadTestOriginal(worker, env, sourceCookie, documentId);
  const indexed = await worker.fetch(new Request("https://example.test/api/library/documents", {
    method: "POST",
    headers: { Cookie: sourceCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      document: { id: documentId, display_name: "transfer.pdf", type: "Transfer", source_kind: "pdf", record_count: 1, text_pages: 1, ocr_pending_pages: 0 },
      records: [{ id: `${documentId}-page-1`, document_id: documentId, document_type: "Transfer", file_name: "transfer.pdf", source_kind: "pdf", page: 1, title: "Transfer", body: "Transferred evidence", text_available: true, ocr_status: "not_needed" }],
    }),
  }), env, context);
  assert.equal(indexed.status, 200);
  const originalKey = `users/${sourceUser.id}/documents/${documentId}/original`;
  assert.ok(await bucket.head(originalKey));

  const deactivated = await worker.fetch(new Request(`https://example.test/api/admin/users/${sourceUser.id}`, {
    method: "PATCH",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ active: false }),
  }), env, context);
  assert.equal(deactivated.status, 200);
  const revoked = await worker.fetch(new Request("https://example.test/api/manifest", {
    headers: { Cookie: sourceCookie },
  }), env, context);
  assert.equal(revoked.status, 401);

  const transferred = await worker.fetch(new Request(`https://example.test/api/admin/users/${sourceUser.id}/transfer`, {
    method: "POST",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ destination_user_id: destinationUser.id }),
  }), env, context);
  assert.equal(transferred.status, 200);
  assert.equal((await transferred.json()).r2_objects_moved, 0);
  assert.ok(await bucket.head(originalKey));
  const destinationManifest = await worker.fetch(new Request("https://example.test/api/manifest", {
    headers: { Cookie: destinationCookie },
  }), env, context).then((response) => response.json());
  assert.equal(destinationManifest.documents[0].id, documentId);
  const transferredOriginal = await worker.fetch(new Request(`https://example.test/api/documents/${documentId}`, {
    headers: { Cookie: destinationCookie },
  }), env, context);
  assert.equal(transferredOriginal.status, 200);

  const archived = await worker.fetch(new Request(`https://example.test/api/admin/users/${sourceUser.id}/archive`, {
    method: "POST",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: "{}",
  }), env, context);
  assert.equal(archived.status, 200);
  const deleted = await worker.fetch(new Request(`https://example.test/api/admin/users/${sourceUser.id}/delete`, {
    method: "DELETE",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation: "source.user" }),
  }), env, context);
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).deleted_documents, 0);
  assert.ok(await bucket.head(originalKey));
  const removedUser = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(sourceUser.id).first();
  assert.equal(removedUser, null);

  const disposableUser = await createMember("disposable.user", "Disposable User");
  const disposableCookie = await loginUser(worker, env, "disposable.user", "temporary-password-123");
  const disposableDocumentId = "disposable-document-123";
  await uploadTestOriginal(worker, env, disposableCookie, disposableDocumentId);
  const disposableKey = `users/${disposableUser.id}/documents/${disposableDocumentId}/original`;
  assert.ok(await bucket.head(disposableKey));
  for (const [path, method, body] of [
    [`/api/admin/users/${disposableUser.id}`, "PATCH", { active: false }],
    [`/api/admin/users/${disposableUser.id}/archive`, "POST", {}],
    [`/api/admin/users/${disposableUser.id}/delete`, "DELETE", { confirmation: "disposable.user" }],
  ]) {
    const response = await worker.fetch(new Request(`https://example.test${path}`, {
      method,
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), env, context);
    assert.equal(response.status, 200);
  }
  assert.equal(await bucket.head(disposableKey), null);
});

test("connects legacy R2 data to the first admin without moving or deleting existing objects", async () => {
  const worker = await loadWorker();
  const bucket = createBucket();
  const legacyDocumentId = "legacy-document-123";
  await bucket.put(`uploads/${legacyDocumentId}`, new Uint8Array([9, 8, 7]), {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { originalName: "legacy.pdf", contentType: "application/pdf" },
  });
  await bucket.put("indexes/manifest.json", JSON.stringify({
    generated_at: new Date().toISOString(),
    workspace_title: "기존 운영 작업공간",
    documents: [{ id: legacyDocumentId, display_name: "legacy.pdf", type: "기존 자료", source_kind: "pdf", record_count: 1, text_pages: 1, ocr_pending_pages: 0 }],
    document_types: [{ id: "legacy-type", name: "기존 자료", color: "navy", keywords: [], sort_order: 10 }],
    record_count: 1,
    text_record_count: 1,
    ocr_pending_record_count: 0,
  }), { httpMetadata: { contentType: "application/json" } });
  await bucket.put("indexes/corpus.ndjson", JSON.stringify({
    id: `${legacyDocumentId}-page-1`,
    document_id: legacyDocumentId,
    document_type: "기존 자료",
    file_name: "legacy.pdf",
    source_kind: "pdf",
    page: 1,
    title: "Legacy",
    body: "Legacy searchable text",
    text_available: true,
    ocr_status: "not_needed",
  }) + "\n", { httpMetadata: { contentType: "application/x-ndjson" } });
  const env = await environment(bucket);
  const adminCookie = await bootstrapAdmin(worker, env);

  const connected = await worker.fetch(new Request("https://example.test/api/admin/migrations/legacy/connect", {
    method: "POST",
    headers: { Cookie: adminCookie },
  }), env, context);
  assert.equal(connected.status, 200);
  assert.equal((await connected.json()).r2_objects_deleted, 0);
  assert.ok(await bucket.head(`uploads/${legacyDocumentId}`));
  assert.ok(await bucket.head("indexes/manifest.json"));
  assert.ok(await bucket.head("indexes/corpus.ndjson"));

  const manifest = await worker.fetch(new Request("https://example.test/api/manifest", {
    headers: { Cookie: adminCookie },
  }), env, context).then((response) => response.json());
  assert.equal(manifest.workspace_title, "기존 운영 작업공간");
  assert.equal(manifest.documents[0].id, legacyDocumentId);
  const original = await worker.fetch(new Request(`https://example.test/api/documents/${legacyDocumentId}`, {
    headers: { Cookie: adminCookie },
  }), env, context);
  assert.equal(original.status, 200);
});

test("removes unused document types after deleting their last documents", async () => {
  const worker = await loadWorker();
  const bucket = createBucket();
  const env = await environment(bucket);
  const cookie = await bootstrapAdmin(worker, env);

  const documents = [
    { id: "document-design-123", display_name: "design.pdf", type: "Design", type_id: "design", source_kind: "pdf", record_count: 1, text_pages: 1, ocr_pending_pages: 0 },
    { id: "document-risk-456", display_name: "risk.pdf", type: "Risk", type_id: "risk", source_kind: "pdf", record_count: 1, text_pages: 1, ocr_pending_pages: 0 },
  ];
  const documentTypes = [
    { id: "uncategorized", name: "미분류", color: "slate", keywords: [], sort_order: 0 },
    { id: "local-standard", name: "Local Standard", color: "violet", keywords: [], sort_order: 10 },
    { id: "design", name: "Design", parent_id: "local-standard", color: "navy", keywords: [], sort_order: 20 },
    { id: "construction", name: "Construction", parent_id: "local-standard", color: "teal", keywords: [], sort_order: 30 },
    { id: "risk", name: "Risk", color: "rose", keywords: [], sort_order: 40 },
    { id: "stale-type", name: "과거 유형", color: "orange", keywords: [], sort_order: 50 },
  ];
  const records = documents.map((document) => ({
    id: `${document.id}-page-1`,
    document_id: document.id,
    document_type: document.type,
    document_type_id: document.type_id,
    file_name: document.display_name,
    source_kind: "pdf",
    page: 1,
    title: "Page 1",
    body: "searchable",
    text_available: true,
    ocr_status: "not_needed",
  }));

  const savedTypes = await worker.fetch(new Request("https://example.test/api/library/document-types", {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ document_types: documentTypes }),
  }), env, context);
  assert.equal(savedTypes.status, 200);
  for (let index = 0; index < documents.length; index += 1) {
    const document = documents[index];
    await uploadTestOriginal(worker, env, cookie, document.id);
    const savedDocument = await worker.fetch(new Request("https://example.test/api/library/documents", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ document, records: [records[index]] }),
    }), env, context);
    assert.equal(savedDocument.status, 200);
  }

  const deleted = await worker.fetch(new Request("https://example.test/api/library/documents", { method: "DELETE", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ document_ids: ["document-design-123"] }) }), env, context);
  assert.equal(deleted.status, 200);
  const detail = await deleted.json();
  assert.deepEqual(detail.deleted_document_type_ids, ["local-standard", "design", "construction", "stale-type"]);

  const manifest = await worker.fetch(new Request("https://example.test/api/manifest", { headers: { Cookie: cookie } }), env, context).then((response) => response.json());
  assert.deepEqual(manifest.document_types.map((type) => type.id), ["risk"]);
  assert.equal(manifest.documents.length, 1);
  assert.equal(manifest.documents[0].type_id, "risk");
});

test("generates a grounded Gemini report through the authenticated server route", async () => {
  const worker = await loadWorker();
  const env = { ...await environment(), GEMINI_API_KEY: "test-gemini-key", GEMINI_MODEL: "gemini-test-model" };
  const cookie = await bootstrapAdmin(worker, env);
  assert.ok(cookie);
  const documentId = await uploadTestOriginal(worker, env, cookie);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.ok(url.includes("generativelanguage.googleapis.com"));
    assert.ok(url.includes("gemini-test-model"));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-goog-api-key"), "test-gemini-key");
    const requestBody = JSON.parse(String(init?.body));
    assert.ok(requestBody.contents[0].parts[0].text.includes("E1"));
    assert.match(requestBody.systemInstruction.parts[0].text, /entire report in English/);
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      title: "Settlement Review Summary",
      executiveSummary: "The selected evidence contains settlement monitoring requirements.",
      overallAssessment: "Verify the monitoring criteria and action thresholds in the original.",
      keyFindings: [{ heading: "Settlement monitoring", summary: "Action is required when the limit is exceeded.", evidenceRefs: ["E1"] }],
      requirements: ["Settlement must be monitored regularly."],
      risksAndExceptions: ["The numerical acceptance limit is unclear."],
      recommendations: ["Cross-check the drawings and monitoring plan."],
      limitations: ["Only the selected evidence was analyzed."],
    }) }] } }] });
  };
  try {
    const response = await worker.fetch(new Request("https://example.test/api/report", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "settlement", language: "en", evidence: [{ documentId, documentType: "입찰문서", fileName: "test.pdf", title: "Settlement Monitoring", location: "p. 10", score: 92, text: "Settlement shall be monitored." }] }),
    }), env, context);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.report.title, "Settlement Review Summary");
    assert.equal(payload.language, "en");
    assert.deepEqual(payload.report.keyFindings[0].evidenceRefs, ["E1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explains an invalid Gemini key instead of returning a generic report error", async () => {
  const worker = await loadWorker();
  const env = { ...await environment(), GEMINI_API_KEY: "invalid-test-key", GEMINI_MODEL: "gemini-test-model" };
  const cookie = await bootstrapAdmin(worker, env);
  assert.ok(cookie);
  const documentId = await uploadTestOriginal(worker, env, cookie);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." } }, { status: 400 });
  try {
    const response = await worker.fetch(new Request("https://example.test/api/report", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "settlement", evidence: [{ documentId, documentType: "입찰문서", fileName: "test.pdf", title: "Settlement Monitoring", location: "p. 10", score: 92, text: "Settlement shall be monitored." }] }),
    }), env, context);
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.match(payload.message, /API 키가 유효하지 않거나 사용 권한이 없습니다/);
    assert.match(payload.message, /400 · INVALID_ARGUMENT/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
