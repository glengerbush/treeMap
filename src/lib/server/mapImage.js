import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapConfig } from '../mapConfig.js';
import { getDb } from './db.js';

const MAP_IMAGE_ID = 'satellite';
const MAX_IMAGE_BYTES = 80 * 1024 * 1024;
const mapImageDir = join(process.cwd(), 'data', 'maps');

function cleanName(value) {
  if (typeof value !== 'string') return 'Satellite';
  return value.trim().replace(/[^\w .()[\]-]+/g, '').slice(0, 160) || 'Satellite';
}

function customImageUrl(updatedAt) {
  return `/api/map-image/file?updatedAt=${encodeURIComponent(updatedAt)}`;
}

function rowToMapImage(row) {
  return {
    url: customImageUrl(row.updatedAt),
    width: row.width,
    height: row.height,
    name: 'Satellite',
    originalName: row.originalName,
    mimeType: row.mimeType,
    updatedAt: row.updatedAt,
    isDefault: false
  };
}

function getMapImageRow() {
  return getDb().prepare('SELECT * FROM map_images WHERE id = ?').get(MAP_IMAGE_ID);
}

export function getMapImage() {
  const row = getMapImageRow();
  return row ? rowToMapImage(row) : null;
}

export function getMapImageDimensions() {
  const image = getMapImageRow();
  return {
    width: image?.width ?? mapConfig.image.width,
    height: image?.height ?? mapConfig.image.height
  };
}

export function getMapImageFile() {
  const row = getMapImageRow();

  if (!row) return null;

  return {
    path: join(mapImageDir, row.filename),
    mimeType: row.mimeType
  };
}

export function deleteMapImage() {
  const previous = getMapImageRow();

  if (!previous) return false;

  if (previous.filename) {
    try {
      unlinkSync(join(mapImageDir, previous.filename));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error('The satellite photo file could not be deleted.');
      }
    }
  }

  getDb().prepare('DELETE FROM map_images WHERE id = ?').run(MAP_IMAGE_ID);

  return true;
}

function readPngDimensions(buffer) {
  if (buffer.length < 24) return null;

  const signature = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== signature) return null;

  return {
    extension: 'png',
    mimeType: 'image/png',
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function isJpegSofMarker(marker) {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function readJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    while (buffer[offset] === 0xff) offset += 1;

    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) break;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (offset + 2 > buffer.length) break;

    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;

    const segmentStart = offset + 2;

    if (isJpegSofMarker(marker) && segmentStart + 5 <= buffer.length) {
      return {
        extension: 'jpg',
        mimeType: 'image/jpeg',
        height: buffer.readUInt16BE(segmentStart + 1),
        width: buffer.readUInt16BE(segmentStart + 3)
      };
    }

    offset += length;
  }

  return null;
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function readWebpDimensions(buffer) {
  if (
    buffer.length < 16 ||
    buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    buffer.subarray(8, 12).toString('ascii') !== 'WEBP'
  ) {
    return null;
  }

  const chunkType = buffer.subarray(12, 16).toString('ascii');

  if (chunkType === 'VP8X' && buffer.length >= 30) {
    return {
      extension: 'webp',
      mimeType: 'image/webp',
      width: readUInt24LE(buffer, 24) + 1,
      height: readUInt24LE(buffer, 27) + 1
    };
  }

  if (chunkType === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return {
      extension: 'webp',
      mimeType: 'image/webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    };
  }

  if (
    chunkType === 'VP8 ' &&
    buffer.length >= 30 &&
    buffer[23] === 0x9d &&
    buffer[24] === 0x01 &&
    buffer[25] === 0x2a
  ) {
    return {
      extension: 'webp',
      mimeType: 'image/webp',
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff
    };
  }

  return null;
}

function readImageDetails(buffer) {
  const details = readPngDimensions(buffer) ?? readJpegDimensions(buffer) ?? readWebpDimensions(buffer);

  if (!details || details.width <= 0 || details.height <= 0) {
    throw new Error('Use a PNG, JPEG, or WebP image.');
  }

  return details;
}

export async function saveMapImage(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error('Choose an image file to upload.');
  }

  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('Choose an image smaller than 80 MB.');
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  if (!buffer.length) {
    throw new Error('Choose a non-empty image file.');
  }

  const details = readImageDetails(buffer);
  const now = new Date().toISOString();
  const filename = `satellite-${now.replace(/[:.]/g, '-')}-${randomUUID()}.${details.extension}`;
  const db = getDb();
  const previous = getMapImageRow();

  mkdirSync(mapImageDir, { recursive: true });
  writeFileSync(join(mapImageDir, filename), buffer, { flag: 'wx' });

  db.prepare(
    `INSERT INTO map_images (
      id, filename, originalName, mimeType, width, height, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      filename = excluded.filename,
      originalName = excluded.originalName,
      mimeType = excluded.mimeType,
      width = excluded.width,
      height = excluded.height,
      updatedAt = excluded.updatedAt`
  ).run(
    MAP_IMAGE_ID,
    filename,
    cleanName(file.name),
    details.mimeType,
    details.width,
    details.height,
    now,
    now
  );

  if (previous?.filename && previous.filename !== filename) {
    try {
      unlinkSync(join(mapImageDir, previous.filename));
    } catch {
      // The old image is only a cache artifact; a failed cleanup should not block the new upload.
    }
  }

  return getMapImage();
}
