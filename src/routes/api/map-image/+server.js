import { error, json } from '@sveltejs/kit';
import { deleteMapImage, getMapImage, saveMapImage } from '$lib/server/mapImage.js';

export function GET() {
  return json({ image: getMapImage() });
}

export async function POST({ request }) {
  const formData = await request.formData();
  const image = formData.get('image');

  try {
    return json({ image: await saveMapImage(image) });
  } catch (uploadError) {
    error(400, uploadError instanceof Error ? uploadError.message : 'The satellite photo could not be saved.');
  }
}

export function DELETE() {
  try {
    return json({ deleted: deleteMapImage(), image: null });
  } catch (deleteError) {
    error(500, deleteError instanceof Error ? deleteError.message : 'The satellite photo could not be deleted.');
  }
}
