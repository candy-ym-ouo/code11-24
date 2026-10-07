import type { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../logger';
import { remove, statObject } from '../storage/local';

/**
 * 内容寻址存储的引用计数清理。
 *
 * 存储路径由「家庭 + sha256」决定，同一份文件被多次上传时只占一份盘，
 * 但会对应多条 item_media 记录；派生产物（缩略图 / 大图 / 转码 mp3 / 波形）
 * 同样按 sha256 复用。因此删除任何一条媒体记录都不能直接删文件——
 * 必须先在全库范围内重新计算引用，只删掉确实没有任何记录再引用的 key。
 *
 * 不维护持久化引用计数表：每次清理都以数据库现状为准重算，
 * 这样历史数据（含曾经被误删过文件的库）无需迁移、可自愈，
 * 也不会因为计数与磁盘漂移而误删仍在用的文件。
 */

export type MediaKeyColumns = {
  storageKey: string | null;
  thumbKey: string | null;
  largeKey: string | null;
  transcodeKey: string | null;
  waveformKey: string | null;
};

export const MEDIA_KEY_FIELDS = ['storageKey', 'thumbKey', 'largeKey', 'transcodeKey', 'waveformKey'] as const;

export type DbClient = PrismaClient | Prisma.TransactionClient;

/** 把一批媒体行引用的所有存储 key（含派生产物）收进集合。纯函数，便于单测。 */
export function collectMediaKeys(rows: MediaKeyColumns[], into: Set<string> = new Set()): Set<string> {
  for (const row of rows) {
    for (const field of MEDIA_KEY_FIELDS) {
      const key = row[field];
      if (key) into.add(key);
    }
  }
  return into;
}

/**
 * 加载当前仍被 item_media 引用的全部 key。
 *
 * 软删除（deletedAt 非空）的记录仍保留文件：用户可以从回收站恢复条目，
 * 回收站到期由 trash_purge 彻底删行后，文件才会在这里失去引用。
 */
export async function loadReferencedKeys(tx: DbClient): Promise<Set<string>> {
  const referenced = new Set<string>();
  const BATCH = 1000;
  let cursor: string | undefined;
  // 分批扫描，避免大库一次性把所有行拉进内存
  for (;;) {
    const rows = await tx.itemMedia.findMany({
      select: {
        id: true,
        storageKey: true,
        thumbKey: true,
        largeKey: true,
        transcodeKey: true,
        waveformKey: true,
      },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    collectMediaKeys(rows, referenced);
    if (rows.length < BATCH) break;
    const lastId = rows[rows.length - 1]?.id;
    if (!lastId) break;
    cursor = lastId;
  }
  return referenced;
}

/** 从候选 key 里挑出已无任何引用的。纯函数，便于单测。 */
export function unreferencedKeys(candidates: readonly (string | null | undefined)[], referenced: ReadonlySet<string>): string[] {
  const result = new Set<string>();
  for (const key of candidates) {
    if (key && !referenced.has(key)) result.add(key);
  }
  return [...result];
}

export interface RemoveUnreferencedOptions {
  /**
   * 最小文件年龄（毫秒）：mtime 比它新的文件先保留。
   * 默认 24 小时，给「文件刚落盘、数据库行还没提交」的并发上传留出窗口，
   * 也与 storage_gc 任务的宽限策略一致；确信调用方已自行做过 mtime 过滤时传 0。
   */
  minAgeMs?: number;
  /** 预加载的引用集合；不传则现场全库重算。 */
  referenced?: ReadonlySet<string>;
}

/**
 * 删除候选 key 中已无任何 item_media 引用的磁盘文件。
 *
 * 删除前会再次查询引用（调用方传入 referenced 时除外）并重读 mtime，
 * 保证与「删库 → 删文件」之间的并发上传不会误伤：同一 sha256 的新记录
 * 一旦提交，这里就不会再删它的文件。
 *
 * 返回真正删掉的 key。单文件删除失败不影响其余文件。
 */
export async function removeUnreferencedKeys(
  db: DbClient,
  candidates: readonly string[],
  opts: RemoveUnreferencedOptions = {},
): Promise<string[]> {
  const uniqueCandidates = [...new Set(candidates.filter(Boolean))];
  if (uniqueCandidates.length === 0) return [];

  const referenced = opts.referenced ?? (await loadReferencedKeys(db));
  const dead = unreferencedKeys(uniqueCandidates, referenced);
  if (dead.length === 0) return [];

  const minAgeMs = opts.minAgeMs ?? 24 * 3600 * 1000;
  const now = Date.now();
  const removed: string[] = [];
  await Promise.all(
    dead.map(async (key) => {
      try {
        if (minAgeMs > 0) {
          const stat = await statObject(key);
          if (!stat || stat.mtimeMs > now - minAgeMs) return;
        }
        await remove(key);
        removed.push(key);
      } catch (err) {
        logger.warn({ key, err: err instanceof Error ? err.message : String(err) }, '回收无引用媒体文件失败，跳过');
      }
    }),
  );
  return removed;
}
