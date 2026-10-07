import { describe, expect, it, vi } from 'vitest';
import { collectMediaKeys, unreferencedKeys, removeUnreferencedKeys, MEDIA_KEY_FIELDS } from './storageRefs';

describe('内容寻址存储的引用重算', () => {
  it('收集一行媒体引用的全部 key（含派生产物，跳过空值）', () => {
    const keys = collectMediaKeys([
      { storageKey: 'raw1', thumbKey: 'thumb1', largeKey: 'large1', transcodeKey: null, waveformKey: null },
      { storageKey: 'raw2', thumbKey: null, largeKey: null, transcodeKey: 'mp3-2', waveformKey: 'wave-2' },
    ]);
    expect([...keys].sort()).toEqual(['large1', 'mp3-2', 'raw1', 'raw2', 'thumb1', 'wave-2']);
  });

  it('重复 sha256 的多条记录共享 key：删掉一条后 key 仍被引用，不得回收', () => {
    // 两条媒体记录指向同一份内容寻址文件及其缩略图（重复上传场景）
    const rows = [
      { storageKey: 'shared-raw', thumbKey: 'shared-thumb', largeKey: 'shared-lg', transcodeKey: null, waveformKey: null },
      { storageKey: 'shared-raw', thumbKey: 'shared-thumb', largeKey: 'shared-lg', transcodeKey: null, waveformKey: null },
    ];

    // 模拟删除第一条记录：候选 key 来自被删记录，但引用集合由剩下的记录重算
    const candidates = collectMediaKeys([rows[0]]);
    const stillReferenced = collectMediaKeys([rows[1]]);
    expect(unreferencedKeys([...candidates], stillReferenced)).toEqual([]);

    // 两条都删掉后，key 才真正失去引用
    expect(unreferencedKeys([...candidates], new Set())).toEqual(['shared-raw', 'shared-thumb', 'shared-lg']);
  });

  it('候选列表去重且结果稳定', () => {
    const dead = unreferencedKeys(['a', 'a', null as unknown as string, 'b'], new Set(['b']));
    expect(dead).toEqual(['a']);
  });

  it('覆盖五个存储列，防止新增产物列后漏算引用', () => {
    expect(MEDIA_KEY_FIELDS).toEqual(['storageKey', 'thumbKey', 'largeKey', 'transcodeKey', 'waveformKey']);
  });
});

describe('removeUnreferencedKeys 的删除门槛', () => {
  function dbWithMedia(rows: Array<Record<string, string | null>>) {
    const all = [...rows];
    return {
      itemMedia: {
        // 测试数据远小于批量，findMany 一次返回即可
        findMany: vi.fn(async () => all.map((r) => ({ id: r.storageKey ?? Math.random(), ...r }))),
      },
    } as never;
  }

  it('仍被引用的 key 不调用底层删除；无引用的老文件才删', async () => {
    vi.resetModules();
    const storage = await import('../storage/local');
    const removed: string[] = [];
    vi.spyOn(storage, 'remove').mockImplementation(async (key) => {
      removed.push(key);
    });
    vi.spyOn(storage, 'statObject').mockImplementation(async () => ({ size: 1, mtimeMs: 0 }));

    const { removeUnreferencedKeys: removeFn } = await import('./storageRefs');
    const db = dbWithMedia([
      { storageKey: 'still-used', thumbKey: null, largeKey: null, transcodeKey: null, waveformKey: null },
    ]);

    const result = await removeFn(db, ['still-used', 'orphan'], { minAgeMs: 24 * 3600 * 1000 });
    expect(result).toEqual(['orphan']);
    expect(removed).toEqual(['orphan']);
  });

  it('minAgeMs 宽限内的新文件保留，避免并发上传误删', async () => {
    vi.resetModules();
    const storage = await import('../storage/local');
    vi.spyOn(storage, 'remove').mockResolvedValue(undefined);
    vi.spyOn(storage, 'statObject').mockImplementation(async () => ({ size: 1, mtimeMs: Date.now() }));

    const { removeUnreferencedKeys: removeFn } = await import('./storageRefs');
    const db = dbWithMedia([]);
    expect(await removeFn(db, ['fresh'], { minAgeMs: 24 * 3600 * 1000 })).toEqual([]);
    expect(storage.remove).not.toHaveBeenCalled();

    // minAgeMs: 0 时（storage_gc 已自行按 mtime 过滤）直接删
    expect(await removeFn(db, ['fresh'], { minAgeMs: 0 })).toEqual(['fresh']);
  });

  it('空候选直接返回，不查库', async () => {
    const findMany = vi.fn();
    const db = { itemMedia: { findMany } } as never;
    expect(await removeUnreferencedKeys(db, [])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
