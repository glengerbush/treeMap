import { json } from '@sveltejs/kit';
import { insertTree, listTrees } from '$lib/server/trees.js';

export function GET() {
  return json({ trees: listTrees() });
}

export async function POST({ request }) {
  const input = await request.json();
  const tree = insertTree(input);

  return json({ tree }, { status: 201 });
}
