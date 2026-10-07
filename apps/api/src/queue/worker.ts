import type { Job } from '@prisma/client';
import type { Dirent } from 'node:fs';
import { config } from '../config';
import { prisma } from '../db';
import { logger } from '../logger';
import { processImage } from '../media/image';
import { processAudio } from '../media/audio';
import { inspectDocument } from '../media/document';
import { putBuffer } from '../storage/local';
import { makeTmpPath } from '../services/mediaService';
import { collectReferencedKeys, GC_GRACE_MS } from '../services/storageGcService';
import { buildExportZip } from '../services/exportService';

type Handler = (job: Job) => Promise<Record<string, unknown>>;

async function handleThumbnail(job: Job): Promise<Record<string, unknown>> {
  const { mediaId } = job.payload as { mediaId: string };
  const media = await prisma.itemMedia.findUnique({ where: { id: mediaId } });
  if (!media) return { skipped: '媒体已删除' };
  try {
    if (media.kind === 'image') {
      const item = await prisma.item.findUniqueOrThrow({ where: { id: media.itemId } });
      const variants = await processImage(absPathOf(media.storageKey), item.familyId, media.sha256, putBuffer);
      await prisma.itemMedia.update({
        where: { id: mediaId },
        data: {
          status: 'ready',
          thumbKey: variants.thumbKey,
          largeKey: variants.largeKey,
          width: variants.width,
          height: variants.height,
          lastError: null,
        },
      });
      return { thumbKey: variants.thumbKey, width: variants.width, height: variants.height };
    }
    if (media.kind === 'document') {
      const info = await inspectDocument(absPathOf(media.storageKey));
      await prisma.itemMedia.update({
        where: { id: mediaId },
        data: { status: 'ready', lastError: null },
      });
      return { pageCount: info.pageCount };
    }
    await prisma.itemMedia.update({ where: { id: mediaId }, data: { status: 'ready' } });
    return { skipped: '非图片/文档' };
  } catch (err) {
    await prisma.itemMedia.update({
      where: { id: mediaId },
      data: { status: 'failed', lastError: err instanceof Error ? err.message.slice(0, 500) : '处理失败' },
    });
    throw err;
  }
}

function absPathOf(key: string): string {
  // 延迟引入，避免循环依赖
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { absOf } = require('../storage/local') as typeof import('../storage/local');
  return absOf(key);
}

async function handleWaveform(job: Job): Promise<Record<string, unknown>> {
  const { mediaId } = job.payload as { mediaId: string };
  const media = await prisma.itemMedia.findUnique({ where: { id: mediaId } });
  if (!media) return { skipped: '媒体已删除' };
  const item = await prisma.item.findUniqueOrThrow({ where: { id: media.itemId } });
  const variants = await processAudio(
    absPathOf(media.storageKey),
    item.familyId,
    media.sha256,
    putBuffer,
    makeTmpPath,
  );
  await prisma.itemMedia.update({
    where: { id: mediaId },
    data: {
      status: 'ready',
      transcodeKey: variants.transcodeKey,
      waveformKey: variants.waveformKey,
      durationMs: variants.durationMs,
      lastError: null,
    },
  });
  return { transcodeKey: variants.transcodeKey, peaks: variants.peakCount, durationMs: variants.durationMs };
}

async function handleExport(job: Job): Promise<Record<string, unknown>> {
  const result = await buildExportZip(job);
  return { items: result.items, media: result.media, bytes: result.bytes, file: result.file };
}

/**
 * 回收站保留期到期后彻底删除。
 *
 * 只删数据库行，不删磁盘文件：文件按 sha256 内容寻址，可能被其他条目
 * （或同家庭中重复上传的媒体记录）共享。物理文件统一交给随后的
 * storage_gc 任务按重算出的引用集合回收，删除一条记录不会连累共享文件的其他记录。
 */
async function handleTrashPurge(): Promise<Record<string, unknown>> {
  const cutoff = new Date(Date.now() - config.TRASH_RETENTION_DAYS * 86_400_000);
  const expired = await prisma.item.findMany({
    where: { status: 'trashed', deletedAt: { lt: cutoff } },
    select: { id: true },
    take: 500,
  });
  let removed = 0;
  for (const item of expired) {
    // 媒体行随外键 onDelete: Cascade 一并删除；磁盘文件由 storage_gc 回收
    await prisma.item.delete({ where: { id: item.id } });
    removed += 1;
  }
  return { removed, cutoff: cutoff.toISOString() };
}

/**
 * 清理孤儿文件与过期导出包，防止磁盘只涨不降。
 *
 * 引用集合每次从数据库全量重算（见 storageGcService），不维护、也不依赖
 * 任何引用计数列，因此可重复执行、对老数据与备份恢复的数据天然兼容：
 * 同一份内容寻址文件只要还有任一存活记录引用就保留；无引用的文件
 * 还要超过宽限期才删，避开并发上传/处理与备份窗口。
 */
