import { describe, expect, it, vi } from 'vitest';

// collectReferencedKeys 只用到 prisma.itemMedia.findMany，这里用桩数据代替真实数据库，
// 重点验证「从行集合重算引用」的纯逻辑：共享 key 的存活记录必须保护彼此的文件。
const findMany = vi.fn();
vi.mock('../db', () => ({
  prisma: {
    itemMedia: { findMany: (...args: unknown[]) => findMany(...args) },
  },
}));

import { collectReferencedKeys, rowRetainsFiles, GC_GRACE_MS, type MediaRefRow } from './storageGcService';

const DAY = 86_400_000;
const NOW = new Date('2026-10-06T12:00:00.000Z');

function row(partial: Partial<MediaRefRow> = {}): MediaRefRow {
  return {
    storageKey: 'families/f/objects/ab/abc.jpg',
    thumbKey: 'families/f/derived/ab/abc-thumb.webp',
    largeKey: 'families/f/derived/ab/abc-lg.webp',
    transcodeKey: null,
    waveformKey: null,
    deletedAt: null,
    item: { status: 'published', deletedAt: null },
    ...partial,
  };
}

describe('rowRetainsFiles（一条媒体记录的文件保留判定）', () => {
  it('存活条目上的媒体始终保留', () => {
    expect(rowRetainsFiles(row(), NOW)).toBe(true);
    expect(rowRetainsFiles(row({ item: { status: 'draft', deletedAt: null } }), NOW)).toBe(true);
    expect(rowRetainsFiles(row({ item: { status: 'archived', deletedAt: null } }), NOW)).toBe(true);
  });

  it('单条软删：宽限期内保留，超过宽限期不再保留', () => {
    const recent = row({ deletedAt: new Date(NOW.getTime() - 3600_000) });
    expect(rowRetainsFiles(recent, NOW)).toBe(true);

    const old = row({ deletedAt: new Date(NOW.getTime() - GC_GRACE_MS - 3600_000) });
    expect(rowRetainsFiles(old, NOW)).toBe(false);
  });

  it('条目在回收站：保留期内保留，到期后不再保留', () => {
    const inTrash = row({ deletedAt: null, item: { status: 'trashed', deletedAt: new Date(NOW.getTime() - 10 * DAY) } });
    expect(rowRetainsFiles(inTrash, NOW)).toBe(true);

    const expired = row({ deletedAt: null, item: { status: 'trashed', deletedAt: new Date(NOW.getTime() - 31 * DAY) } });
    expect(rowRetainsFiles(expired, NOW)).toBe(false);
  });
});

describe('collectReferencedKeys（从数据库重算引用集合）', () => {
  it('重复上传的同一 key：删除其中一条记录后，另一条仍保护文件', async () => {
    const shared = 'families/f/objects/ab/shared.png';
    const sharedThumb = 'families/f/derived/ab/shared-thumb.webp';
    findMany.mockResolvedValue([
      row({ storageKey: shared, thumbKey: sharedThumb, largeKey: null }), // 存活条目 A
      row({
        // 已软删且超过宽限期的记录 B，与 A 共用同一内容寻址文件
        storageKey: shared,
        thumbKey: sharedThumb,
        largeKey: null,
        deletedAt: new Date(NOW.getTime() - 10 * DAY),
      }),
    ]);

    const refs = await collectReferencedKeys(NOW);
    expect(refs.has(shared)).toBe(true);
    expect(refs.has(sharedThumb)).toBe(true);
  });

  it('只有过期记录引用的 key 不进入引用集合（可被 GC 回收）', async () => {
    findMany.mockResolvedValue([
      row({ storageKey: 'gone-raw', thumbKey: 'gone-thumb', largeKey: null, deletedAt: new Date(NOW.getTime() - 10 * DAY) }),
    ]);
    const refs = await collectReferencedKeys(NOW);
    expect(refs.has('gone-raw')).toBe(false);
    expect(refs.has('gone-thumb')).toBe(false);
  });

  it('回收站保留期内的条目，其全部产物仍在引用集合中', async () => {
    findMany.mockResolvedValue([
      row({
        transcodeKey: 'families/f/derived/ab/a.mp3',
        waveformKey: 'families/f/derived/ab/a.waveform.json',
        item: { status: 'trashed', deletedAt: new Date(NOW.getTime() - 2 * DAY) },
      }),
    ]);
    const refs = await collectReferencedKeys(NOW);
    expect(refs.has('families/f/derived/ab/a.mp3')).toBe(true);
    expect(refs.has('families/f/derived/ab/a.waveform.json')).toBe(true);
  });

  it('空结果不报错（全新实例或无媒体库）', async () => {
    findMany.mockResolvedValue([]);
    const refs = await collectReferencedKeys(NOW);
    expect(refs.size).toBe(0);
  });
});
