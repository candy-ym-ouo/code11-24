import type { FamilyRole, Item, Prisma } from '@prisma/client';
import { sortAt as computeSortAt, timelineGroupKey, type Category, type Precision, type Visibility } from '@heirloom/shared';
import { prisma } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { cleanStory } from '../utils/sanitize';
import { toPage, type CursorPage } from '../utils/pagination';
import * as audit from './auditService';
import { itemWithAccess, type FamilyContext } from './permissionService';
import { toItemDto } from '../serializers';
import { itemVisibilityWhere } from './visibility';

export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface ItemInput {
  title?: string;
  category?: Category;
  acquiredAt?: string | null;
  acquiredPrecision?: Precision;
  acquiredLabel?: string | null;
  acquiredNote?: string | null;
  placeText?: string | null;
  placeCity?: string | null;
  placeProvince?: string | null;
  placeCountry?: string | null;
  placeLat?: number | null;
  placeLng?: number | null;
  storyHtml?: string | null;
  condition?: string | null;
  storageLocation?: string | null;
  tags?: string[];
  visibility?: Visibility;
  people?: { personId: string; role: string }[];
  sharedWith?: { userId: string; canEdit: boolean }[];
}

export interface ListQuery {
  q?: string;
  category?: Category;
  personId?: string;
  status?: 'draft' | 'published' | 'archived';
  visibility?: Visibility;
  from?: string;
  to?: string;
  tag?: string;
  sort: 'time' | 'updated' | 'created';
  limit: number;
  cursor?: string;
}

const LIST_INCLUDE = {
  media: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
  people: { include: { person: true } },
  _count: { select: { notes: true, media: true } },
} satisfies Prisma.ItemInclude;

