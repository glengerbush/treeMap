import { error, json } from '@sveltejs/kit';
import { insertLayerFeature, listLayerFeatures, replaceLayerFeatures } from '$lib/server/layerFeatures.js';

export function GET({ params }) {
  const features = listLayerFeatures(params.layerId);

  return json({
    layerId: params.layerId,
    features
  });
}

export async function POST({ params, request }) {
  const input = await request.json();
  const batch = Array.isArray(input) ? input : input?.features;

  if (batch !== undefined) {
    if (!Array.isArray(batch)) {
      error(400, 'Expected features to be an array.');
    }

    const features = replaceLayerFeatures(params.layerId, batch);
    return json({ features });
  }

  const feature = insertLayerFeature(params.layerId, input);

  return json({ feature }, { status: 201 });
}
