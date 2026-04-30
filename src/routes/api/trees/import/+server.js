import { error, json } from '@sveltejs/kit';
import { upsertTrees } from '$lib/server/trees.js';

export async function POST({ request }) {
  const payload = await request.json();
  const inputs = Array.isArray(payload) ? payload : payload.trees;

  if (!Array.isArray(inputs)) {
    error(400, 'Expected an array of trees or an object with a trees array');
  }

  const trees = upsertTrees(inputs);

  return json({ trees, count: trees.length });
}
