import { readFile } from 'node:fs/promises';
import { error } from '@sveltejs/kit';
import { getMapImageFile } from '$lib/server/mapImage.js';

export async function GET() {
  const image = getMapImageFile();

  if (!image) {
    error(404, 'Map image not found');
  }

  try {
    const file = await readFile(image.path);

    return new Response(file, {
      headers: {
        'content-type': image.mimeType,
        'cache-control': 'no-store'
      }
    });
  } catch {
    error(404, 'Map image not found');
  }
}