async function handleStorageGc(): Promise<Record<string, unknown>> {
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const referenced = await collectReferencedKeys();

  const root = config.STORAGE_ROOT;
  let scanned = 0;
  let deleted = 0;
  const cutoff = Date.now() - GC_GRACE_MS;

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'tmp') continue; // 临时目录单独处理
        await walk(full);
        continue;
      }
      scanned += 1;
      const key = path.relative(root, full).split(path.sep).join('/');
      if (referenced.has(key)) continue;
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat || stat.mtimeMs > cutoff) continue;
      await fsp.rm(full, { force: true });
      deleted += 1;
    }
  }
  await walk(root);

  // 临时目录里超过 24 小时的残留（中断的上传）直接清掉
  const tmp = path.join(root, 'tmp');
  for (const name of await fsp.readdir(tmp).catch(() => [])) {
    const full = path.join(tmp, name);
    const stat = await fsp.stat(full).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) {
      await fsp.rm(full, { force: true, recursive: true });
      deleted += 1;
    }
  }

  // 过期导出包
  const exportCutoff = Date.now() - config.EXPORT_RETENTION_DAYS * 86_400_000;
  for (const familyDir of await fsp.readdir(config.EXPORT_ROOT).catch(() => [])) {
    const dir = path.join(config.EXPORT_ROOT, familyDir);
    for (const file of await fsp.readdir(dir).catch(() => [])) {
      const full = path.join(dir, file);
      const stat = await fsp.stat(full).catch(() => null);
      if (stat && stat.mtimeMs < exportCutoff) {
        await fsp.rm(full, { force: true });
        deleted += 1;
      }
    }
  }

  return { scanned, referenced: referenced.size, deleted };
}

const HANDLERS: Record<string, Handler> = {
  media_thumbnail: handleThumbnail,
  media_waveform: handleWaveform,
  export_build: handleExport,
  trash_purge: handleTrashPurge,
  storage_gc: handleStorageGc,
};

/** 原子领取一个任务：UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)。 */
async function claimJob(): Promise<Job | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE jobs SET status = 'running', started_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND run_after <= now()
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `;
  const first = rows[0];
  if (!first) return null;
  return prisma.job.findUnique({ where: { id: first.id } });
}

async function runOnce(): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;
  const handler = HANDLERS[job.type];
  if (!handler) {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'failed', finishedAt: new Date(), lastError: `未知任务类型 ${job.type}` },
    });
    return true;
  }
  try {
    const result = await handler(job);
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'done', progress: 100, finishedAt: new Date(), result: result as never, lastError: null },
    });
    logger.info({ jobId: job.id, type: job.type, result }, '任务完成');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exhausted = job.attempts >= job.maxAttempts;
    const backoffMs = Math.min(30 * 60_000, 60_000 * 5 ** Math.max(0, job.attempts - 1));
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: exhausted ? 'failed' : 'queued',
        lastError: message.slice(0, 1000),
        finishedAt: exhausted ? new Date() : null,
        runAfter: new Date(Date.now() + backoffMs),
      },
    });
    logger.error({ jobId: job.id, type: job.type, attempts: job.attempts, err: message }, '任务失败');
  }
  return true;
}

const DAILY = 24 * 3600 * 1000;

export function startWorker(): () => void {
  if (!config.WORKER_ENABLED) {
    logger.warn('WORKER_ENABLED=false，后台任务不会执行（缩略图/波形/导出将一直处于排队状态）');
    return () => undefined;
  }
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      let processed = 0;
      while (processed < 5 && (await runOnce())) processed += 1;
    } catch (err) {
      logger.error({ err }, 'worker 轮询失败');
    }
    if (!stopped) timer = setTimeout(tick, config.WORKER_POLL_MS);
  };
  timer = setTimeout(tick, 1000);

  // 每日维护任务：回收站清理 + 孤儿文件回收；重复入队是幂等的，这里只保证每天至少跑一次
  const daily = setInterval(() => {
    void prisma.job
      .create({ data: { type: 'trash_purge', payload: {} as never } })
      .then(() => prisma.job.create({ data: { type: 'storage_gc', payload: {} as never } }))
      .catch((err) => logger.error({ err }, '每日维护任务入队失败'));
  }, DAILY);

  logger.info({ pollMs: config.WORKER_POLL_MS }, '后台任务 worker 已启动');
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    clearInterval(daily);
  };
}

export const __test__ = { runOnce, computeBackoffForTest: (attempts: number) => Math.min(30 * 60_000, 60_000 * 5 ** Math.max(0, attempts - 1)) };
