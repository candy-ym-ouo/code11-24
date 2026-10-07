import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { config } from '../config';

export interface StoredObject {
  key: string;
  absPath: string;
  sha256: string;
  size: number;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
};

export function extensionFor(mime: string): string {
  return EXT_BY_MIME[mime] ?? 'bin';
}

/** 内容寻址路径：families/<fid>/objects/<sha 前两位>/<sha>.<ext>，天然去重且可校验。 */
export function objectKey(familyId: string, sha256: string, mime: string): string {
  return path.posix.join('families', familyId, 'objects', sha256.slice(0, 2), `${sha256}.${extensionFor(mime)}`);
}

export function derivedKey(familyId: string, sha256: string, suffix: string): string {
  return path.posix.join('families', familyId, 'derived', sha256.slice(0, 2), `${sha256}${suffix}`);
}

export function absOf(key: string): string {
  const target = path.join(config.STORAGE_ROOT, key);
  const root = path.resolve(config.STORAGE_ROOT);
  if (!path.resolve(target).startsWith(root)) {
    // 防御路径穿越：key 只可能由服务端生成，这里再兜一层
    throw new Error(`非法的存储 key: ${key}`);
  }
  return target;
}

export async function ensureDirs(): Promise<void> {
  for (const dir of [config.STORAGE_ROOT, config.EXPORT_ROOT, config.BACKUP_ROOT]) {
    await fsp.mkdir(dir, { recursive: true });
  }
  await fsp.mkdir(path.join(config.STORAGE_ROOT, 'tmp'), { recursive: true });
}

export async function putStream(key: string, source: Readable): Promise<void> {
  const target = absOf(key);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.part-${Date.now()}`;
  await pipeline(source, fs.createWriteStream(tmp));
  await fsp.rename(tmp, target);
}

export async function putBuffer(key: string, data: Buffer): Promise<void> {
  const target = absOf(key);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, data);
}

export function readStream(key: string, range?: { start: number; end: number }): Readable {
  return createReadStream(absOf(key), range);
}

export async function statObject(key: string): Promise<{ size: number } | null> {
  try {
    const st = await fsp.stat(absOf(key));
    return { size: st.size };
  } catch {
    return null;
  }
}

export async function exists(key: string): Promise<boolean> {
  return (await statObject(key)) !== null;
}

export async function remove(key: string): Promise<void> {
  await fsp.rm(absOf(key), { force: true });
}

/**
 * 更新文件 mtime 为当前时间。内容寻址命中（重复上传复用既有文件）时调用：
 * 孤儿回收以 mtime 作为宽限判据，复用一份可能很旧的文件后必须“碰一下”，
 * 避免它刚被新记录引用就被 GC 当成过期文件删掉。
 */
export async function touch(key: string): Promise<void> {
  const now = new Date();
  await fsp.utimes(absOf(key), now, now);
}

export async function readJson<T>(key: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(absOf(key), 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function writeJson(key: string, value: unknown): Promise<void> {
  await putBuffer(key, Buffer.from(JSON.stringify(value), 'utf8'));
}

export async function moveIntoPlace(tmpPath: string, key: string): Promise<void> {
  const target = absOf(key);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.rename(tmpPath, target);
  } catch {
    // 跨设备时 rename 会失败，退化为复制后删除
    await fsp.copyFile(tmpPath, target);
    await fsp.rm(tmpPath, { force: true });
  }
}

export function tmpDir(): string {
  return path.join(config.STORAGE_ROOT, 'tmp');
}

