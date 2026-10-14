import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { env } from '../config/env';

/**
 * Where uploaded files land on disk, and the URL prefix nginx/Express serves
 * them back under. One subfolder per feature keeps them from colliding —
 * `announcements` today, more later without renaming anything already live.
 */
export const UPLOADS_ROOT = path.join(process.cwd(), 'uploads');
export const UPLOADS_URL_PREFIX = '/uploads';

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Multer middleware for a single `image` field, saved under `uploads/<folder>/`. */
export function imageUpload(folder: string) {
  const dir = path.join(UPLOADS_ROOT, folder);
  ensureDir(dir);

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `${Date.now()}-${randomBytes(8).toString('hex')}${ext}`);
    },
  });

  return multer({
    storage,
    limits: { fileSize: MAX_IMAGE_BYTES },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
        cb(new Error('Зөвхөн зураг (jpg, png, webp, gif) оруулна уу'));
        return;
      }
      cb(null, true);
    },
  }).single('image');
}

/** The absolute URL a saved upload is reachable at. */
export function uploadUrl(folder: string, filename: string): string {
  return `${env.PUBLIC_BASE_URL}${UPLOADS_URL_PREFIX}/${folder}/${filename}`;
}
