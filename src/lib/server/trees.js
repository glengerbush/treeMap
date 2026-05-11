import { randomUUID } from 'node:crypto';
import { getDb, rowToTree } from './db.js';

const STATUSES = new Set(['Planted', 'Planned', 'Flagged']);

function cleanText(value, max = 600) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function cleanNumber(value, fallback, min, max) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, next));
}

function cleanCoordinate(value, fallback) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function cleanDate(value) {
  const text = cleanText(value, 24);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

export function normalizeTree(input, existing = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const now = new Date().toISOString();
  const status = cleanText(source.status, 40);

  return {
    id: cleanText(source.id, 80) || existing.id || randomUUID(),
    x: cleanCoordinate(source.x, existing.x ?? 0),
    y: cleanCoordinate(source.y, existing.y ?? 0),
    radius: cleanNumber(source.radius, existing.radius ?? 28, 6, 240),
    genus: cleanText(source.genus, 120),
    species: cleanText(source.species, 120),
    variety: cleanText(source.variety, 160),
    name: cleanText(source.name, 160),
    note: cleanText(source.note, 4000),
    plantedDate: cleanDate(source.plantedDate),
    source: cleanText(source.source, 240),
    status: STATUSES.has(status) ? status : 'Planted',
    createdAt: existing.createdAt || cleanText(source.createdAt, 40) || now,
    updatedAt: now
  };
}

export function listTrees() {
  return getDb()
    .prepare("SELECT * FROM trees ORDER BY COALESCE(NULLIF(name, ''), genus), createdAt")
    .all()
    .map(rowToTree);
}

export function getTree(id) {
  const row = getDb().prepare('SELECT * FROM trees WHERE id = ?').get(id);
  return row ? rowToTree(row) : null;
}

export function insertTree(input) {
  const tree = normalizeTree(input);
  getDb()
    .prepare(
      `INSERT INTO trees (
        id, x, y, radius, genus, species, variety, name, note,
        plantedDate, source, status, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      tree.id,
      tree.x,
      tree.y,
      tree.radius,
      tree.genus,
      tree.species,
      tree.variety,
      tree.name,
      tree.note,
      tree.plantedDate,
      tree.source,
      tree.status,
      tree.createdAt,
      tree.updatedAt
    );

  return tree;
}

export function updateTree(id, input) {
  const existing = getTree(id);
  if (!existing) return null;

  const tree = normalizeTree({ ...input, id }, existing);
  getDb()
    .prepare(
      `UPDATE trees SET
        x = ?, y = ?, radius = ?, genus = ?, species = ?, variety = ?,
        name = ?, note = ?, plantedDate = ?, source = ?, status = ?, updatedAt = ?
      WHERE id = ?`
    )
    .run(
      tree.x,
      tree.y,
      tree.radius,
      tree.genus,
      tree.species,
      tree.variety,
      tree.name,
      tree.note,
      tree.plantedDate,
      tree.source,
      tree.status,
      tree.updatedAt,
      tree.id
    );

  return getTree(id);
}

export function deleteTree(id) {
  return getDb().prepare('DELETE FROM trees WHERE id = ?').run(id).changes > 0;
}

export function upsertTrees(inputs) {
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO trees (
      id, x, y, radius, genus, species, variety, name, note,
      plantedDate, source, status, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      x = excluded.x,
      y = excluded.y,
      radius = excluded.radius,
      genus = excluded.genus,
      species = excluded.species,
      variety = excluded.variety,
      name = excluded.name,
      note = excluded.note,
      plantedDate = excluded.plantedDate,
      source = excluded.source,
      status = excluded.status,
      updatedAt = excluded.updatedAt`
  );

  db.exec('BEGIN');

  try {
    const trees = inputs.map((input) => {
      const existing = input.id ? getTree(input.id) : null;
      const tree = normalizeTree(input, existing ?? {});
      upsert.run(
        tree.id,
        tree.x,
        tree.y,
        tree.radius,
        tree.genus,
        tree.species,
        tree.variety,
        tree.name,
        tree.note,
        tree.plantedDate,
        tree.source,
        tree.status,
        tree.createdAt,
        tree.updatedAt
      );
      return tree;
    });

    db.exec('COMMIT');
    return trees;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
