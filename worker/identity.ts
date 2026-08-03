export type UserRole = "admin" | "user";

export type AuthenticatedUser = {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  mustChangePassword: boolean;
  quotaBytes: number;
  maxDocuments: number;
};

type IdentityEnv = {
  DB: D1Database;
  CLAUSESCOPE_PASSCODE?: string;
};

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  password_salt: string;
  password_hash: string;
  password_iterations: number;
  role: UserRole;
  active: number;
  must_change_password: number;
  archived_at: string | null;
  quota_bytes: number;
  max_documents: number;
};

const SESSION_COOKIE = "anyscope_session";
const DEFAULT_APP_VERSION = "1.0";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;
// Cloudflare Workers Web Crypto currently accepts at most 100,000 PBKDF2 iterations.
const PASSWORD_ITERATIONS = 100_000;
const DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_MAX_DOCUMENTS = 500;

function json(value: unknown, status = 200, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

function nowIso() {
  return new Date().toISOString();
}

function randomHex(byteLength: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function readCookie(request: Request, name: string) {
  const cookies = request.headers.get("Cookie") || "";
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function normalizeUsername(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function validUsername(value: string) {
  return /^[a-z0-9][a-z0-9._-]{2,39}$/.test(value);
}

function validPassword(value: string) {
  return value.length >= 10 && value.length <= 200;
}

function validAppVersion(value: string) {
  return /^[0-9A-Za-z][0-9A-Za-z._-]{0,19}$/.test(value);
}

async function appVersion(env: IdentityEnv) {
  const row = await env.DB.prepare(
    "SELECT value FROM app_settings WHERE key = 'app_version'",
  ).first<{ value: string }>();
  return row?.value || DEFAULT_APP_VERSION;
}


function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function derivePasswordHash(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return bytesToBase64(new Uint8Array(bits));
}

async function passwordFields(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    salt: bytesToBase64(salt),
    hash: await derivePasswordHash(password, salt, PASSWORD_ITERATIONS),
    iterations: PASSWORD_ITERATIONS,
  };
}

function publicUser(row: UserRow): AuthenticatedUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    mustChangePassword: row.must_change_password === 1,
    quotaBytes: row.quota_bytes,
    maxDocuments: row.max_documents,
  };
}

async function userCount(env: IdentityEnv) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function userByUsername(env: IdentityEnv, username: string) {
  return env.DB.prepare(
    `SELECT id, username, display_name, password_salt, password_hash,
            password_iterations, role, active, must_change_password, archived_at,
            quota_bytes, max_documents
       FROM users
      WHERE username = ?`,
  ).bind(username).first<UserRow>();
}

async function createUser(
  env: IdentityEnv,
  input: {
    username: string;
    displayName: string;
    password: string;
    role: UserRole;
    quotaBytes?: number;
    maxDocuments?: number;
    mustChangePassword?: boolean;
  },
) {
  const username = normalizeUsername(input.username);
  const displayName = input.displayName.replace(/\s+/g, " ").trim();
  if (!validUsername(username)) {
    throw new Error("아이디는 영문 소문자·숫자로 시작하고, 점·밑줄·하이픈을 포함해 3~40자로 입력해 주세요.");
  }
  if (!displayName || displayName.length > 80) {
    throw new Error("표시 이름은 1~80자로 입력해 주세요.");
  }
  if (!validPassword(input.password)) {
    throw new Error("비밀번호는 10자 이상 200자 이하로 입력해 주세요.");
  }
  const existing = await userByUsername(env, username);
  if (existing) throw new Error("이미 사용 중인 아이디입니다.");

  const password = await passwordFields(input.password);
  const id = crypto.randomUUID();
  const now = nowIso();
  const quotaBytes = Number.isSafeInteger(input.quotaBytes) && Number(input.quotaBytes) >= 0
    ? Number(input.quotaBytes)
    : DEFAULT_QUOTA_BYTES;
  const maxDocuments = Number.isSafeInteger(input.maxDocuments) && Number(input.maxDocuments) >= 1
    ? Number(input.maxDocuments)
    : DEFAULT_MAX_DOCUMENTS;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (
        id, username, display_name, password_salt, password_hash, password_iterations,
        role, active, must_change_password, archived_at, quota_bytes, max_documents,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?)`,
    ).bind(
      id,
      username,
      displayName,
      password.salt,
      password.hash,
      password.iterations,
      input.role,
      input.mustChangePassword ? 1 : 0,
      quotaBytes,
      maxDocuments,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO user_settings (
        user_id, workspace_title, index_mode, legacy_manifest_key,
        legacy_corpus_key, legacy_connected_at, updated_at
      ) VALUES (?, ?, 'user', NULL, NULL, NULL, ?)`,
    ).bind(id, "프로젝트 문서 검색", now),
  ]);
  return {
    id,
    username,
    displayName,
    role: input.role,
    mustChangePassword: Boolean(input.mustChangePassword),
    quotaBytes,
    maxDocuments,
  };
}