export async function listItems(
  userId: string,
  ctx: FamilyContext,
  query: ListQuery,
): Promise<CursorPage<ReturnType<typeof toItemDto>>> {
  const and: Prisma.ItemWhereInput[] = [
    { familyId: ctx.familyId },
    { deletedAt: null },
    { status: query.status ? query.status : { not: 'trashed' } },
    itemVisibilityWhere(userId, ctx.role),
  ];

  if (query.category) and.push({ category: query.category });
  if (query.visibility) and.push({ visibility: query.visibility });
  if (query.tag) and.push({ tags: { has: query.tag } });
  if (query.personId) and.push({ people: { some: { personId: query.personId } } });
  if (query.from || query.to) {
    and.push({
      sortAt: {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      },
    });
  }
  if (query.q) {
    const contains = { contains: query.q, mode: 'insensitive' as const };
    and.push({
      OR: [
        { title: contains },
        { storyText: contains },
        { placeText: contains },
        { storageLocation: contains },
        { acquiredLabel: contains },
        { tags: { has: query.q } },
        { people: { some: { person: { name: contains } } } },
        { media: { some: { deletedAt: null, transcript: contains } } },
      ],
    });
  }

  const orderBy: Prisma.ItemOrderByWithRelationInput[] =
    query.sort === 'updated'
      ? [{ updatedAt: 'desc' }, { id: 'desc' }]
      : query.sort === 'created'
        ? [{ createdAt: 'desc' }, { id: 'desc' }]
        : [{ sortAt: 'desc' }, { id: 'desc' }];

  const rows = await prisma.item.findMany({
    where: { AND: and },
    include: LIST_INCLUDE,
    orderBy,
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const page = toPage(rows, query.limit);
  return { items: page.items.map((row) => toItemDto(row, ctx.familyId)), nextCursor: page.nextCursor };
}

export async function getItemDetail(userId: string, ctx: FamilyContext, itemId: string) {
  const { item, access } = await itemWithAccess(userId, ctx, itemId);
  const full = await prisma.item.findUniqueOrThrow({
    where: { id: item.id },
    include: {
      ...LIST_INCLUDE,
      creator: { select: { id: true, displayName: true, avatarColor: true } },
      notes: {
        where: { status: { not: 'rejected' } },
        include: { author: { select: { id: true, displayName: true, avatarColor: true } } },
        orderBy: { createdAt: 'asc' },
      },
      shares: { include: { item: false } },
      _count: { select: { notes: true, media: true, versions: true } },
    },
  });
  const shares = await prisma.itemShare.findMany({ where: { itemId }, include: { item: false } });
  const sharedUsers = shares.length
    ? await prisma.familyMember.findMany({
        where: { familyId: ctx.familyId, userId: { in: shares.map((s) => s.userId) } },
        include: { user: { select: { id: true, displayName: true, avatarColor: true } } },
      })
    : [];

  return {
    ...toItemDto(full, ctx.familyId),
    creator: full.creator,
    notes: full.notes.map((n) => ({
      id: n.id,
      type: n.type,
      body: n.body,
      status: n.status,
      rejectReason: n.rejectReason,
      createdAt: n.createdAt.toISOString(),
      decidedAt: n.decidedAt?.toISOString() ?? null,
      author: n.author,
    })),
    sharedWith: sharedUsers.map((m) => ({
      userId: m.userId,
      displayName: m.user.displayName,
      avatarColor: m.user.avatarColor,
      canEdit: shares.find((s) => s.userId === m.userId)?.canEdit ?? false,
    })),
    versionCount: full._count.versions,
    permissions: {
      canEdit: access.canEdit,
      canDelete: access.canDelete,
      canComment: access.canComment,
      canManageMedia: access.canManageMedia,
    },
  };
}

async function assertPeopleBelongToFamily(familyId: string, personIds: string[]): Promise<void> {
  if (personIds.length === 0) return;
  const found = await prisma.person.count({
    where: { familyId, id: { in: personIds }, deletedAt: null },
  });
  if (found !== new Set(personIds).size) throw badRequest('存在不属于该家庭的来源人物');
}

async function assertUsersBelongToFamily(familyId: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const found = await prisma.familyMember.count({
    where: { familyId, userId: { in: userIds }, status: 'active' },
  });
  if (found !== new Set(userIds).size) throw badRequest('存在不属于该家庭的成员');
}

export async function createItem(userId: string, ctx: FamilyContext, input: ItemInput, meta: ActorMeta) {
  if (!input.title || !input.category) throw badRequest('标题与分类为必填项');
  const story = cleanStory(input.storyHtml);
  const acquiredAt = input.acquiredAt ? new Date(input.acquiredAt) : null;
  const precision = input.acquiredPrecision ?? 'unknown';
  const sortValue = computeSortAt({ acquiredAt, acquiredPrecision: precision }, new Date());

  await assertPeopleBelongToFamily(ctx.familyId, (input.people ?? []).map((p) => p.personId));
  await assertUsersBelongToFamily(ctx.familyId, (input.sharedWith ?? []).map((s) => s.userId));

  const family = await prisma.family.findUniqueOrThrow({ where: { id: ctx.familyId } });

  return prisma.$transaction(async (tx) => {
    const created = await tx.item.create({
      data: {
        familyId: ctx.familyId,
        title: input.title!,
        category: input.category!,
        status: 'draft',
        visibility: input.visibility ?? family.defaultVisibility,
        acquiredAt,
        acquiredPrecision: precision,
        acquiredLabel: input.acquiredLabel ?? null,
        acquiredNote: input.acquiredNote ?? null,
        placeText: input.placeText ?? null,
        placeCity: input.placeCity ?? null,
        placeProvince: input.placeProvince ?? null,
        placeCountry: input.placeCountry ?? null,
        placeLat: input.placeLat ?? null,
        placeLng: input.placeLng ?? null,
        storyHtml: story.html,
        storyText: story.text || null,
        condition: input.condition ?? null,
        storageLocation: input.storageLocation ?? null,
        tags: input.tags ?? [],
        sortAt: sortValue,
        createdBy: userId,
        people: input.people?.length
          ? { create: input.people.map((p) => ({ personId: p.personId, role: p.role as never })) }
          : undefined,
        shares: input.sharedWith?.length
          ? { create: input.sharedWith.map((s) => ({ userId: s.userId, canEdit: s.canEdit })) }
          : undefined,
      },
      include: LIST_INCLUDE,
    });

    await tx.itemVersion.create({
      data: { itemId: created.id, version: 1, snapshot: toVersionSnapshot(created), createdBy: userId },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'item.create',
        targetType: 'item',
        targetId: created.id,
        diff: { title: created.title, category: created.category } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return toItemDto(created, ctx.familyId);
  });
}

export function toVersionSnapshot(item: Item): Prisma.InputJsonValue {
  return {
    title: item.title,
    category: item.category,
    status: item.status,
    visibility: item.visibility,
    acquiredAt: item.acquiredAt?.toISOString() ?? null,
    acquiredPrecision: item.acquiredPrecision,
    acquiredLabel: item.acquiredLabel,
    acquiredNote: item.acquiredNote,
    placeText: item.placeText,
    placeCity: item.placeCity,
    placeProvince: item.placeProvince,
    placeCountry: item.placeCountry,
    placeLat: item.placeLat ? Number(item.placeLat) : null,
    placeLng: item.placeLng ? Number(item.placeLng) : null,
    storyHtml: item.storyHtml,
    condition: item.condition,
    storageLocation: item.storageLocation,
    tags: item.tags,
    coverMediaId: item.coverMediaId,
  } as unknown as Prisma.InputJsonValue;
}

export async function updateItem(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  input: ItemInput,
  meta: ActorMeta,
) {
  const { item, access } = await itemWithAccess(userId, ctx, itemId);
  if (!access.canEdit) throw forbidden();
  if (item.status === 'trashed') throw conflict('回收站中的条目不可编辑，请先恢复');

  await assertPeopleBelongToFamily(ctx.familyId, (input.people ?? []).map((p) => p.personId));
  await assertUsersBelongToFamily(ctx.familyId, (input.sharedWith ?? []).map((s) => s.userId));

  const story = input.storyHtml === undefined ? { html: null as string | null, text: '' } : cleanStory(input.storyHtml);
  const nextAcquiredAt =
    input.acquiredAt === undefined ? item.acquiredAt : input.acquiredAt === null ? null : new Date(input.acquiredAt);
  const nextPrecision = input.acquiredPrecision ?? item.acquiredPrecision;
  const nextSortAt =
    input.acquiredAt === undefined && input.acquiredPrecision === undefined
      ? item.sortAt
      : computeSortAt({ acquiredAt: nextAcquiredAt, acquiredPrecision: nextPrecision }, new Date());

  return prisma.$transaction(async (tx) => {
    const updated = await tx.item.update({
      where: { id: itemId },
      data: {
        title: input.title ?? undefined,
        category: input.category ?? undefined,
        visibility: input.visibility ?? undefined,
        acquiredAt: input.acquiredAt === undefined ? undefined : nextAcquiredAt,
        acquiredPrecision: input.acquiredPrecision ?? undefined,
        acquiredLabel: input.acquiredLabel === undefined ? undefined : input.acquiredLabel,
        acquiredNote: input.acquiredNote === undefined ? undefined : input.acquiredNote,
        placeText: input.placeText === undefined ? undefined : input.placeText,
        placeCity: input.placeCity === undefined ? undefined : input.placeCity,
        placeProvince: input.placeProvince === undefined ? undefined : input.placeProvince,
        placeCountry: input.placeCountry === undefined ? undefined : input.placeCountry,
        placeLat: input.placeLat === undefined ? undefined : input.placeLat,
        placeLng: input.placeLng === undefined ? undefined : input.placeLng,
        storyHtml: input.storyHtml === undefined ? undefined : story.html,
        storyText: input.storyHtml === undefined ? undefined : story.text || null,
        condition: input.condition === undefined ? undefined : input.condition,
        storageLocation: input.storageLocation === undefined ? undefined : input.storageLocation,
        tags: input.tags ?? undefined,
        sortAt: nextSortAt,
      },
    });

    if (input.people) {
      await tx.itemPerson.deleteMany({ where: { itemId } });
      if (input.people.length) {
        await tx.itemPerson.createMany({
          data: input.people.map((p) => ({ itemId, personId: p.personId, role: p.role as never })),
        });
      }
    }
    if (input.sharedWith) {
      await tx.itemShare.deleteMany({ where: { itemId } });
      if (input.sharedWith.length) {
        await tx.itemShare.createMany({
          data: input.sharedWith.map((s) => ({ itemId, userId: s.userId, canEdit: s.canEdit })),
        });
      }
    }

    const last = await tx.itemVersion.findFirst({ where: { itemId }, orderBy: { version: 'desc' } });
    await tx.itemVersion.create({
      data: {
        itemId,
        version: (last?.version ?? 0) + 1,
        snapshot: toVersionSnapshot(updated),
        createdBy: userId,
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'item.update',
        targetType: 'item',
        targetId: itemId,
        diff: audit.diffOf(toVersionSnapshot(item), toVersionSnapshot(updated)),
        ...meta,
      },
      tx,
    );

    const withRelations = await tx.item.findUniqueOrThrow({ where: { id: itemId }, include: LIST_INCLUDE });
    return toItemDto(withRelations, ctx.familyId);
  });
}

type StatusAction = 'publish' | 'archive' | 'restore' | 'trash';

const STATUS_TARGET: Record<StatusAction, Item['status']> = {
  publish: 'published',
  archive: 'archived',
  restore: 'published',
  trash: 'trashed',
};

export async function changeStatus(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  action: StatusAction,
  meta: ActorMeta,
) {
  const { item, access } = await itemWithAccess(userId, ctx, itemId);

  if (action === 'trash') {
    if (!access.canDelete) throw forbidden();
  } else if (action === 'restore') {
    if (!access.canDelete) throw forbidden();
  } else if (!access.canEdit) {
    throw forbidden();
  }

  if (action === 'publish') {
    const mediaCount = await prisma.itemMedia.count({ where: { itemId, deletedAt: null } });
    const hasClue = Boolean(item.acquiredAt || item.acquiredLabel || item.placeText || item.storyText);
    if (!hasClue && mediaCount === 0) {
      throw badRequest('发布前请至少补充一条线索：获得时间、地点、故事或一张图片');
    }
  }

  const target = STATUS_TARGET[action];
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.item.update({
      where: { id: itemId },
      data: { status: target, deletedAt: action === 'trash' ? new Date() : null },
      include: LIST_INCLUDE,
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: `item.${action}` as string,
        targetType: 'item',
        targetId: itemId,
        diff: audit.diffOf({ status: item.status }, { status: target }),
        ...meta,
      },
      tx,
    );
    return result;
  });
  return toItemDto(updated, ctx.familyId);
}

/**
 * 彻底删除：只删数据库行。磁盘文件按 sha256 内容寻址，可能被其他条目或
 * 重复上传的媒体记录共享，因此这里绝不直接删盘——由 storage_gc 任务重算
 * 引用后统一回收。为避免等到每日维护，调用方会随后入队一次 storage_gc。
 */
export async function purgeItem(userId: string, ctx: FamilyContext, itemId: string, meta: ActorMeta): Promise<void> {
  const item = await prisma.item.findFirst({ where: { id: itemId, familyId: ctx.familyId } });
  if (!item) throw notFound('条目不存在');
  if (item.status !== 'trashed') throw conflict('只有回收站中的条目才能彻底删除');

  const mediaCount = await prisma.itemMedia.count({ where: { itemId } });
  await prisma.$transaction(async (tx) => {
    // 媒体行随外键 onDelete: Cascade 一并删除；审计保留（合规与追溯需要）
    await tx.item.delete({ where: { id: itemId } });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'item.purge',
        targetType: 'item',
        targetId: itemId,
        diff: { title: item.title, mediaCount } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
  });
}

export async function listTrash(ctx: FamilyContext, limit = 100) {
  const rows = await prisma.item.findMany({
    where: { familyId: ctx.familyId, status: 'trashed' },
    include: LIST_INCLUDE,
    orderBy: { deletedAt: 'desc' },
    take: limit,
  });
  return rows.map((r) => toItemDto(r, ctx.familyId));
}

export async function listVersions(ctx: FamilyContext, itemId: string) {
  const versions = await prisma.itemVersion.findMany({
    where: { itemId, item: { familyId: ctx.familyId } },
    orderBy: { version: 'desc' },
    take: 50,
  });
  return versions.map((v) => ({
    id: v.id,
    version: v.version,
    createdAt: v.createdAt.toISOString(),
    createdBy: v.createdBy,
    snapshot: v.snapshot,
  }));
}

export async function revertVersion(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  versionId: string,
  meta: ActorMeta,
) {
  const { access } = await itemWithAccess(userId, ctx, itemId);
  if (!access.canEdit) throw forbidden();
  const version = await prisma.itemVersion.findFirst({ where: { id: versionId, itemId } });
  if (!version) throw notFound('版本不存在');

  const snap = version.snapshot as Record<string, unknown>;
  const story = cleanStory(typeof snap.storyHtml === 'string' ? snap.storyHtml : null);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.item.update({
      where: { id: itemId },
      data: {
        title: snap.title as string,
        category: snap.category as Category,
        visibility: snap.visibility as Visibility,
        acquiredAt: snap.acquiredAt ? new Date(snap.acquiredAt as string) : null,
        acquiredPrecision: snap.acquiredPrecision as Precision,
        acquiredLabel: (snap.acquiredLabel as string | null) ?? null,
        acquiredNote: (snap.acquiredNote as string | null) ?? null,
        placeText: (snap.placeText as string | null) ?? null,
        placeCity: (snap.placeCity as string | null) ?? null,
        placeProvince: (snap.placeProvince as string | null) ?? null,
        placeCountry: (snap.placeCountry as string | null) ?? null,
        storyHtml: story.html,
        storyText: story.text || null,
        condition: (snap.condition as string | null) ?? null,
        storageLocation: (snap.storageLocation as string | null) ?? null,
        tags: (snap.tags as string[] | undefined) ?? [],
        sortAt: computeSortAt(
          {
            acquiredAt: snap.acquiredAt ? new Date(snap.acquiredAt as string) : null,
            acquiredPrecision: snap.acquiredPrecision as Precision,
          },
          new Date(),
        ),
      },
      include: LIST_INCLUDE,
    });
    const last = await tx.itemVersion.findFirst({ where: { itemId }, orderBy: { version: 'desc' } });
    await tx.itemVersion.create({
      data: {
        itemId,
        version: (last?.version ?? 0) + 1,
        snapshot: toVersionSnapshot(updated),
        createdBy: userId,
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'item.revert',
        targetType: 'item',
        targetId: itemId,
        diff: { revertedTo: version.version } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return toItemDto(updated, ctx.familyId);
  });
}

export interface TimelineGroup {
  key: string;
  label: string;
  count: number;
  items: ReturnType<typeof toItemDto>[];
}

export async function timeline(userId: string, ctx: FamilyContext, limitGroups = 20): Promise<TimelineGroup[]> {
  const rows = await prisma.item.findMany({
    where: {
      AND: [
        { familyId: ctx.familyId },
        { deletedAt: null },
        { status: { in: ['published', 'archived'] } },
        itemVisibilityWhere(userId, ctx.role),
      ],
    },
    include: LIST_INCLUDE,
    orderBy: [{ sortAt: 'desc' }, { id: 'desc' }],
    take: 2000,
  });

  const groups = new Map<string, TimelineGroup>();
  for (const row of rows) {
    const key = timelineGroupKey(
      { acquiredAt: row.acquiredAt, acquiredPrecision: row.acquiredPrecision, acquiredLabel: row.acquiredLabel },
      row.createdAt,
    );
    const label = key === 'unknown' ? '时间不详' : key.endsWith('s') ? `${key.slice(0, -1)} 年代` : `${key} 年`;
    let group = groups.get(key);
    if (!group) {
      group = { key, label, count: 0, items: [] };
      groups.set(key, group);
    }
    group.count += 1;
    if (group.items.length < 12) group.items.push(toItemDto(row, ctx.familyId));
  }

  return [...groups.values()]
    .sort((a, b) => {
      if (a.key === 'unknown') return 1;
      if (b.key === 'unknown') return -1;
      return b.key.localeCompare(a.key);
    })
    .slice(0, limitGroups);
}
