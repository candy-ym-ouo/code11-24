import { prisma } from '../db';
import { config } from '../config';

/**
 * 磁盘文件回收的唯一事实来源：每次都从数据库实时重建「仍被引用的存储 key」集合。
 *
 * 设计原则：
 * - 业务删除路径（单条媒体软删、条目彻底删除、回收站到期）只动数据库行，
 *   绝不直接删文件——因为存储按 sha256 内容寻址，同一份文件可能被多条媒体记录共享。
 * - 是否真的能删盘，只由这里重算引用决定，天然引用计数、可重复执行（幂等），
 *   不依赖任何历史计数，因此对老数据、备份恢复回来的数据同样成立。
 */

export interface MediaRefRow {
  storageKey: string | null;
  thumbKey: string | null;
  largeKey: string | null;
  transcodeKey: string | null;
  waveformKey: string | null;
  deletedAt: Date | null;
  item: {
    status: string;
    deletedAt: Date | null;
  } | null;
}

export const MEDIA_KEY_FIELDS = ['storageKey', 'thumbKey', 'largeKey', 'transcodeKey', 'waveformKey'] as const;

/** 宽限期内不回收：覆盖删库与删文件之间的窗口、时钟偏移，以及刚上传/正在处理的文件。 */
export const GC_GRACE_MS = 24 * 3600 * 1000;

/**
 * 一条媒体记录在删除后是否仍需保留其磁盘文件。
 *
 * 以下情况视为「存活」，文件必须保留：
 * - 媒体记录本身未删除，且所属条目也未删除（无论条目状态，草稿/已归档都算）；
 * - 媒体记录被单条软删，但仍在宽限期内（误删可恢复）；
 * - 所属条目在回收站中且仍在回收站保留期内（可恢复）。
 * 超过保留期后文件不再被保留，是否真正删除交给引用集合统一裁决。
 */
export function rowRetainsFiles(
  row: Pick<MediaRefRow, 'deletedAt' | 'item'>,
  now: Date,
  graceMs: number = GC_GRACE_MS,
  trashRetentionMs: number = config.TRASH_RETENTION_DAYS * 86_400_000,
): boolean {
  const cutoff = now.getTime() - graceMs;

  // 条目被删（进回收站）：在回收站保留期内一律保留，到期由 trash_purge 删掉行后再回收
  if (row.item?.deletedAt) {
    const trashedAt = row.item.deletedAt.getTime();
    return trashedAt > now.getTime() - trashRetentionMs;
  }

  // 单条媒体软删：宽限期内保留（此时没有任何接口再展示它，仅作误删缓冲）
  if (row.deletedAt) return row.deletedAt.getTime() > cutoff;

  return true;
}

/**
 * 从数据库重算「仍被引用的存储 key」集合。
 *
 * 同一条 key 被多条媒体记录引用时，只要还有任一存活记录就保留——
 * 这正是修复「删除一条重复上传的记录连累其他条目」的关键。
 */
export async function collectReferencedKeys(now: Date = new Date()): Promise<Set<string>> {
  const rows = await prisma.itemMedia.findMany({
    select: {
      storageKey: true,
      thumbKey: true,
      largeKey: true,
      transcodeKey: true,
      waveformKey: true,
      deletedAt: true,
      item: { select: { status: true, deletedAt: true } },
    },
  });

  const referenced = new Set<string>();
  for (const row of rows) {
    if (!rowRetainsFiles(row, now)) continue;
    for (const field of MEDIA_KEY_FIELDS) {
      const key = row[field];
      if (key) referenced.add(key);
    }
  }
  return referenced;
}
