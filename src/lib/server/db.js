import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbPath = join(process.cwd(), 'data', 'treemap.sqlite');
let db;

function init(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS trees (
      id TEXT PRIMARY KEY,
      x REAL NOT NULL,
      y REAL NOT NULL,
      radius REAL NOT NULL DEFAULT 28,
      genus TEXT NOT NULL DEFAULT '',
      species TEXT NOT NULL DEFAULT '',
      variety TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      plantedDate TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Planted',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS trees_status_idx ON trees(status);
    CREATE INDEX IF NOT EXISTS trees_name_idx ON trees(name);

    CREATE TABLE IF NOT EXISTS layer_features (
      id TEXT PRIMARY KEY,
      layerId TEXT NOT NULL DEFAULT 'paths-structures',
      name TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'path',
      note TEXT NOT NULL DEFAULT '',
      geometryJson TEXT NOT NULL,
      styleJson TEXT NOT NULL DEFAULT '{}',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS layer_features_layer_idx ON layer_features(layerId);
    CREATE INDEX IF NOT EXISTS layer_features_kind_idx ON layer_features(kind);

    CREATE TABLE IF NOT EXISTS layer_seed_state (
      layerId TEXT PRIMARY KEY,
      seededAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS map_images (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      originalName TEXT NOT NULL DEFAULT '',
      mimeType TEXT NOT NULL,
      width REAL NOT NULL,
      height REAL NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
}

export function getDb() {
  if (!db) {
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    init(db);
  }

  return db;
}

export function rowToTree(row) {
  return {
    id: row.id,
    x: row.x,
    y: row.y,
    radius: row.radius,
    genus: row.genus,
    species: row.species,
    variety: row.variety,
    name: row.name,
    note: row.note,
    plantedDate: row.plantedDate,
    source: row.source,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function rowToLayerFeature(row) {
  const geometry = JSON.parse(row.geometryJson);
  const style = JSON.parse(row.styleJson || '{}');

  return {
    id: row.id,
    layerId: row.layerId,
    name: row.name,
    kind: row.kind,
    note: row.note,
    geometry,
    style,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}
