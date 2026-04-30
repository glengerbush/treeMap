import { error, json } from '@sveltejs/kit';
import { deleteLayerFeature, updateLayerFeature } from '$lib/server/layerFeatures.js';

export async function PUT({ params, request }) {
  const input = await request.json();
  const feature = updateLayerFeature(params.layerId, params.id, input);

  if (!feature) {
    error(404, 'Layer feature not found');
  }

  return json({ feature });
}

export function DELETE({ params }) {
  if (!deleteLayerFeature(params.layerId, params.id)) {
    error(404, 'Layer feature not found');
  }

  return new Response(null, { status: 204 });
}
