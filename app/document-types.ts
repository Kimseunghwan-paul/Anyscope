export type DocumentTypeDefinition = {
  id: string;
  name: string;
  parent_id?: string;
  color: string;
  keywords: string[];
  sort_order: number;
};

export type DocumentTypeSource = {
  type?: string;
  type_id?: string;
  document_type?: string;
  document_type_id?: string;
};

export const DOCUMENT_TYPE_COLORS = [
  "navy",
  "orange",
  "rose",
  "teal",
  "violet",
  "slate",
] as const;

export const UNCATEGORIZED_TYPE: DocumentTypeDefinition = {
  id: "uncategorized",
  name: "미분류",
  color: "slate",
  keywords: [],
  sort_order: 0,
};

function stableHash(value: string) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeKeyword(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 60) : "";
}

function legacyTypeId(name: string) {
  return `legacy-${stableHash(name.toLocaleLowerCase())}`;
}

export function createDocumentTypeId(name: string, existingIds: Iterable<string>) {
  const existing = new Set(existingIds);
  const ascii = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  const base = ascii ? `type-${ascii}` : `type-${stableHash(name)}`;
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function normalizeDocumentTypes(
  rawTypes: unknown,
  documents: DocumentTypeSource[] = [],
) {
  const normalized: DocumentTypeDefinition[] = [];
  const usedIds = new Set<string>();
  const usedNamesByParent = new Set<string>();

  if (Array.isArray(rawTypes)) {
    for (const [index, raw] of rawTypes.entries()) {
      if (!raw || typeof raw !== "object") continue;
      const candidate = raw as Partial<DocumentTypeDefinition>;
      const id = typeof candidate.id === "string" ? candidate.id.trim().slice(0, 100) : "";
      const name = typeof candidate.name === "string" ? candidate.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
      const nameKey = name.toLocaleLowerCase();
      const parentId = typeof candidate.parent_id === "string" && candidate.parent_id !== id
        ? candidate.parent_id
        : undefined;
      const scopedNameKey = `${parentId ?? "__root__"}\u0000${nameKey}`;
      if (!id || !name || usedIds.has(id) || usedNamesByParent.has(scopedNameKey)) continue;
      usedIds.add(id);
      usedNamesByParent.add(scopedNameKey);
      normalized.push({
        id,
        name,
        parent_id: parentId,
        color: DOCUMENT_TYPE_COLORS.includes(candidate.color as (typeof DOCUMENT_TYPE_COLORS)[number])
          ? candidate.color as string
          : DOCUMENT_TYPE_COLORS[index % DOCUMENT_TYPE_COLORS.length],
        keywords: Array.isArray(candidate.keywords)
          ? [...new Set(candidate.keywords.map(normalizeKeyword).filter(Boolean))].slice(0, 20)
          : [],
        sort_order: Number.isFinite(candidate.sort_order) ? Number(candidate.sort_order) : (index + 1) * 10,
      });
    }
  }

  for (const document of documents) {
    const preferredId = document.type_id ?? document.document_type_id;
    // 현재 manifest에 존재하는 유형 ID가 있으면 그 ID가 기준이다.
    // 문서에 남아 있는 과거 유형명으로 삭제된 유형을 다시 만들지 않는다.
    if (preferredId && usedIds.has(preferredId)) continue;
    const name = (document.type ?? document.document_type ?? "").replace(/\s+/g, " ").trim();
    const scopedNameKey = `__root__\u0000${name.toLocaleLowerCase()}`;
    if (!name || usedNamesByParent.has(scopedNameKey)) continue;
    const id = preferredId && !usedIds.has(preferredId) ? preferredId : legacyTypeId(name);
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    usedNamesByParent.add(scopedNameKey);
    normalized.push({
      id,
      name,
      color: DOCUMENT_TYPE_COLORS[normalized.length % DOCUMENT_TYPE_COLORS.length],
      keywords: [],
      sort_order: (normalized.length + 1) * 10,
    });
  }

  if (!usedIds.has(UNCATEGORIZED_TYPE.id)) normalized.unshift({ ...UNCATEGORIZED_TYPE });
  const validIds = new Set(normalized.map((type) => type.id));
  const rawTypeById = new Map(normalized.map((type) => [type.id, type]));
  const hasValidParentChain = (type: DocumentTypeDefinition) => {
    const seen = new Set([type.id]);
    let parentId = type.parent_id;
    let depth = 1;
    while (parentId) {
      if (seen.has(parentId)) return false;
      const parent = rawTypeById.get(parentId);
      if (!parent) return false;
      seen.add(parentId);
      depth += 1;
      if (depth > 3) return false;
      parentId = parent.parent_id;
    }
    return true;
  };
  const cleaned = normalized
    .map((type) => ({
      ...type,
      parent_id: type.parent_id && validIds.has(type.parent_id) && hasValidParentChain(type)
        ? type.parent_id
        : undefined,
    }));
  const compare = (left: DocumentTypeDefinition, right: DocumentTypeDefinition) =>
    left.sort_order - right.sort_order || left.name.localeCompare(right.name, "ko");
  const topLevel = cleaned
    .filter((type) => !type.parent_id && type.id !== UNCATEGORIZED_TYPE.id)
    .sort(compare);
  const appendTree = (type: DocumentTypeDefinition): DocumentTypeDefinition[] => [
    type,
    ...cleaned
      .filter((candidate) => candidate.parent_id === type.id)
      .sort(compare)
      .flatMap(appendTree),
  ];
  const ordered = topLevel.flatMap(appendTree);
  const orderedIds = new Set(ordered.map((type) => type.id));
  ordered.push(...cleaned.filter((type) => (
    type.id !== UNCATEGORIZED_TYPE.id && !orderedIds.has(type.id)
  )).sort(compare));
  ordered.push(cleaned.find((type) => type.id === UNCATEGORIZED_TYPE.id) ?? { ...UNCATEGORIZED_TYPE });
  return ordered;
}

export function resolveDocumentTypeId(
  source: DocumentTypeSource,
  types: DocumentTypeDefinition[],
) {
  const explicitId = source.type_id ?? source.document_type_id;
  if (explicitId && types.some((type) => type.id === explicitId)) return explicitId;
  const name = source.type ?? source.document_type;
  return types.find((type) => type.name === name)?.id ?? UNCATEGORIZED_TYPE.id;
}

export function documentTypeLabel(typeId: string, types: DocumentTypeDefinition[]) {
  const type = types.find((candidate) => candidate.id === typeId) ?? UNCATEGORIZED_TYPE;
  const typeById = new Map(types.map((candidate) => [candidate.id, candidate]));
  const path = [type.name];
  const seen = new Set([type.id]);
  let parentId = type.parent_id;
  while (parentId && !seen.has(parentId)) {
    const parent = typeById.get(parentId);
    if (!parent) break;
    path.unshift(parent.name);
    seen.add(parent.id);
    parentId = parent.parent_id;
  }
  return path.join(" / ");
}

export function documentTypeDepth(typeId: string, types: DocumentTypeDefinition[]) {
  const typeById = new Map(types.map((type) => [type.id, type]));
  const seen = new Set<string>();
  let current = typeById.get(typeId);
  let depth = 0;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    depth += 1;
    current = current.parent_id ? typeById.get(current.parent_id) : undefined;
  }
  return depth;
}

export function descendantDocumentTypeIds(typeId: string, types: DocumentTypeDefinition[]) {
  const descendants: string[] = [];
  const visit = (parentId: string) => {
    for (const child of types.filter((type) => type.parent_id === parentId)) {
      descendants.push(child.id);
      visit(child.id);
    }
  };
  visit(typeId);
  return descendants;
}

export function recommendDocumentType(fileName: string, types: DocumentTypeDefinition[]) {
  const normalizedName = fileName
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let best = UNCATEGORIZED_TYPE.id;
  let bestScore = 0;

  for (const type of types) {
    if (type.id === UNCATEGORIZED_TYPE.id) continue;
    const candidates = [
      type.name,
      ...type.keywords,
    ].map((value) => value.normalize("NFKC").toLocaleLowerCase().trim()).filter((value) => value.length >= 2);
    const score = candidates.reduce((total, keyword) => {
      if (normalizedName === keyword) return total + 10;
      if (normalizedName.includes(keyword)) return total + Math.min(8, Math.max(2, keyword.split(/\s+/).length * 2));
      return total;
    }, 0);
    if (score > bestScore) {
      best = type.id;
      bestScore = score;
    }
  }
  return best;
}
