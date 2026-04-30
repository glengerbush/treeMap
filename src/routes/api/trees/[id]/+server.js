import { error, json } from '@sveltejs/kit';
import { deleteTree, updateTree } from '$lib/server/trees.js';

export async function PUT({ params, request }) {
  const input = await request.json();
  const tree = updateTree(params.id, input);

  if (!tree) {
    error(404, 'Tree not found');
  }

  return json({ tree });
}

export function DELETE({ params }) {
  if (!deleteTree(params.id)) {
    error(404, 'Tree not found');
  }

  return new Response(null, { status: 204 });
}