async function createSession(env: IdentityEnv, userId: string) {
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(tokenHash, userId, expiresAt, createdAt, createdAt).run();
  return token;
}

export async function authenticatedUser(request: Request, env: IdentityEnv) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.password_salt, u.password_hash,
            u.password_iterations, u.role, u.active, u.must_change_password,
            u.archived_at, u.quota_bytes, u.max_documents
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
        AND s.expires_at > ?
        AND u.active = 1`,
  ).bind(tokenHash, nowIso()).first<UserRow>();
  if (!row) return null;
  return publicUser(row);
}

export async function activeUserById(env: IdentityEnv, userId: string) {
  const row = await env.DB.prepare(
    `SELECT id, username, display_name, password_salt, password_hash,
            password_iterations, role, active, must_change_password, archived_at,
            quota_bytes, max_documents
       FROM users
      WHERE id = ? AND active = 1`,
  ).bind(userId).first<UserRow>();
  return row ? publicUser(row) : null;
}

export async function audit(
  env: IdentityEnv,
  actorUserId: string | null,
  action: string,
  targetType: string,
  targetId?: string | null,
  details: Record<string, unknown> = {},
) {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    crypto.randomUUID(),
    actorUserId,
    action,
    targetType,
    targetId ?? null,
    JSON.stringify(details),
    nowIso(),
  ).run();
}

export async function handleIdentityRequest(request: Request, env: IdentityEnv, url: URL) {
  if (url.pathname === "/api/auth/status" && request.method === "GET") {
    const [user, version] = await Promise.all([authenticatedUser(request, env), appVersion(env)]);
    return json({
      authenticated: Boolean(user),
      bootstrap_required: !user && await userCount(env) === 0,
      user,
      app_version: version,
    });
  }

  if (url.pathname === "/api/auth/bootstrap" && request.method === "POST") {
    if (await userCount(env) !== 0) {
      return json({ message: "최초 관리자 설정이 이미 완료되었습니다." }, 409);
    }
    if (!env.CLAUSESCOPE_PASSCODE) {
      return json({ message: "기존 운영 비밀번호가 설정되어 있지 않아 최초 관리자를 만들 수 없습니다." }, 503);
    }
    let payload: {
      legacy_passcode?: unknown;
      username?: unknown;
      display_name?: unknown;
      password?: unknown;
    };
    try {
      payload = await request.json() as typeof payload;
    } catch {
      return json({ message: "최초 관리자 설정 요청 형식이 올바르지 않습니다." }, 400);
    }
    const legacyPasscode = typeof payload.legacy_passcode === "string" ? payload.legacy_passcode : "";
    const suppliedDigest = await sha256Hex(legacyPasscode);
    const expectedDigest = await sha256Hex(env.CLAUSESCOPE_PASSCODE);
    if (!constantTimeEqual(suppliedDigest, expectedDigest)) {
      return json({ message: "기존 운영 비밀번호가 일치하지 않습니다." }, 401);
    }
    try {
      const user = await createUser(env, {
        username: typeof payload.username === "string" ? payload.username : "",
        displayName: typeof payload.display_name === "string" ? payload.display_name : "",
        password: typeof payload.password === "string" ? payload.password : "",
        role: "admin",
        mustChangePassword: false,
      });
      await audit(env, user.id, "bootstrap_admin", "user", user.id);
      const token = await createSession(env, user.id);
      return json({ ok: true, user }, 201, {
        "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
      });
    } catch (error) {
      return json({ message: error instanceof Error ? error.message : "최초 관리자를 만들지 못했습니다." }, 400);
    }
  }

  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    let payload: { username?: unknown; password?: unknown };
    try {
      payload = await request.json() as typeof payload;
    } catch {
      return json({ message: "로그인 요청 형식이 올바르지 않습니다." }, 400);
    }
    const username = normalizeUsername(typeof payload.username === "string" ? payload.username : "");
    const password = typeof payload.password === "string" ? payload.password : "";
    const row = validUsername(username) ? await userByUsername(env, username) : null;
    const fallbackSalt = new Uint8Array(16);
    const expectedHash = row?.password_hash ?? await derivePasswordHash("", fallbackSalt, PASSWORD_ITERATIONS);
    const suppliedHash = await derivePasswordHash(
      password,
      row ? base64ToBytes(row.password_salt) : fallbackSalt,
      row?.password_iterations ?? PASSWORD_ITERATIONS,
    );
    if (!row || row.active !== 1 || !constantTimeEqual(suppliedHash, expectedHash)) {
      return json({ message: "아이디 또는 비밀번호가 일치하지 않습니다." }, 401);
    }
    const token = await createSession(env, row.id);
    await audit(env, row.id, "login", "session");
    return json({ ok: true, user: publicUser(row) }, 200, {
      "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    });
  }

  if (url.pathname === "/api/auth/password" && request.method === "POST") {
    const user = await authenticatedUser(request, env);
    if (!user) return json({ message: "로그인이 필요합니다." }, 401);
    let payload: { current_password?: unknown; new_password?: unknown };
    try {
      payload = await request.json() as typeof payload;
    } catch {
      return json({ message: "비밀번호 변경 요청 형식이 올바르지 않습니다." }, 400);
    }
    const currentPassword = typeof payload.current_password === "string" ? payload.current_password : "";
    const newPassword = typeof payload.new_password === "string" ? payload.new_password : "";
    if (!validPassword(newPassword)) {
      return json({ message: "새 비밀번호는 10자 이상 200자 이하로 입력해 주세요." }, 400);
    }
    const row = await userByUsername(env, user.username);
    if (!row) return json({ message: "사용자 계정을 찾지 못했습니다." }, 404);
    const currentHash = await derivePasswordHash(
      currentPassword,
      base64ToBytes(row.password_salt),
      row.password_iterations,
    );
    if (!constantTimeEqual(currentHash, row.password_hash)) {
      return json({ message: "현재 비밀번호가 일치하지 않습니다." }, 401);
    }
    const newHash = await derivePasswordHash(
      newPassword,
      base64ToBytes(row.password_salt),
      row.password_iterations,
    );
    if (constantTimeEqual(newHash, row.password_hash)) {
      return json({ message: "새 비밀번호는 현재 비밀번호와 다르게 입력해 주세요." }, 400);
    }
    const password = await passwordFields(newPassword);
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE users
            SET password_salt = ?, password_hash = ?, password_iterations = ?,
                must_change_password = 0, updated_at = ?
          WHERE id = ?`,
      ).bind(password.salt, password.hash, password.iterations, now, user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    ]);
    const token = await createSession(env, user.id);
    await audit(env, user.id, "change_password", "user", user.id);
    const updated = await userByUsername(env, user.username);
    return json({ ok: true, user: updated ? publicUser(updated) : { ...user, mustChangePassword: false } }, 200, {
      "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    });
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) {
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
    }
    return json({ ok: true }, 200, {
      "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    });
  }

  return null;
}

export async function handleAdminSettingsRequest(
  request: Request,
  env: IdentityEnv,
  url: URL,
  actor: AuthenticatedUser,
) {
  if (url.pathname !== "/api/admin/settings") return null;
  if (actor.role !== "admin") return json({ message: "관리자 권한이 필요합니다." }, 403);

  if (request.method === "GET") {
    return json({ app_version: await appVersion(env) });
  }
  if (request.method !== "PUT") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, PUT" } });
  }

  let payload: { app_version?: unknown };
  try {
    payload = await request.json() as typeof payload;
  } catch {
    return json({ message: "버전 설정 요청 형식이 올바르지 않습니다." }, 400);
  }
  const version = typeof payload.app_version === "string" ? payload.app_version.trim() : "";
  if (!validAppVersion(version)) {
    return json({ message: "버전은 영문·숫자로 시작하는 1~20자의 영문, 숫자, 점, 밑줄 또는 하이픈으로 입력해 주세요." }, 400);
  }
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by_user_id)
     VALUES ('app_version', ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at,
       updated_by_user_id = excluded.updated_by_user_id`,
  ).bind(version, now, actor.id).run();
  await audit(env, actor.id, "update_app_version", "app_setting", "app_version", { value: version });
  return json({ ok: true, app_version: version });
}

export async function handleAdminUsersRequest(
  request: Request,
  env: IdentityEnv,
  url: URL,
  actor: AuthenticatedUser,
) {
  if (!url.pathname.startsWith("/api/admin/users")) return null;
  if (actor.role !== "admin") return json({ message: "관리자 권한이 필요합니다." }, 403);

  if (url.pathname === "/api/admin/users" && request.method === "GET") {
    const result = await env.DB.prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.active,
              u.must_change_password, u.archived_at, u.quota_bytes,
              u.max_documents, u.created_at,
              COUNT(d.id) AS document_count,
              COALESCE(SUM(CASE WHEN d.deleted_at IS NULL THEN d.size_bytes ELSE 0 END), 0) AS used_bytes
         FROM users u
         LEFT JOIN documents d ON d.owner_user_id = u.id AND d.deleted_at IS NULL
        GROUP BY u.id
        ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.username`,
    ).all<Record<string, unknown>>();
    return json({ users: result.results ?? [] });
  }

  if (url.pathname === "/api/admin/users" && request.method === "POST") {
    let payload: {
      username?: unknown;
      display_name?: unknown;
      password?: unknown;
      quota_bytes?: unknown;
      max_documents?: unknown;
    };
    try {
      payload = await request.json() as typeof payload;
    } catch {
      return json({ message: "사용자 생성 요청 형식이 올바르지 않습니다." }, 400);
    }
    try {
      const user = await createUser(env, {
        username: typeof payload.username === "string" ? payload.username : "",
        displayName: typeof payload.display_name === "string" ? payload.display_name : "",
        password: typeof payload.password === "string" ? payload.password : "",
        role: "user",
        quotaBytes: typeof payload.quota_bytes === "number" ? payload.quota_bytes : undefined,
        maxDocuments: typeof payload.max_documents === "number" ? payload.max_documents : undefined,
        mustChangePassword: true,
      });
      await audit(env, actor.id, "create_user", "user", user.id);
      return json({ ok: true, user }, 201);
    } catch (error) {
      return json({ message: error instanceof Error ? error.message : "사용자를 만들지 못했습니다." }, 400);
    }
  }

  const match = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (!match) return null;
  if (request.method !== "PATCH") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST, PATCH" } });
  }
  const targetId = decodeURIComponent(match[1]);
  const target = await env.DB.prepare(
    `SELECT id, username, display_name, role, active, must_change_password,
            archived_at, quota_bytes, max_documents
       FROM users WHERE id = ?`,
  ).bind(targetId).first<{
    id: string;
    username: string;
    display_name: string;
    role: UserRole;
    active: number;
    must_change_password: number;
    archived_at: string | null;
    quota_bytes: number;
    max_documents: number;
  }>();
  if (!target) return json({ message: "사용자를 찾지 못했습니다." }, 404);

  let payload: {
    active?: unknown;
    password?: unknown;
    quota_bytes?: unknown;
    max_documents?: unknown;
  };
  try {
    payload = await request.json() as typeof payload;
  } catch {
    return json({ message: "사용자 변경 요청 형식이 올바르지 않습니다." }, 400);
  }
  if (target.id === actor.id && payload.active === false) {
    return json({ message: "현재 로그인한 관리자 계정은 비활성화할 수 없습니다." }, 400);
  }
  if (target.archived_at && payload.active === true) {
    return json({ message: "보관된 계정은 다시 활성화할 수 없습니다." }, 400);
  }

  const active = typeof payload.active === "boolean" ? payload.active : target.active === 1;
  const quotaBytes = Number.isSafeInteger(payload.quota_bytes) && Number(payload.quota_bytes) >= 0
    ? Number(payload.quota_bytes)
    : target.quota_bytes;
  const maxDocuments = Number.isSafeInteger(payload.max_documents) && Number(payload.max_documents) >= 1
    ? Number(payload.max_documents)
    : target.max_documents;
  const statements = [
    env.DB.prepare(
      "UPDATE users SET active = ?, quota_bytes = ?, max_documents = ?, updated_at = ? WHERE id = ?",
    ).bind(active ? 1 : 0, quotaBytes, maxDocuments, nowIso(), targetId),
  ];
  if (typeof payload.password === "string" && payload.password.length) {
    if (!validPassword(payload.password)) {
      return json({ message: "새 비밀번호는 10자 이상 200자 이하로 입력해 주세요." }, 400);
    }
    const password = await passwordFields(payload.password);
    statements.push(
      env.DB.prepare(
        `UPDATE users
            SET password_salt = ?, password_hash = ?, password_iterations = ?,
                must_change_password = 1, updated_at = ?
          WHERE id = ?`,
      ).bind(password.salt, password.hash, password.iterations, nowIso(), targetId),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(targetId),
    );
  } else if (!active) {
    statements.push(env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(targetId));
  }
  await env.DB.batch(statements);
  await audit(env, actor.id, "update_user", "user", targetId, {
    active,
    quota_bytes: quotaBytes,
    max_documents: maxDocuments,
    password_reset: typeof payload.password === "string" && payload.password.length > 0,
  });
  return json({ ok: true });
}

export function isSameOriginMutation(request: Request, url: URL) {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return true;
  const origin = request.headers.get("Origin");
  return !origin || origin === url.origin;
}
