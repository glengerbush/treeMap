import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, rowToLayerFeature } from './db.js';

const DEFAULT_LAYER_ID = 'paths-structures';
const ALLOWED_GEOMETRIES = new Set(['LineString', 'Polygon', 'MultiLineString', 'MultiPolygon']);
const ALLOWED_KINDS = new Set(['path', 'structure', 'bed', 'fence', 'driveway', 'water', 'other']);

function cleanText(value, max = 600) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function cleanLayerId(value) {
  return cleanText(value, 80) || DEFAULT_LAYER_ID;
}

function cleanKind(value) {
  const kind = cleanText(value, 40).toLowerCase();
  return ALLOWED_KINDS.has(kind) ? kind : 'other';
}

function cleanCoordinate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 10) / 10;
}

function cleanCoordinates(value) {
  if (!Array.isArray(value)) return [];

  if (typeof value[0] === 'number' && typeof value[1] === 'number') {
    return [cleanCoordinate(value[0]), cleanCoordinate(value[1])];
  }

  return value.map(cleanCoordinates).filter((item) => Array.isArray(item) && item.length > 0);
}

function normalizeGeometry(input) {
  if (!input || typeof input !== 'object' || !ALLOWED_GEOMETRIES.has(input.type)) {
    throw new Error('Expected a LineString, Polygon, MultiLineString, or MultiPolygon geometry.');
  }

  const coordinates = cleanCoordinates(input.coordinates);

  return {
    type: input.type,
    coordinates
  };
}

function normalizeStyle(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return input;
}

export function normalizeLayerFeature(input, existing = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const properties = source.properties && typeof source.properties === 'object' ? source.properties : {};
  const geometry = normalizeGeometry(source.geometry ?? existing.geometry);
  const now = new Date().toISOString();

  return {
    id: cleanText(source.id ?? properties.id, 80) || existing.id || randomUUID(),
    layerId: cleanLayerId(source.layerId ?? properties.layerId ?? existing.layerId),
    name: cleanText(source.name ?? properties.name, 160),
    kind: cleanKind(source.kind ?? properties.kind ?? existing.kind),
    note: cleanText(source.note ?? properties.note, 4000),
    geometry,
    style: normalizeStyle(source.style ?? properties.style ?? existing.style),
    createdAt: existing.createdAt || cleanText(source.createdAt ?? properties.createdAt, 40) || now,
    updatedAt: now
  };
}

function saveFeature(feature) {
  getDb()
    .prepare(
      `INSERT INTO layer_features (
        id, layerId, name, kind, note, geometryJson, styleJson, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        layerId = excluded.layerId,
        name = excluded.name,
        kind = excluded.kind,
        note = excluded.note,
        geometryJson = excluded.geometryJson,
        styleJson = excluded.styleJson,
        updatedAt = excluded.updatedAt`
    )
    .run(
      feature.id,
      feature.layerId,
      feature.name,
      feature.kind,
      feature.note,
      JSON.stringify(feature.geometry),
      JSON.stringify(feature.style),
      feature.createdAt,
      feature.updatedAt
    );

  return feature;
}

function seedLayerFromStatic(layerId) {
  const seeded = getDb()
    .prepare('SELECT layerId FROM layer_seed_state WHERE layerId = ?')
    .get(layerId);

  if (seeded) return;

  const count = getDb()
    .prepare('SELECT COUNT(*) AS count FROM layer_features WHERE layerId = ?')
    .get(layerId).count;

  if (count > 0) {
    getDb()
      .prepare('INSERT INTO layer_seed_state (layerId, seededAt) VALUES (?, ?)')
      .run(layerId, new Date().toISOString());
    return;
  }

  const layerPath = join(process.cwd(), 'static', 'layers', `${layerId}.json`);
  if (!existsSync(layerPath)) {
    getDb()
      .prepare('INSERT INTO layer_seed_state (layerId, seededAt) VALUES (?, ?)')
      .run(layerId, new Date().toISOString());
    return;
  }

  const seedData = JSON.parse(readFileSync(layerPath, 'utf8'));
  if (!Array.isArray(seedData.features) || seedData.features.length === 0) {
    getDb()
      .prepare('INSERT INTO layer_seed_state (layerId, seededAt) VALUES (?, ?)')
      .run(layerId, new Date().toISOString());
    return;
  }

  const db = getDb();
  db.exec('BEGIN');

  try {
    for (const feature of seedData.features) {
      const normalized = normalizeLayerFeature({
        ...feature.properties,
        layerId,
        geometry: feature.geometry
      });
      saveFeature(normalized);
    }

    db.prepare('INSERT INTO layer_seed_state (layerId, seededAt) VALUES (?, ?)').run(
      layerId,
      new Date().toISOString()
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function listLayerFeatures(layerId = DEFAULT_LAYER_ID) {
  const cleanId = cleanLayerId(layerId);
  seedLayerFromStatic(cleanId);

  return getDb()
    .prepare('SELECT * FROM layer_features WHERE layerId = ? ORDER BY kind, name, createdAt')
    .all(cleanId)
    .map(rowToLayerFeature);
}

export function getLayerFeature(id) {
  const row = getDb().prepare('SELECT * FROM layer_features WHERE id = ?').get(id);
  return row ? rowToLayerFeature(row) : null;
}

export function insertLayerFeature(layerId, input) {
  const feature = normalizeLayerFeature({ ...input, layerId: cleanLayerId(layerId) });
  return saveFeature(feature);
}

export function updateLayerFeature(layerId, id, input) {
  const existing = getLayerFeature(id);
  if (!existing || existing.layerId !== cleanLayerId(layerId)) return null;

  const feature = normalizeLayerFeature({ ...input, id, layerId }, existing);
  saveFeature(feature);

  return getLayerFeature(id);
}

export function deleteLayerFeature(layerId, id) {
  return (
    getDb()
      .prepare('DELETE FROM layer_features WHERE id = ? AND layerId = ?')
      .run(id, cleanLayerId(layerId)).changes > 0
  );
}

export function replaceLayerFeatures(layerId, features) {
  const cleanId = cleanLayerId(layerId);
  const db = getDb();

  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM layer_features WHERE layerId = ?').run(cleanId);

    const saved = features.map((feature) => {
      const properties =
        feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};

      return saveFeature(
        normalizeLayerFeature({
          ...feature,
          ...properties,
          layerId: cleanId,
          geometry: feature.geometry
        })
      );
    });

    db.exec('COMMIT');
    return saved;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
