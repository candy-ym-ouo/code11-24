import { Router } from 'express';
import {
  createItemSchema,
  createNoteSchema,
  listItemsQuerySchema,
  rejectNoteSchema,
  updateItemSchema,
  type ListItemsQuery,
} from '@heirloom/shared';
import { asyncHandler } from '../http/asyncHandler';
import { clientMeta, currentUser } from '../middleware/auth';
import { familyCtx, requireFamily } from '../middleware/family';
import { writeLimiter } from '../middleware/rateLimit';
import { uploadSingle } from '../middleware/upload';
import { queryOf, validateBody, validateQuery } from '../middleware/validation';
import { badRequest } from '../http/errors';
import * as itemService from '../services/itemService';
import * as noteService from '../services/noteService';
import * as mediaService from '../services/mediaService';
import { listTrash } from '../services/itemService';

export const itemsRouter = Router({ mergeParams: true });

itemsRouter.get(
  '/',
  requireFamily('family:read'),
  validateQuery(listItemsQuerySchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const query = queryOf<ListItemsQuery>(req);
    const page = await itemService.listItems(user.id, ctx, query);
    res.json(page);
  }),
);

itemsRouter.post(
  '/',
  requireFamily('item:create'),
  writeLimiter,
  validateBody(createItemSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const item = await itemService.createItem(user.id, ctx, req.body, clientMeta(req));
    res.status(201).json({ item });
  }),
);

itemsRouter.get(
  '/trash',
  requireFamily('item:purge'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json({ items: await listTrash(ctx) });
  }),
);

itemsRouter.get(
  '/:itemId',
  requireFamily('family:read'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    res.json({ item: await itemService.getItemDetail(user.id, ctx, req.params.itemId!) });
  }),
);

itemsRouter.patch(
  '/:itemId',
  requireFamily('family:read'),
  writeLimiter,
  validateBody(updateItemSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const item = await itemService.updateItem(user.id, ctx, req.params.itemId!, req.body, clientMeta(req));
    res.json({ item });
  }),
);

for (const action of ['publish', 'archive', 'restore', 'trash'] as const) {
  itemsRouter.post(
    `/:itemId/${action}`,
    requireFamily('family:read'),
    writeLimiter,
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const ctx = familyCtx(req);
      const item = await itemService.changeStatus(user.id, ctx, req.params.itemId!, action, clientMeta(req));
      res.json({ item });
    }),
  );
}

itemsRouter.delete(
  '/:itemId/purge',
  requireFamily('item:purge'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    await itemService.purgeItem(user.id, ctx, req.params.itemId!, clientMeta(req));
    // 文件不在这里删（可能与其他条目共享内容寻址存储）；让 GC 重算引用后回收。
    await mediaService.enqueue('storage_gc', {});
    res.status(204).end();
  }),
);

itemsRouter.get(
  '/:itemId/versions',
  requireFamily('family:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json({ versions: await itemService.listVersions(ctx, req.params.itemId!) });
  }),
);

itemsRouter.post(
  '/:itemId/versions/:versionId/revert',
  requireFamily('family:read'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const item = await itemService.revertVersion(
      user.id,
      ctx,
      req.params.itemId!,
      req.params.versionId!,
      clientMeta(req),
    );
    res.json({ item });
  }),
);

// ---- 补充故事 / 评论 ----

itemsRouter.get(
  '/:itemId/notes',
  requireFamily('family:read'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    res.json({ notes: await noteService.listNotes(user.id, ctx, req.params.itemId!) });
  }),
);

itemsRouter.post(
  '/:itemId/notes',
  requireFamily('family:read'),
  writeLimiter,
  validateBody(createNoteSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const note = await noteService.createNote(user.id, ctx, req.params.itemId!, req.body, clientMeta(req));
    res.status(201).json({ note });
  }),
);

itemsRouter.post(
  '/:itemId/notes/:noteId/accept',
  requireFamily('family:read'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const note = await noteService.acceptNote(user.id, ctx, req.params.itemId!, req.params.noteId!, clientMeta(req));
    res.json({ note, item: await itemService.getItemDetail(user.id, ctx, req.params.itemId!) });
  }),
);

itemsRouter.post(
  '/:itemId/notes/:noteId/reject',
  requireFamily('family:read'),
  writeLimiter,
  validateBody(rejectNoteSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const note = await noteService.rejectNote(
      user.id,
      ctx,
      req.params.itemId!,
      req.params.noteId!,
      req.body.reason,
      clientMeta(req),
    );
    res.json({ note });
  }),
);

itemsRouter.delete(
  '/:itemId/notes/:noteId',
  requireFamily('family:read'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    await noteService.deleteNote({ id: user.id, role: ctx.role }, ctx, req.params.itemId!, req.params.noteId!);
    res.status(204).end();
  }),
);

// ---- 条目媒体 ----

itemsRouter.get(
  '/:itemId/media',
  requireFamily('family:read'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    res.json({ media: await mediaService.listItemMedia(user.id, ctx, req.params.itemId!) });
  }),
);

itemsRouter.post(
  '/:itemId/media',
  requireFamily('family:read'),
  writeLimiter,
  uploadSingle,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    if (!req.file) throw badRequest('请选择要上传的文件（字段名 file）');
    const media = await mediaService.uploadMedia(
      user.id,
      ctx,
      req.params.itemId!,
      { path: req.file.path, originalname: req.file.originalname, size: req.file.size },
      {
        kind: typeof req.body.kind === 'string' ? req.body.kind : undefined,
        caption: typeof req.body.caption === 'string' ? req.body.caption : null,
        transcript: typeof req.body.transcript === 'string' ? req.body.transcript : null,
      },
      clientMeta(req),
    );
    res.status(202).json({ media });
  }),
);

