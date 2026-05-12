<script>
  import { onMount, untrack } from 'svelte';
  import 'leaflet/dist/leaflet.css';
  import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
  import {
    CirclePlus,
    Download,
    Layers,
    Map as MapIcon,
    Move,
    Pencil,
    Save,
    Search,
    Sprout,
    Trash2,
    Upload,
    X
  } from 'lucide-svelte';
  import { mapConfig } from '$lib/mapConfig.js';

  const defaultMapSize = {
    width: mapConfig.image.width,
    height: mapConfig.image.height
  };
  const editableLayer = mapConfig.vectorLayers[0];
  const treeDraftStorageKey = 'treemap.treeDraft.v1';
  const layerFeatureDraftStorageKey = 'treemap.layerFeatureDraft.v1';
  const statusColors = new Map(mapConfig.statuses.map((status) => [status.value, status.color]));
  const treeEditableFields = [
    'x',
    'y',
    'radius',
    'genus',
    'species',
    'variety',
    'name',
    'note',
    'plantedDate',
    'source',
    'status'
  ];
  const featureEditableFields = ['name', 'kind', 'note'];
  const layerKinds = [
    { value: 'path', label: 'Path' },
    { value: 'structure', label: 'Structure' },
    { value: 'bed', label: 'Bed' },
    { value: 'fence', label: 'Fence' },
    { value: 'driveway', label: 'Driveway' },
    { value: 'water', label: 'Water' },
    { value: 'other', label: 'Other' }
  ];

  let mapElement;
  let importInput = $state();
  let mapImageInput = $state();
  let map;
  let L;
  let imageLayer;
  let vectorLayer;
  let treeLayer;

  let mapImage = $state(null);
  let trees = $state([]);
  let layerFeatures = $state([]);
  let form = $state(emptyTree());
  let layerFeatureForm = $state(emptyLayerFeature());
  let formMode = $state('none');
  let layerFormMode = $state('none');
  let selectedId = $state('');
  let selectedLayerFeatureId = $state('');
  let filter = $state('');
  let showSatellite = $state(true);
  let showPaths = $state(true);
  let layerPanelOpen = $state(true);
  let addMode = $state(false);
  let moveMode = $state(false);
  let layerEditorOpen = $state(false);
  let editToolsOpen = $state(false);
  let layerTool = $state('browse');
  let currentDrawKind = $state('');
  let loading = $state(true);
  let saving = $state(false);
  let layerSaving = $state(false);
  let mapImageSaving = $state(false);
  let mapImageDeleting = $state(false);
  let mapImageButtonHovered = $state(false);
  let mapImageDeleteModifierActive = $state(false);
  let draftsReady = $state(false);
  let errorMessage = $state('');
  let pointerPosition = $state(null);
  let featureFilter = $state('');
  let committingLayerFeatureId = '';
  let storedTreeDrafts = $state.raw(emptyTreeDraftCache());
  let storedLayerFeatureDrafts = $state.raw(emptyLayerFeatureDraftCache());

  let hasForm = $derived(formMode !== 'none');
  let hasLayerFeatureForm = $derived(layerFormMode !== 'none');
  let mapSize = $derived(mapImage ?? defaultMapSize);
  let mapImageBusy = $derived(mapImageSaving || mapImageDeleting);
  let mapImageDeleteMode = $derived(
    Boolean(mapImage && mapImageButtonHovered && mapImageDeleteModifierActive)
  );
  let editToolsExpanded = $derived(editToolsOpen || layerTool === 'edit' || layerTool === 'delete');
  let plantedCount = $derived(
    trees.filter((tree) => ['planted', 'flagged'].includes(String(tree.status).toLowerCase()))
      .length
  );
  let treeFormDirty = $derived.by(() => {
    if (formMode === 'new') return true;
    if (formMode !== 'edit') return false;

    const saved = trees.find((tree) => tree.id === selectedId);
    return saved ? recordSnapshot(form, treeEditableFields) !== recordSnapshot(saved, treeEditableFields) : false;
  });
  let layerFeatureFormDirty = $derived.by(() => {
    if (layerFormMode === 'new') return true;
    if (layerFormMode !== 'edit') return false;

    const saved = layerFeatures.find((feature) => feature.id === selectedLayerFeatureId);
    return saved
      ? recordSnapshot(layerFeatureForm, featureEditableFields) !==
          recordSnapshot(saved, featureEditableFields)
      : false;
  });
  let hasUnsavedTreeChanges = $derived.by(
    () =>
      Boolean(storedTreeDrafts.newDraft) ||
      Object.keys(storedTreeDrafts.byId).length > 0 ||
      treeFormDirty
  );
  let hasUnsavedLayerFeatureChanges = $derived.by(
    () => Object.keys(storedLayerFeatureDrafts.byId).length > 0 || layerFeatureFormDirty
  );
  let filteredTrees = $derived.by(() => {
    const needle = filter.trim().toLowerCase();
    const sorted = [...trees].sort((a, b) => treeTitle(a).localeCompare(treeTitle(b)));

    if (!needle) return sorted;

    return sorted.filter((tree) =>
      [tree.name, tree.genus, tree.species, tree.variety, tree.source, tree.status]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );
  });
  let filteredLayerFeatures = $derived.by(() => {
    const needle = featureFilter.trim().toLowerCase();
    const sorted = [...layerFeatures].sort((a, b) =>
      layerFeatureTitle(a).localeCompare(layerFeatureTitle(b))
    );

    if (!needle) return sorted;

    return sorted.filter((feature) =>
      [
        feature.name,
        feature.kind,
        layerKinds.find((kind) => kind.value === feature.kind)?.label,
        feature.note,
        feature.geometry?.type
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );
  });

  onMount(() => {
    let cancelled = false;

    async function start() {
      try {
        loadDraftCache();
        await loadMapImage();
        if (cancelled) return;
        await initializeMap();
        if (cancelled) return;
        await loadTrees();
        if (cancelled) return;
        restoreLatestDraft();
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : 'The map could not start.';
      } finally {
        loading = false;
      }
    }

    start();

    return () => {
      cancelled = true;
      map?.remove();
    };
  });

  $effect(() => {
    if (!draftsReady || !hasForm || !treeFormDirty) return;
    storeTreeDraftFromCurrent();
  });

  $effect(() => {
    if (!draftsReady || !hasForm || treeFormDirty) return;
    const matchingDraft = formMode === 'new' ? newTreeDraft() : treeDraftForSelection(selectedId);
    if (matchingDraft) {
      clearTreeDraft({ mode: formMode, id: selectedId });
    }
  });

  $effect(() => {
    if (!draftsReady || !hasLayerFeatureForm || !layerFeatureFormDirty) return;
    storeLayerFeatureDraftFromCurrent();
  });

  $effect(() => {
    if (!draftsReady || !hasLayerFeatureForm || layerFeatureFormDirty) return;
    if (layerFeatureDraftForSelection(selectedLayerFeatureId)) {
      clearLayerFeatureDraft(selectedLayerFeatureId);
    }
  });

  function emptyTree(overrides = {}) {
    return {
      id: '',
      x: null,
      y: null,
      radius: 30,
      genus: '',
      species: '',
      variety: '',
      name: '',
      note: '',
      plantedDate: '',
      source: '',
      status: 'Planted',
      ...overrides
    };
  }

  function emptyLayerFeature(overrides = {}) {
    return {
      id: '',
      layerId: editableLayer.id,
      name: '',
      kind: 'path',
      note: '',
      geometry: null,
      style: {},
      ...overrides
    };
  }

  function emptyTreeDraftCache() {
    return { newDraft: null, byId: {} };
  }

  function emptyLayerFeatureDraftCache() {
    return { byId: {} };
  }

  function classes(...items) {
    return items.filter(Boolean).join(' ');
  }

  function recordSnapshot(source, fields) {
    return JSON.stringify(Object.fromEntries(fields.map((field) => [field, source?.[field] ?? ''])));
  }

  function safeReadJson(key) {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null');
    } catch {
      localStorage.removeItem(key);
      return null;
    }
  }

  function loadDraftCache() {
    storedTreeDrafts = normalizeTreeDraftCache(safeReadJson(treeDraftStorageKey));
    storedLayerFeatureDrafts = normalizeLayerFeatureDraftCache(
      safeReadJson(layerFeatureDraftStorageKey)
    );
    draftsReady = true;
  }

  function writeDraft(key, draft) {
    localStorage.setItem(key, JSON.stringify(draft));
  }

  function normalizeDraftMap(source, normalizeDraft) {
    if (!source || typeof source !== 'object') return {};

    return Object.fromEntries(
      Object.entries(source)
        .map(([id, draft]) => [id, normalizeDraft(draft)])
        .filter(([id, draft]) => id && draft)
    );
  }

  function normalizeTreeDraft(draft) {
    if (!draft?.form) return null;

    const formMode = draft.formMode === 'new' ? 'new' : 'edit';
    const selectedId = formMode === 'new' ? '' : String(draft.selectedId || draft.form.id || '');

    if (formMode === 'edit' && !selectedId) return null;

    return {
      ...draft,
      formMode,
      selectedId,
      form: treeDraftForm(draft.form),
      updatedAt: Number(draft.updatedAt) || 0
    };
  }

  function normalizeLayerFeatureDraft(draft) {
    if (!draft?.form) return null;

    const selectedLayerFeatureId = String(draft.selectedLayerFeatureId || draft.form.id || '');
    if (!selectedLayerFeatureId) return null;

    return {
      ...draft,
      layerFormMode: draft.layerFormMode === 'new' ? 'new' : 'edit',
      selectedLayerFeatureId,
      form: layerFeatureDraftForm(draft.form),
      updatedAt: Number(draft.updatedAt) || 0
    };
  }

  function normalizeTreeDraftCache(value) {
    if (!value || typeof value !== 'object') return emptyTreeDraftCache();

    if ('newDraft' in value || 'byId' in value) {
      return {
        newDraft: normalizeTreeDraft(value.newDraft),
        byId: normalizeDraftMap(value.byId, normalizeTreeDraft)
      };
    }

    const legacyDraft = normalizeTreeDraft(value);
    if (!legacyDraft) return emptyTreeDraftCache();

    return legacyDraft.formMode === 'new'
      ? { newDraft: legacyDraft, byId: {} }
      : { newDraft: null, byId: { [legacyDraft.selectedId]: legacyDraft } };
  }

  function normalizeLayerFeatureDraftCache(value) {
    if (!value || typeof value !== 'object') return emptyLayerFeatureDraftCache();

    if ('byId' in value) {
      return {
        byId: normalizeDraftMap(value.byId, normalizeLayerFeatureDraft)
      };
    }

    const legacyDraft = normalizeLayerFeatureDraft(value);
    if (!legacyDraft) return emptyLayerFeatureDraftCache();

    return { byId: { [legacyDraft.selectedLayerFeatureId]: legacyDraft } };
  }

  function treeDraftsExist(cache) {
    return Boolean(cache.newDraft) || Object.keys(cache.byId).length > 0;
  }

  function layerFeatureDraftsExist(cache) {
    return Object.keys(cache.byId).length > 0;
  }

  function persistTreeDrafts(cache) {
    storedTreeDrafts = cache;

    if (treeDraftsExist(cache)) {
      writeDraft(treeDraftStorageKey, cache);
    } else {
      localStorage.removeItem(treeDraftStorageKey);
    }
  }

  function persistLayerFeatureDrafts(cache) {
    storedLayerFeatureDrafts = cache;

    if (layerFeatureDraftsExist(cache)) {
      writeDraft(layerFeatureDraftStorageKey, cache);
    } else {
      localStorage.removeItem(layerFeatureDraftStorageKey);
    }
  }

  function clearTreeDraft(options = {}) {
    const mode = options.mode ?? formMode;
    const id = options.id ?? selectedId;
    const cache = untrack(() => storedTreeDrafts);
    const byId = { ...cache.byId };
    let newDraft = cache.newDraft;

    if (mode === 'new') {
      newDraft = null;
    } else if (id) {
      delete byId[id];
    }

    persistTreeDrafts({ newDraft, byId });
  }

  function clearLayerFeatureDraft(id = selectedLayerFeatureId) {
    if (!id) return;

    const cache = untrack(() => storedLayerFeatureDrafts);
    const byId = { ...cache.byId };
    delete byId[id];
    persistLayerFeatureDrafts({ byId });
  }

  function pruneTreeDrafts() {
    const savedTreeIds = new Set(trees.map((tree) => tree.id));
    const byId = Object.fromEntries(
      Object.entries(storedTreeDrafts.byId).filter(([id]) => savedTreeIds.has(id))
    );

    if (Object.keys(byId).length !== Object.keys(storedTreeDrafts.byId).length) {
      persistTreeDrafts({ newDraft: storedTreeDrafts.newDraft, byId });
    }
  }

  function pruneLayerFeatureDrafts() {
    const savedFeatureIds = new Set(layerFeatures.map((feature) => feature.id));
    const byId = Object.fromEntries(
      Object.entries(storedLayerFeatureDrafts.byId).filter(([id]) => savedFeatureIds.has(id))
    );

    if (Object.keys(byId).length !== Object.keys(storedLayerFeatureDrafts.byId).length) {
      persistLayerFeatureDrafts({ byId });
    }
  }

  function treeDraftForm(source) {
    return {
      id: source.id ?? '',
      x: source.x,
      y: source.y,
      radius: source.radius,
      genus: source.genus ?? '',
      species: source.species ?? '',
      variety: source.variety ?? '',
      name: source.name ?? '',
      note: source.note ?? '',
      plantedDate: source.plantedDate ?? '',
      source: source.source ?? '',
      status: source.status ?? 'Planted'
    };
  }

  function layerFeatureDraftForm(source) {
    return {
      id: source.id ?? '',
      layerId: source.layerId ?? editableLayer.id,
      name: source.name ?? '',
      kind: source.kind ?? 'other',
      note: source.note ?? '',
      geometry: source.geometry ?? null,
      style: source.style ?? {}
    };
  }

  function storeTreeDraftFromCurrent() {
    if (!hasForm || !treeFormDirty) return;
    if (formMode === 'edit' && !selectedId) return;

    const draft = {
      formMode,
      selectedId,
      form: treeDraftForm(form),
      updatedAt: Date.now()
    };

    const cache = untrack(() => storedTreeDrafts);
    const nextCache =
      formMode === 'new'
        ? { newDraft: draft, byId: { ...cache.byId } }
        : {
            newDraft: cache.newDraft,
            byId: { ...cache.byId, [selectedId]: draft }
          };

    persistTreeDrafts(nextCache);
  }

  function storeLayerFeatureDraftFromCurrent() {
    if (!hasLayerFeatureForm || !layerFeatureFormDirty || !selectedLayerFeatureId) return;

    const draft = {
      layerFormMode,
      selectedLayerFeatureId,
      form: layerFeatureDraftForm(layerFeatureForm),
      updatedAt: Date.now()
    };

    const cache = untrack(() => storedLayerFeatureDrafts);
    persistLayerFeatureDrafts({
      byId: {
        ...cache.byId,
        [selectedLayerFeatureId]: draft
      }
    });
  }

  function treeDraftForSelection(id) {
    return id ? storedTreeDrafts.byId[id] ?? null : null;
  }

  function newTreeDraft() {
    return storedTreeDrafts.newDraft;
  }

  function layerFeatureDraftForSelection(id) {
    return id ? storedLayerFeatureDrafts.byId[id] ?? null : null;
  }

  function treeHasUnsavedDraft(id) {
    return Boolean(treeDraftForSelection(id));
  }

  function layerFeatureHasUnsavedDraft(id) {
    return Boolean(layerFeatureDraftForSelection(id));
  }

  function latestTreeDraft() {
    return [storedTreeDrafts.newDraft, ...Object.values(storedTreeDrafts.byId)]
      .filter(Boolean)
      .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))[0];
  }

  function latestLayerFeatureDraft() {
    return Object.values(storedLayerFeatureDrafts.byId)
      .filter(Boolean)
      .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))[0];
  }

  function restoreLatestDraft() {
    const treeDraft = latestTreeDraft();
    const featureDraft = latestLayerFeatureDraft();
    const treeUpdatedAt = Number(treeDraft?.updatedAt ?? 0);
    const featureUpdatedAt = Number(featureDraft?.updatedAt ?? 0);

    if (featureUpdatedAt > treeUpdatedAt) {
      if (!restoreLayerFeatureDraft(featureDraft)) restoreTreeDraft(treeDraft);
      return;
    }

    if (!restoreTreeDraft(treeDraft)) restoreLayerFeatureDraft(featureDraft);
  }

  function restoreTreeDraft(draft = latestTreeDraft()) {
    if (!draft?.form) return false;

    const draftMode = draft.formMode === 'new' ? 'new' : 'edit';
    const savedTree =
      draftMode === 'edit' ? trees.find((tree) => tree.id === draft.selectedId) : null;

    if (draftMode === 'edit' && !savedTree) {
      clearTreeDraft({ mode: 'edit', id: draft.selectedId });
      return false;
    }

    layerEditorOpen = false;
    selectedLayerFeatureId = '';
    layerFormMode = 'none';
    layerFeatureForm = emptyLayerFeature();
    selectedId = draftMode === 'edit' ? draft.selectedId : '';
    formMode = draftMode;
    form = {
      ...(draftMode === 'edit' ? savedTree : emptyTree()),
      ...draft.form
    };
    addMode = false;
    moveMode = false;
    renderTrees();
    return true;
  }

  function restoreLayerFeatureDraft(draft = latestLayerFeatureDraft()) {
    if (!draft?.form) return false;

    const feature = layerFeatures.find((item) => item.id === draft.selectedLayerFeatureId);
    if (!feature) {
      clearLayerFeatureDraft(draft.selectedLayerFeatureId);
      return false;
    }

    layerEditorOpen = true;
    addMode = false;
    moveMode = false;
    formMode = 'none';
    selectedId = '';
    form = emptyTree();
    selectedLayerFeatureId = draft.selectedLayerFeatureId;
    layerFormMode = draft.layerFormMode === 'new' ? 'new' : 'edit';
    layerFeatureForm = {
      ...feature,
      ...draft.form,
      id: feature.id,
      layerId: feature.layerId,
      geometry: feature.geometry
    };
    renderTrees();
    refreshVectorStyles();
    return true;
  }

  function getTreeColor(status) {
    return statusColors.get(status) ?? '#2f7d45';
  }

  function treeTitle(tree) {
    return tree.name || [tree.genus, tree.species].filter(Boolean).join(' ') || 'Unnamed tree';
  }

  function treeSubtitle(tree) {
    const botanical = [tree.genus, tree.species, tree.variety].filter(Boolean).join(' ');
    return [botanical, tree.status].filter(Boolean).join(' · ');
  }

  function formTitle() {
    return treeTitle(form);
  }

  function layerFeatureTitle(feature) {
    return feature.name || layerKinds.find((kind) => kind.value === feature.kind)?.label || 'Map feature';
  }

  function layerFeatureSubtitle(feature) {
    const geometryType = feature.geometry?.type || 'Geometry';
    return `${layerKinds.find((kind) => kind.value === feature.kind)?.label || feature.kind} · ${geometryType}`;
  }

  function withSelectedDraft(tree) {
    if (formMode === 'edit' && tree.id === selectedId) {
      return { ...tree, ...form, id: tree.id };
    }

    const draft = treeDraftForSelection(tree.id);
    return draft?.form ? { ...tree, ...draft.form, id: tree.id } : tree;
  }

  function normalizeMapImage(image) {
    if (!image?.url) return null;

    return {
      ...image,
      width: Number(image.width) || defaultMapSize.width,
      height: Number(image.height) || defaultMapSize.height,
      name: image.name || 'Satellite'
    };
  }

  function imageBounds(image = mapSize) {
    return [
      [0, 0],
      [image.height, image.width]
    ];
  }

  function applyMapImage(image, options = {}) {
    const normalizedImage = normalizeMapImage(image);
    const nextBounds = imageBounds(normalizedImage ?? defaultMapSize);

    mapImage = normalizedImage;
    showSatellite = Boolean(normalizedImage);

    if (!map) return;

    if (normalizedImage?.url) {
      if (imageLayer) {
        imageLayer.setUrl(normalizedImage.url);
        imageLayer.setBounds(nextBounds);
      } else if (L) {
        imageLayer = L.imageOverlay(normalizedImage.url, nextBounds, {
          opacity: 1,
          interactive: false,
          pmIgnore: true
        });
      }
    } else {
      imageLayer?.remove();
      imageLayer = null;
    }

    if (options.fit) {
      map.fitBounds(nextBounds);
    }

    syncImageLayer();
    renderTrees();
  }

  async function loadMapImage() {
    const response = await fetch('/api/map-image', { cache: 'no-store' });

    if (!response.ok) throw new Error('The satellite photo settings could not be loaded.');

    const payload = await response.json();
    mapImage = normalizeMapImage(payload.image);
    showSatellite = Boolean(mapImage);
  }

  async function initializeMap() {
    const leaflet = await import('leaflet');
    await import('@geoman-io/leaflet-geoman-free');
    L = leaflet.default ?? leaflet;
    const initialBounds = imageBounds();

    map = L.map(mapElement, {
      crs: L.CRS.Simple,
      minZoom: -3,
      maxZoom: 4,
      zoomSnap: 0.25,
      wheelPxPerZoomLevel: 90,
      zoomControl: false,
      attributionControl: false
    });

    if (mapImage?.url) {
      imageLayer = L.imageOverlay(mapImage.url, initialBounds, {
        opacity: 1,
        interactive: false,
        pmIgnore: true
      });
    }

    vectorLayer = L.geoJSON(null, {
      style: vectorStyle,
      pointToLayer: (_feature, latlng) =>
        L.circleMarker(latlng, {
          radius: 7,
          weight: 2,
          color: '#355c4b',
          fillColor: '#f4b860',
          fillOpacity: 0.8
        }),
      onEachFeature: (feature, layer) => {
        const name = feature.properties?.name;
        if (name) layer.bindTooltip(name, { direction: 'top', sticky: true });
        layer.on('click', (event) => {
          event.originalEvent?.stopPropagation();
          if (moveMode && hasForm) {
            moveTreeToLatLng(event.latlng);
            return;
          }
          selectLayerFeature(feature.properties?.id);
        });
        layer.on('pm:update', () => saveLayerGeometry(layer));
      }
    });

    treeLayer = L.layerGroup().addTo(map);
    map.pm.setGlobalOptions({
      layerGroup: vectorLayer,
      snappable: false,
      finishOnEnter: true,
      exitModeOnEscape: true
    });
    syncImageLayer();
    syncVectorLayer();
    map.fitBounds(initialBounds);
    map.on('click', handleMapClick);
    map.on('mousemove', handlePointerMove);
    map.on('pm:create', handleLayerCreated);
    map.on('pm:remove', handleLayerRemoved);
    map.on('zoomend', renderTrees);

    await loadVectorLayer();
  }

  function vectorStyle(feature) {
    const kind = feature.properties?.kind;
    const isSelected = feature.properties?.id && feature.properties.id === selectedLayerFeatureId;

    if (kind === 'structure') {
      return {
        color: '#38423b',
        weight: isSelected ? 4 : 2,
        fillColor: '#d6b98d',
        fillOpacity: isSelected ? 0.46 : 0.32
      };
    }

    if (kind === 'bed') {
      return {
        color: '#355c4b',
        weight: isSelected ? 4 : 2,
        fillColor: '#9dc7a4',
        fillOpacity: isSelected ? 0.42 : 0.28
      };
    }

    if (kind === 'driveway') {
      return {
        color: '#6f7370',
        weight: isSelected ? 4 : 2,
        fillColor: '#d4d7d3',
        fillOpacity: isSelected ? 0.5 : 0.34
      };
    }

    if (kind === 'water') {
      return {
        color: '#2f6f95',
        weight: isSelected ? 4 : 2,
        fillColor: '#b8d8e8',
        fillOpacity: isSelected ? 0.48 : 0.32
      };
    }

    if (kind === 'path' || kind === 'fence') {
      const style = {
        color: kind === 'fence' ? '#576154' : '#e6a33f',
        weight: isSelected ? 8 : 5,
        opacity: 0.9,
        lineCap: 'round',
        lineJoin: 'round'
      };

      if (kind === 'fence') {
        style.dashArray = '10 7';
      }

      return style;
    }

    return {
      color: '#355c4b',
      weight: isSelected ? 5 : 3,
      fillColor: '#9dc7a4',
      fillOpacity: isSelected ? 0.3 : 0.18
    };
  }

  async function loadVectorLayer() {
    if (!vectorLayer) return;

    try {
      const response = await fetch(`/api/layers/${editableLayer.id}/features`, { cache: 'no-store' });

      if (!response.ok) throw new Error('The paths layer could not be loaded.');

      const payload = await response.json();
      layerFeatures = payload.features ?? [];
      pruneLayerFeatureDrafts();
      vectorLayer.clearLayers();
      vectorLayer.addData(layerFeaturesToMapData(layerFeatures));
      syncVectorLayer();
      refreshVectorStyles();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'The paths layer could not be loaded.';
    }
  }

  async function loadTrees() {
    const response = await fetch('/api/trees');

    if (!response.ok) throw new Error('The tree records could not be loaded.');

    const payload = await response.json();
    trees = payload.trees;
    pruneTreeDrafts();
    renderTrees();
  }

  function syncImageLayer() {
    if (!map || !imageLayer) return;

    if (showSatellite && mapImage?.url) {
      imageLayer.addTo(map);
    } else {
      imageLayer.remove();
    }
  }

  function syncVectorLayer() {
    if (!map || !vectorLayer) return;

    if (showPaths) {
      vectorLayer.addTo(map);
    } else {
      vectorLayer.remove();
    }
  }

  function refreshVectorStyles() {
    if (!vectorLayer) return;

    vectorLayer.eachLayer((layer) => {
      if (layer.setStyle && layer.feature) {
        layer.setStyle(vectorStyle(layer.feature));
      }

      if (layer.feature?.properties?.id === selectedLayerFeatureId) {
        layer.bringToFront?.();
      }
    });
  }

  function openLayerEditor(options = {}) {
    storeTreeDraftFromCurrent();
    layerEditorOpen = true;
    addMode = false;
    moveMode = false;
    formMode = 'none';
    selectedId = '';
    form = emptyTree();
    renderTrees();

    if (options.restoreDraft !== false) {
      restoreLayerFeatureDraft();
    }
  }

  function closeLayerEditor(options = {}) {
    storeLayerFeatureDraftFromCurrent();
    stopLayerTools();
    editToolsOpen = false;
    layerEditorOpen = false;
    selectedLayerFeatureId = '';
    layerFormMode = 'none';
    layerFeatureForm = emptyLayerFeature();
    refreshVectorStyles();

    if (options.restoreDraft !== false) {
      restoreTreeDraft();
    }
  }

  function stopLayerTools() {
    map?.pm?.disableDraw();
    map?.pm?.disableGlobalEditMode();
    map?.pm?.disableGlobalRemovalMode();
    layerTool = 'browse';
    currentDrawKind = '';
  }

  function startLayerDraw(kind) {
    if (!map?.pm) return;

    storeLayerFeatureDraftFromCurrent();
    editToolsOpen = false;
    openLayerEditor({ restoreDraft: false });
    stopLayerTools();
    showPaths = true;
    syncVectorLayer();
    selectedLayerFeatureId = '';
    layerFormMode = 'none';
    layerFeatureForm = emptyLayerFeature();
    currentDrawKind = kind;
    layerTool = kind === 'path' ? 'draw-path' : 'draw-area';

    map.pm.enableDraw(kind === 'path' ? 'Line' : 'Polygon', {
      snappable: false,
      finishOnEnter: true,
      continueDrawing: false,
      allowSelfIntersection: false,
      pathOptions: vectorStyle({ properties: { kind } }),
      templineStyle: { color: '#2f7d45', weight: 3 },
      hintlineStyle: { color: '#2f7d45', dashArray: '6 6', weight: 2 }
    });
  }

  function toggleLayerEditMode() {
    if (!map?.pm) return;

    openLayerEditor({ restoreDraft: false });

    if (layerTool === 'edit') {
      stopLayerTools();
      return;
    }

    stopLayerTools();
    layerTool = 'edit';
    map.pm.enableGlobalEditMode({
      snappable: false,
      allowSelfIntersection: false,
      removeLayerBelowMinVertexCount: false
    });
  }

  function toggleLayerDeleteMode() {
    if (!map?.pm) return;

    openLayerEditor({ restoreDraft: false });

    if (layerTool === 'delete') {
      stopLayerTools();
      return;
    }

    stopLayerTools();
    layerTool = 'delete';
    map.pm.enableGlobalRemovalMode();
  }

  function toggleEditTools() {
    if (editToolsExpanded) {
      stopLayerTools();
      editToolsOpen = false;
      return;
    }

    editToolsOpen = true;
  }

  function layerIdFromLeafletLayer(layer) {
    return layer?.feature?.properties?.id || '';
  }

  function findLayerByFeatureId(id) {
    if (!vectorLayer) return null;

    let foundLayer = null;

    vectorLayer.eachLayer((layer) => {
      if (!foundLayer && layerIdFromLeafletLayer(layer) === id) {
        foundLayer = layer;
      }
    });

    return foundLayer;
  }

  function roundCoordinate(value) {
    return Math.round(Number(value) * 10) / 10;
  }

  function roundCoordinates(value) {
    if (!Array.isArray(value)) return [];

    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      return [roundCoordinate(value[0]), roundCoordinate(value[1])];
    }

    return value.map(roundCoordinates);
  }

  function geometryFromLayer(layer) {
    const mapFeature = layer.toGeoJSON();
    return {
      type: mapFeature.geometry.type,
      coordinates: roundCoordinates(mapFeature.geometry.coordinates)
    };
  }

  async function handleLayerCreated(event) {
    if (!currentDrawKind) return;

    layerSaving = true;
    errorMessage = '';

    try {
      const response = await fetch(`/api/layers/${editableLayer.id}/features`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: currentDrawKind,
          geometry: geometryFromLayer(event.layer)
        })
      });

      if (!response.ok) throw new Error('The new map feature could not be saved.');

      const payload = await response.json();
      const saved = payload.feature;
      currentDrawKind = '';
      layerTool = 'browse';
      await loadVectorLayer();
      selectLayerFeature(saved.id, { mode: 'new' });
    } catch (error) {
      event.layer?.remove?.();
      errorMessage =
        error instanceof Error ? error.message : 'The new map feature could not be saved.';
    } finally {
      layerSaving = false;
    }
  }

  async function saveLayerGeometry(layer) {
    const id = layerIdFromLeafletLayer(layer);
    if (!id) return;
    if (id === committingLayerFeatureId) return;

    const existing = layerFeatures.find((feature) => feature.id === id);
    if (!existing) return;

    layerSaving = true;
    errorMessage = '';

    try {
      const response = await fetch(`/api/layers/${editableLayer.id}/features/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...existing,
          geometry: geometryFromLayer(layer)
        })
      });

      if (!response.ok) throw new Error('The map feature geometry could not be saved.');

      const payload = await response.json();
      const saved = payload.feature;
      layerFeatures = layerFeatures.map((feature) => (feature.id === id ? saved : feature));

      if (selectedLayerFeatureId === id) {
        layerFeatureForm = { ...saved };
      }
    } catch (error) {
      errorMessage =
        error instanceof Error ? error.message : 'The map feature geometry could not be saved.';
    } finally {
      layerSaving = false;
    }
  }

  async function handleLayerRemoved(event) {
    const id = layerIdFromLeafletLayer(event.layer);
    if (!id) return;

    layerSaving = true;
    errorMessage = '';

    try {
      const response = await fetch(`/api/layers/${editableLayer.id}/features/${id}`, {
        method: 'DELETE'
      });

      if (!response.ok) throw new Error('The map feature could not be deleted.');

      layerFeatures = layerFeatures.filter((feature) => feature.id !== id);
      clearLayerFeatureDraft(id);

      if (selectedLayerFeatureId === id) {
        selectedLayerFeatureId = '';
        layerFormMode = 'none';
        layerFeatureForm = emptyLayerFeature();
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'The map feature could not be deleted.';
      await loadVectorLayer();
    } finally {
      layerSaving = false;
    }
  }

  function selectLayerFeature(id, options = {}) {
    if (!id || layerTool === 'delete') return;

    const feature = layerFeatures.find((item) => item.id === id);
    if (!feature) return;

    storeLayerFeatureDraftFromCurrent();
    openLayerEditor({ restoreDraft: false });
    const draft = layerFeatureDraftForSelection(id);

    selectedLayerFeatureId = id;
    layerFormMode = options.mode ?? draft?.layerFormMode ?? 'edit';
    layerFeatureForm = {
      ...feature,
      ...(draft?.form ?? {}),
      id: feature.id,
      layerId: feature.layerId,
      geometry: feature.geometry
    };
    refreshVectorStyles();
  }

  function closeLayerFeatureForm() {
    storeLayerFeatureDraftFromCurrent();
    selectedLayerFeatureId = '';
    layerFormMode = 'none';
    layerFeatureForm = emptyLayerFeature();
    refreshVectorStyles();
  }

  async function saveLayerFeatureMetadata() {
    if (!selectedLayerFeatureId) return;

    layerSaving = true;
    errorMessage = '';
    committingLayerFeatureId = selectedLayerFeatureId;

    try {
      const liveLayer = findLayerByFeatureId(selectedLayerFeatureId);
      const requestPayload = liveLayer
        ? { ...layerFeatureForm, geometry: geometryFromLayer(liveLayer) }
        : layerFeatureForm;

      if (map?.pm?.globalEditModeEnabled?.()) {
        map.pm.disableGlobalEditMode();
        layerTool = 'browse';
      }

      const response = await fetch(
        `/api/layers/${editableLayer.id}/features/${selectedLayerFeatureId}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(requestPayload)
        }
      );

      if (!response.ok) throw new Error('The map feature could not be saved.');

      const payload = await response.json();
      const saved = payload.feature;
      layerFeatures = layerFeatures.map((feature) =>
        feature.id === selectedLayerFeatureId ? saved : feature
      );
      layerFeatureForm = { ...saved };
      selectedLayerFeatureId = saved.id;
      layerFormMode = 'edit';
      clearLayerFeatureDraft(saved.id);
      await loadVectorLayer();
      selectLayerFeature(saved.id);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'The map feature could not be saved.';
    } finally {
      committingLayerFeatureId = '';
      layerSaving = false;
    }
  }

  async function deleteSelectedLayerFeature() {
    if (!selectedLayerFeatureId || !confirm(`Delete ${layerFeatureTitle(layerFeatureForm)}?`)) return;

    layerSaving = true;
    errorMessage = '';

    try {
      const response = await fetch(
        `/api/layers/${editableLayer.id}/features/${selectedLayerFeatureId}`,
        { method: 'DELETE' }
      );

      if (!response.ok) throw new Error('The map feature could not be deleted.');

      clearLayerFeatureDraft(selectedLayerFeatureId);
      selectedLayerFeatureId = '';
      layerFormMode = 'none';
      layerFeatureForm = emptyLayerFeature();
      await loadVectorLayer();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'The map feature could not be deleted.';
    } finally {
      layerSaving = false;
    }
  }

  function renderTrees() {
    if (!L || !treeLayer) return;

    treeLayer.clearLayers();

    for (const tree of trees.map(withSelectedDraft)) {
      addTreeCircle(tree, false);
    }

    if (formMode === 'new' && Number.isFinite(form.x) && Number.isFinite(form.y)) {
      addTreeCircle({ ...form, id: 'draft-tree' }, true);
    }
  }

  function addTreeCircle(tree, isDraft) {
    const isSelected = isDraft || tree.id === selectedId;
    const color = getTreeColor(tree.status);
    const outerWeight = isSelected ? 4 : 2;
    const circle = L.circle([tree.y, tree.x], {
      radius: tree.radius,
      pmIgnore: true,
      color,
      weight: outerWeight,
      opacity: 0.95,
      fillColor: color,
      fillOpacity: 0.3
    });

    circle.bindTooltip(treeTitle(tree), { direction: 'top', sticky: true });
    circle.on('click', (event) => {
      event.originalEvent?.stopPropagation();
      if (moveMode && hasForm) {
        moveTreeToLatLng(event.latlng);
        return;
      }
      if (layerTool === 'delete' && !isDraft) {
        deleteTreeById(tree.id, { confirmDelete: false });
        return;
      }
      if (!isDraft) editTree(tree.id);
    });
    circle.addTo(treeLayer);

    // Thin white highlight ring inside the colored border, for legibility over
    // green imagery. CRS.Simple: 1 map unit == 2^zoom CSS pixels.
    const pxPerUnit = Math.pow(2, map.getZoom());
    const innerRadius = tree.radius - (outerWeight / 2 + 1) / pxPerUnit;
    if (innerRadius > 0) {
      L.circle([tree.y, tree.x], {
        radius: innerRadius,
        pmIgnore: true,
        interactive: false,
        color: '#ffffff',
        weight: 1,
        opacity: 0.9,
        fill: false
      }).addTo(treeLayer);
    }
  }

  function moveTreeToLatLng(latlng) {
    const x = roundTreeCoordinate(latlng.lng, form.x ?? 0);
    const y = roundTreeCoordinate(latlng.lat, form.y ?? 0);
    pointerPosition = { x, y };
    form.x = x;
    form.y = y;
    moveMode = false;
    renderTrees();
  }

  function handleMapClick(event) {
    const x = roundTreeCoordinate(event.latlng.lng, 0);
    const y = roundTreeCoordinate(event.latlng.lat, 0);
    pointerPosition = { x, y };

    if (moveMode && hasForm) {
      moveTreeToLatLng(event.latlng);
      return;
    }

    if (addMode) {
      form = emptyTree({ x, y });
      formMode = 'new';
      selectedId = '';
      addMode = false;
      moveMode = false;
      renderTrees();
    }
  }

  function handlePointerMove(event) {
    pointerPosition = {
      x: roundTreeCoordinate(event.latlng.lng, 0),
      y: roundTreeCoordinate(event.latlng.lat, 0)
    };
  }

  function beginAdd() {
    storeTreeDraftFromCurrent();
    closeLayerEditor({ restoreDraft: false });
    const draft = newTreeDraft();

    if (draft?.form) {
      addMode = false;
      moveMode = false;
      formMode = 'new';
      selectedId = '';
      form = { ...emptyTree(), ...draft.form };
      renderTrees();
      return;
    }

    addMode = true;
    moveMode = false;
    formMode = 'none';
    selectedId = '';
    form = emptyTree();
    renderTrees();
  }

  function editTree(id) {
    const tree = trees.find((item) => item.id === id);
    if (!tree) return;

    storeTreeDraftFromCurrent();
    closeLayerEditor({ restoreDraft: false });
    const draft = treeDraftForSelection(id);

    selectedId = id;
    formMode = 'edit';
    addMode = false;
    moveMode = false;
    form = { ...tree, ...(draft?.form ?? {}), id: tree.id };
    renderTrees();
  }

  function closeForm(options = {}) {
    if (options.persistDraft !== false) {
      storeTreeDraftFromCurrent();
    }
    formMode = 'none';
    selectedId = '';
    addMode = false;
    moveMode = false;
    form = emptyTree();
    renderTrees();
  }

  async function saveTree() {
    if (!hasForm) return;

    saving = true;
    errorMessage = '';

    try {
      const isEdit = formMode === 'edit';
      const response = await fetch(isEdit ? `/api/trees/${selectedId}` : '/api/trees', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form)
      });

      if (!response.ok) throw new Error('The tree could not be saved.');

      const payload = await response.json();
      const saved = payload.tree;
      const draftToClear = { mode: isEdit ? 'edit' : 'new', id: isEdit ? selectedId : '' };

      if (isEdit) {
        trees = trees.map((tree) => (tree.id === saved.id ? saved : tree));
      } else {
        trees = [...trees, saved];
      }

      clearTreeDraft(draftToClear);
      selectedId = saved.id;
      formMode = 'edit';
      form = { ...saved };
      renderTrees();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'The tree could not be saved.';
    } finally {
      saving = false;
    }
  }

  async function deleteCurrentTree() {
    if (formMode === 'new') {
      clearTreeDraft({ mode: 'new' });
      closeForm({ persistDraft: false });
      return;
    }

    if (selectedId) {
      await deleteTreeById(selectedId, { confirmDelete: true });
    }
  }

  async function deleteTreeById(id, options = {}) {
    const tree = trees.find((item) => item.id === id);
    if (!tree) return;

    if (options.confirmDelete !== false && !confirm(`Delete ${treeTitle(tree)}?`)) return;

    saving = true;
    errorMessage = '';

    try {
      const response = await fetch(`/api/trees/${id}`, { method: 'DELETE' });

      if (!response.ok) throw new Error('The tree could not be deleted.');

      trees = trees.filter((tree) => tree.id !== id);
      clearTreeDraft({ mode: 'edit', id });

      if (selectedId === id) {
        formMode = 'none';
        selectedId = '';
        moveMode = false;
        form = emptyTree();
      }

      renderTrees();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'The tree could not be deleted.';
    } finally {
      saving = false;
    }
  }

  function toggleMove() {
    if (!hasForm) return;
    moveMode = !moveMode;
    addMode = false;
  }

  function onFieldChange() {
    renderTrees();
  }

  function clampNumber(value, min, max, fallback) {
    const next = Number(value);
    if (!Number.isFinite(next)) return fallback;
    return Math.min(max, Math.max(min, next));
  }

  function finiteNumber(value, fallback) {
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
  }

  function roundTreeCoordinate(value, fallback) {
    const next = finiteNumber(value, fallback);
    return Math.round(next);
  }

  function updateTreeNumberField(field, value, min, max, fallback) {
    form[field] = clampNumber(value, min, max, fallback);
    renderTrees();
  }

  function updateTreeCoordinateField(field, value, fallback) {
    form[field] = finiteNumber(value, fallback);
    renderTrees();
  }

  function preventNumberWheel(event) {
    event.currentTarget.blur();
  }

  function downloadFile(filename, content, type = 'application/json') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function layerFeaturesToMapData(features) {
    return {
      type: 'FeatureCollection',
      name: editableLayer.name,
      features: features.map((feature) => ({
        type: 'Feature',
        properties: {
          id: feature.id,
          layerId: feature.layerId,
          name: feature.name,
          kind: feature.kind,
          note: feature.note,
          style: feature.style,
          createdAt: feature.createdAt,
          updatedAt: feature.updatedAt
        },
        geometry: feature.geometry
      }))
    };
  }

  function exportInventory() {
    downloadFile(
      'treemap-inventory.json',
      JSON.stringify(
        {
          version: 1,
          exportedAt: new Date().toISOString(),
          map: {
            imageWidth: mapSize.width,
            imageHeight: mapSize.height
          },
          layer: {
            id: editableLayer.id,
            name: editableLayer.name
          },
          trees,
          features: layerFeatures
        },
        null,
        2
      )
    );
  }

  function updateMapImageDeleteModifier(event) {
    if (!mapImageButtonHovered) return;

    mapImageDeleteModifierActive = Boolean(event.ctrlKey || event.shiftKey);
  }

  function enterMapImageButton(event) {
    mapImageButtonHovered = true;
    mapImageDeleteModifierActive = Boolean(event.ctrlKey || event.shiftKey);
  }

  function clearMapImageDeleteModifier() {
    mapImageButtonHovered = false;
    mapImageDeleteModifierActive = false;
  }

  function mapImageActionLabel() {
    if (mapImageDeleting) return 'Deleting';
    if (mapImageSaving) return 'Uploading';
    if (mapImageDeleteMode) return 'Delete photo';
    return mapImage ? 'Change photo' : 'Upload photo';
  }

  function mapImageActionTitle() {
    if (mapImageDeleteMode) return 'Delete satellite photo';
    return mapImage ? 'Change satellite photo' : 'Upload satellite photo';
  }

  async function openMapImageUpload(event) {
    if (mapImage && mapImageButtonHovered && (event.ctrlKey || event.shiftKey)) {
      event.preventDefault();
      await deleteCurrentMapImage();
      return;
    }

    mapImageInput?.click();
  }

  async function deleteCurrentMapImage() {
    if (!mapImage) return;

    const confirmed = confirm(
      'Delete the satellite photo? Trees and map features will stay saved at their current pixel coordinates.'
    );

    if (!confirmed) return;

    mapImageDeleting = true;
    errorMessage = '';

    try {
      const response = await fetch('/api/map-image', { method: 'DELETE' });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || 'The satellite photo could not be deleted.');
      }

      applyMapImage(null, { fit: true });
    } catch (error) {
      errorMessage =
        error instanceof Error ? error.message : 'The satellite photo could not be deleted.';
    } finally {
      mapImageDeleting = false;
      clearMapImageDeleteModifier();
    }
  }

  async function uploadMapImage(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    mapImageSaving = true;
    errorMessage = '';

    try {
      const formData = new FormData();
      formData.append('image', file);

      const response = await fetch('/api/map-image', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || 'The satellite photo could not be saved.');
      }

      const payload = await response.json();
      applyMapImage(payload.image, { fit: true });
      syncImageLayer();
    } catch (error) {
      errorMessage =
        error instanceof Error ? error.message : 'The satellite photo could not be saved.';
    } finally {
      input.value = '';
      mapImageSaving = false;
    }
  }

  function openImport() {
    importInput?.click();
  }

  async function importInventory(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    saving = true;
    errorMessage = '';

    try {
      const payload = JSON.parse(await file.text());
      const imported = normalizeInventoryPayload(payload);

      if (!imported.trees.length && !imported.features.length) {
        throw new Error('No tree or feature records were found in that file.');
      }

      if (imported.trees.length) {
        const response = await fetch('/api/trees/import', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ trees: imported.trees })
        });

        if (!response.ok) throw new Error('The tree import could not be saved.');
      }

      if (imported.features.length) {
        const response = await fetch(`/api/layers/${editableLayer.id}/features`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ features: imported.features })
        });

        if (!response.ok) throw new Error('The feature import could not be saved.');
      }

      await loadTrees();
      await loadVectorLayer();
      closeForm();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'The inventory import could not be read.';
    } finally {
      input.value = '';
      saving = false;
    }
  }

  function normalizeInventoryPayload(payload) {
    if (Array.isArray(payload)) {
      return { trees: payload, features: [] };
    }

    if (!payload || typeof payload !== 'object') {
      return { trees: [], features: [] };
    }

    return {
      trees: Array.isArray(payload.trees) ? payload.trees : [],
      features: Array.isArray(payload.features) ? payload.features : []
    };
  }
</script>

<svelte:head>
  <title>TreeMap</title>
  <meta
    name="description"
    content="A local yard map for tracking planted trees, paths, and structures."
  />
</svelte:head>

<svelte:window
  onkeydown={updateMapImageDeleteModifier}
  onkeyup={updateMapImageDeleteModifier}
  onblur={clearMapImageDeleteModifier}
/>

<div class="app-shell">
  <main class="map-stage" aria-label="Yard map">
    <div
      class={classes('yard-map', (addMode || moveMode || layerTool === 'delete') && 'is-placing')}
      bind:this={mapElement}
    >
      {#if loading}
        <div class="loading-panel">Loading map</div>
      {/if}
    </div>

    <div class={classes('map-edit-tools', editToolsExpanded && 'is-open')} aria-label="Map edit tools">
      <button
        class={classes('map-edit-toggle', editToolsExpanded && 'is-active')}
        type="button"
        title={editToolsExpanded ? 'Close edit tools' : 'Edit map features'}
        aria-label={editToolsExpanded ? 'Close edit tools' : 'Edit map features'}
        aria-expanded={editToolsExpanded}
        onclick={toggleEditTools}
      >
        <Pencil size={18} aria-hidden="true" />
      </button>
      {#if editToolsExpanded}
        <div class="map-edit-bar">
          <button
            class={classes('map-edit-action', layerTool === 'edit' && 'is-active')}
            type="button"
            onclick={toggleLayerEditMode}
          >
            <Move size={17} aria-hidden="true" />
            <span>Edit vertices</span>
          </button>
          <button
            class={classes('map-edit-action danger', layerTool === 'delete' && 'is-active')}
            type="button"
            onclick={toggleLayerDeleteMode}
          >
            <Trash2 size={17} aria-hidden="true" />
            <span>Delete mode</span>
          </button>
        </div>
      {/if}
    </div>

    {#if layerPanelOpen}
      <section class="layer-panel" aria-label="Map layers">
        <div class="layer-heading">
          <span class="layer-heading-title">
            <Layers size={17} aria-hidden="true" />
            <strong>Layers</strong>
          </span>
          <button
            class="panel-icon-button"
            type="button"
            title="Hide layers"
            aria-label="Hide layers"
            onclick={() => (layerPanelOpen = false)}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <label>
          <input
            type="checkbox"
            bind:checked={showSatellite}
            disabled={!mapImage}
            onchange={syncImageLayer}
          />
          Satellite
        </label>
        <label>
          <input type="checkbox" bind:checked={showPaths} onchange={syncVectorLayer} />
          Paths
        </label>
        <div class="map-image-tools">
          <button
            class={classes('mini-button', mapImageDeleteMode && 'danger')}
            type="button"
            title={mapImageActionTitle()}
            aria-label={mapImageActionTitle()}
            disabled={mapImageBusy}
            onclick={openMapImageUpload}
            onpointerenter={enterMapImageButton}
            onpointermove={updateMapImageDeleteModifier}
            onpointerleave={clearMapImageDeleteModifier}
          >
            {#if mapImageDeleteMode || mapImageDeleting}
              <Trash2 size={15} aria-hidden="true" />
            {:else}
              <Upload size={15} aria-hidden="true" />
            {/if}
            <span>{mapImageActionLabel()}</span>
          </button>
          <span class="map-image-size">
            {#if mapImage}
              {Math.round(mapImage.width)} x {Math.round(mapImage.height)}
            {:else}
              No photo
            {/if}
          </span>
          <input
            bind:this={mapImageInput}
            class="hidden-input"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onchange={uploadMapImage}
          />
        </div>
        <div class="coordinate-readout">
          {#if pointerPosition}
            X {pointerPosition.x} · Y {pointerPosition.y}
          {:else}
            X -- · Y --
          {/if}
        </div>
      </section>
    {:else}
      <button
        class="layer-panel-toggle"
        type="button"
        title="Show layers"
        aria-label="Show layers"
        onclick={() => (layerPanelOpen = true)}
      >
        <Layers size={18} aria-hidden="true" />
      </button>
    {/if}

    {#if errorMessage}
      <div class="toast" role="status">
        <span>{errorMessage}</span>
        <button type="button" title="Dismiss" aria-label="Dismiss" onclick={() => (errorMessage = '')}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    {/if}
  </main>

  <aside class="sidebar" aria-label="Yard records">
      <div class="sidebar-header">
        <div>
          <p>Inventory</p>
          <h1>{layerEditorOpen ? 'Features' : 'Trees'}</h1>
        </div>
        <div class="sidebar-header-actions" aria-label="Inventory file actions">
          <button
            class="icon-button"
            type="button"
            title="Export inventory"
            aria-label="Export inventory"
            onclick={exportInventory}
          >
            <Download size={18} aria-hidden="true" />
          </button>
          <button
            class="icon-button"
            type="button"
            title="Import inventory"
            aria-label="Import inventory"
            onclick={openImport}
          >
            <Upload size={18} aria-hidden="true" />
          </button>
          <input
            bind:this={importInput}
            class="hidden-input"
            type="file"
            accept=".json,application/json"
            onchange={importInventory}
          />
        </div>
      </div>

      <div class="sidebar-tabs" role="tablist" aria-label="Inventory sections">
        <button
          class={classes('sidebar-tab', !layerEditorOpen && 'is-active')}
          type="button"
          role="tab"
          aria-selected={!layerEditorOpen}
          aria-controls="trees-tab"
          onclick={closeLayerEditor}
        >
          <Sprout size={16} aria-hidden="true" />
          <span>Trees</span>
          {#if hasUnsavedTreeChanges}
            <span class="tab-unsaved-badge">Unsaved changes</span>
          {/if}
        </button>
        <button
          class={classes('sidebar-tab', layerEditorOpen && 'is-active')}
          type="button"
          role="tab"
          aria-selected={layerEditorOpen}
          aria-controls="features-tab"
          onclick={openLayerEditor}
        >
          <Layers size={16} aria-hidden="true" />
          <span>Features</span>
          {#if hasUnsavedLayerFeatureChanges}
            <span class="tab-unsaved-badge">Unsaved changes</span>
          {/if}
        </button>
      </div>

      {#if layerEditorOpen}
        <div id="features-tab" class="layer-editor" role="tabpanel" aria-label="Features">
          <div class="sidebar-stats" aria-label="Feature statistics">
            <div class="stat-card">
              <strong>{layerFeatures.length}</strong>
              <span>total features</span>
            </div>
          </div>

          <div class="layer-action-grid" aria-label="Layer drawing tools">
            <button
              class={classes('layer-action', layerTool === 'draw-path' && 'is-active')}
              type="button"
              onclick={() => startLayerDraw('path')}
            >
              <Pencil size={17} aria-hidden="true" />
              <span>Draw path</span>
            </button>
            <button
              class={classes('layer-action', layerTool === 'draw-area' && 'is-active')}
              type="button"
              onclick={() => startLayerDraw('structure')}
            >
              <MapIcon size={17} aria-hidden="true" />
              <span>Draw area</span>
            </button>
          </div>

          {#if layerTool !== 'browse'}
            <div class="layer-utility-row">
              <button class="mini-button" type="button" onclick={stopLayerTools}>
                <X size={15} aria-hidden="true" />
                <span>Stop</span>
              </button>
            </div>
          {/if}

          {#if layerTool === 'draw-path' || layerTool === 'draw-area'}
            <p class="tool-hint">Click points on the map. Press Enter to finish, Escape to cancel.</p>
          {:else if layerTool === 'edit'}
            <p class="tool-hint">Drag vertices to reshape features. Changes save when edit mode is stopped.</p>
          {:else if layerTool === 'delete'}
            <p class="tool-hint danger-text">Click a tree, path, or area on the map to delete it.</p>
          {/if}

          {#if hasLayerFeatureForm}
            <form
              class="layer-feature-form"
              onsubmit={(event) => {
                event.preventDefault();
                saveLayerFeatureMetadata();
              }}
            >
              <div class="record-detail-heading">
                <div>
                  <div class="record-eyebrow">
                    <p>{layerFormMode === 'new' ? 'New feature' : 'Feature record'}</p>
                    {#if layerFeatureFormDirty}
                      <span class="unsaved-badge">Unsaved</span>
                    {/if}
                  </div>
                  <h2>{layerFeatureTitle(layerFeatureForm)}</h2>
                </div>
                <button
                  class="icon-button subtle"
                  type="button"
                  title="Close"
                  aria-label="Close"
                  onclick={closeLayerFeatureForm}
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </div>

              <label>
                Name
                <input bind:value={layerFeatureForm.name} name="layerFeatureName" autocomplete="off" />
              </label>
              <label>
                Kind
                <select bind:value={layerFeatureForm.kind} name="layerFeatureKind">
                  {#each layerKinds as kind (kind.value)}
                    <option value={kind.value}>{kind.label}</option>
                  {/each}
                </select>
              </label>
              <label>
                Note
                <textarea bind:value={layerFeatureForm.note} name="layerFeatureNote" rows="4"></textarea>
              </label>

              <div class="form-actions">
                <button class="delete-button" type="button" disabled={layerSaving} onclick={deleteSelectedLayerFeature}>
                  <Trash2 size={17} aria-hidden="true" />
                  <span>Delete</span>
                </button>
                <button class="save-button" type="submit" disabled={layerSaving}>
                  <Save size={17} aria-hidden="true" />
                  <span>{layerSaving ? 'Saving' : 'Save'}</span>
                </button>
              </div>
            </form>
          {/if}

          <div class="search-box feature-search">
            <Search size={17} aria-hidden="true" />
            <input bind:value={featureFilter} type="search" placeholder="Search features" aria-label="Search features" />
          </div>

          <div class="tree-list layer-feature-list">
            {#each filteredLayerFeatures as feature (feature.id)}
              <button
                class={classes('tree-row', feature.id === selectedLayerFeatureId && 'is-selected')}
                type="button"
                onclick={() => selectLayerFeature(feature.id)}
              >
                <span class="feature-swatch" data-kind={feature.kind}></span>
                <span>
                  <strong>{layerFeatureTitle(feature)}</strong>
                  <small>{layerFeatureSubtitle(feature)}</small>
                  {#if (feature.id === selectedLayerFeatureId && layerFeatureFormDirty) || layerFeatureHasUnsavedDraft(feature.id)}
                    <span class="row-badge">Unsaved</span>
                  {/if}
                </span>
                <Pencil size={15} aria-hidden="true" />
              </button>
            {:else}
              <p class="empty-state">No paths or structures yet</p>
            {/each}
          </div>
        </div>
      {:else}
        <div id="trees-tab" class="tree-editor" role="tabpanel" aria-label="Trees">
          <div class="sidebar-stats" aria-label="Tree statistics">
            <div class="stat-card">
              <strong>{plantedCount}</strong>
              <span>planted</span>
            </div>
            <div class="stat-card">
              <strong>{trees.length}</strong>
              <span>total trees</span>
            </div>
          </div>

          <div class="tree-action-grid" aria-label="Tree tools">
            <button
              class={classes('layer-action', addMode && 'is-active')}
              type="button"
              onclick={beginAdd}
            >
              <CirclePlus size={17} aria-hidden="true" />
              <span>Add tree</span>
            </button>
          </div>

          {#if hasForm}
            <section class="tree-detail" aria-label={formMode === 'new' ? 'New tree' : 'Tree record'}>
              <div class="record-detail-heading">
                <div>
                  <div class="record-eyebrow">
                    <p>{formMode === 'new' ? 'New tree' : 'Tree record'}</p>
                    {#if treeFormDirty}
                      <span class="unsaved-badge">Unsaved</span>
                    {/if}
                  </div>
                  <h2>{formTitle()}</h2>
                </div>
                <button class="icon-button subtle" type="button" title="Close" aria-label="Close" onclick={closeForm}>
                  <X size={18} aria-hidden="true" />
                </button>
              </div>

              <form
                class="tree-form"
                onsubmit={(event) => {
                  event.preventDefault();
                  saveTree();
                }}
              >
                <div class="form-grid">
                  <label>
                    Genus
                    <input bind:value={form.genus} name="genus" autocomplete="off" />
                  </label>
                  <label>
                    Species
                    <input bind:value={form.species} name="species" autocomplete="off" />
                  </label>
                  <label>
                    Variety
                    <input bind:value={form.variety} name="variety" autocomplete="off" />
                  </label>
                  <label>
                    Name
                    <input bind:value={form.name} name="name" autocomplete="off" />
                  </label>
                  <label>
                    Planted date
                    <input bind:value={form.plantedDate} name="plantedDate" type="date" />
                  </label>
                  <label>
                    Source
                    <input bind:value={form.source} name="source" autocomplete="off" />
                  </label>
                  <label>
                    Status
                    <select bind:value={form.status} name="status" onchange={onFieldChange}>
                      {#each mapConfig.statuses as status (status.value)}
                        <option value={status.value}>{status.value}</option>
                      {/each}
                    </select>
                  </label>
                  <label>
                    Radius
                    <input
                      value={form.radius ?? ''}
                      name="radius"
                      type="number"
                      min="6"
                      max="240"
                      step="1"
                      oninput={(event) =>
                        updateTreeNumberField(
                          'radius',
                          event.currentTarget.value,
                          6,
                          240,
                          form.radius ?? 30
                        )}
                      onwheel={preventNumberWheel}
                    />
                  </label>
                </div>

                <label>
                  Canopy
                  <input
                    value={form.radius ?? 30}
                    type="range"
                    min="6"
                    max="240"
                    step="1"
                    oninput={(event) =>
                      updateTreeNumberField('radius', event.currentTarget.value, 6, 240, form.radius ?? 30)}
                  />
                </label>

                <div class="coordinate-grid">
                  <label>
                    X
                    <input
                      value={form.x ?? ''}
                      type="number"
                      step="1"
                      oninput={(event) => updateTreeCoordinateField('x', event.currentTarget.value, form.x ?? 0)}
                      onwheel={preventNumberWheel}
                    />
                  </label>
                  <label>
                    Y
                    <input
                      value={form.y ?? ''}
                      type="number"
                      step="1"
                      oninput={(event) => updateTreeCoordinateField('y', event.currentTarget.value, form.y ?? 0)}
                      onwheel={preventNumberWheel}
                    />
                  </label>
                  <button
                    class={classes('move-button', moveMode && 'is-active')}
                    type="button"
                    title={moveMode ? 'Click the map to place this tree' : 'Move tree'}
                    aria-label={moveMode ? 'Click the map to place this tree' : 'Move tree'}
                    onclick={toggleMove}
                  >
                    <Move size={17} aria-hidden="true" />
                    <span>{moveMode ? 'Pick spot' : 'Move'}</span>
                  </button>
                </div>

                <label>
                  Note
                  <textarea bind:value={form.note} name="note" rows="5"></textarea>
                </label>

                <div class="form-actions">
                  <button class="delete-button" type="button" disabled={saving} onclick={deleteCurrentTree}>
                    <Trash2 size={17} aria-hidden="true" />
                    <span>{formMode === 'new' ? 'Discard' : 'Delete'}</span>
                  </button>
                  <button class="save-button" type="submit" disabled={saving}>
                    <Save size={17} aria-hidden="true" />
                    <span>{saving ? 'Saving' : 'Save'}</span>
                  </button>
                </div>
              </form>
            </section>
          {/if}

          <div class="search-box">
            <Search size={17} aria-hidden="true" />
            <input bind:value={filter} type="search" placeholder="Search trees" aria-label="Search trees" />
          </div>

          <div class="tree-list">
            {#each filteredTrees as tree (tree.id)}
              <button
                class={classes('tree-row', tree.id === selectedId && 'is-selected')}
                type="button"
                onclick={() => editTree(tree.id)}
              >
                <span class="tree-swatch" style:--tree-color={getTreeColor(tree.status)}></span>
                <span>
                  <strong>{treeTitle(tree)}</strong>
                  <small>{treeSubtitle(tree)}</small>
                  {#if (tree.id === selectedId && treeFormDirty) || treeHasUnsavedDraft(tree.id)}
                    <span class="row-badge">Unsaved</span>
                  {/if}
                </span>
                <Pencil size={15} aria-hidden="true" />
              </button>
            {:else}
              <p class="empty-state">No tree records</p>
            {/each}
          </div>
        </div>
      {/if}
  </aside>
</div>

<style>
  :global(.leaflet-container) {
    background: #e9e0cf;
    outline: none;
  }

  :global(.leaflet-control-container) {
    font-family: inherit;
  }

  .app-shell {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(340px, 420px);
    min-height: 100vh;
    overflow: hidden;
    background:
      linear-gradient(135deg, rgba(255, 255, 255, 0.86), rgba(246, 244, 237, 0.62)),
      #f6f4ed;
    isolation: isolate;
  }

  .map-stage {
    position: relative;
    z-index: 0;
    min-width: 0;
    min-height: 100vh;
    overflow: hidden;
    contain: paint;
  }

  .yard-map {
    width: 100%;
    height: 100vh;
    overflow: hidden;
  }

  .yard-map.is-placing,
  .yard-map.is-placing :global(.leaflet-grab),
  .yard-map.is-placing :global(.leaflet-dragging .leaflet-grab),
  .yard-map.is-placing :global(.leaflet-interactive),
  .yard-map.is-placing :global(.leaflet-marker-icon),
  .yard-map.is-placing :global(.leaflet-marker-shadow) {
    cursor: crosshair;
  }

  .loading-panel {
    position: absolute;
    inset: 50% auto auto 50%;
    z-index: 500;
    transform: translate(-50%, -50%);
    border: 1px solid rgba(35, 49, 38, 0.12);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    background: rgba(255, 255, 255, 0.92);
    color: #243629;
    box-shadow: 0 16px 50px rgba(35, 49, 38, 0.14);
    font-weight: 700;
  }

  .layer-panel,
  .layer-panel-toggle,
  .toast {
    position: absolute;
    z-index: 700;
    backdrop-filter: blur(16px);
    background: rgba(255, 255, 255, 0.88);
    border: 1px solid rgba(35, 49, 38, 0.12);
    box-shadow: 0 18px 60px rgba(35, 49, 38, 0.16);
  }

  .map-edit-tools {
    position: absolute;
    top: 1rem;
    right: 1rem;
    z-index: 710;
    display: flex;
    flex-direction: row-reverse;
    gap: 0.45rem;
    align-items: center;
    max-width: calc(100% - 2rem);
  }

  .map-edit-toggle,
  .map-edit-action {
    min-height: 44px;
    border-radius: 8px;
    transition:
      transform 0.15s ease,
      background-color 0.15s ease,
      color 0.15s ease,
      box-shadow 0.15s ease;
  }

  .map-edit-toggle {
    display: inline-grid;
    place-items: center;
    width: 44px;
    flex: 0 0 auto;
    border: 1px solid rgba(35, 49, 38, 0.12);
    background: #fff;
    color: #243629;
    box-shadow: 0 18px 60px rgba(35, 49, 38, 0.16);
  }

  .map-edit-toggle.is-active {
    background: #243629;
    color: #fff;
  }

  .map-edit-bar {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.35rem;
    min-width: 0;
    border: 1px solid rgba(35, 49, 38, 0.12);
    border-radius: 8px;
    padding: 0.35rem;
    background: #fff;
    box-shadow: 0 18px 60px rgba(35, 49, 38, 0.16);
  }

  .map-edit-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    min-width: 0;
    padding: 0 0.75rem;
    background: #edf3ee;
    color: #263629;
    font-weight: 800;
  }

  .map-edit-action.is-active {
    background: #243629;
    color: #fff;
  }

  .map-edit-action.danger.is-active {
    background: #8a3a22;
  }

  .layer-heading,
  .layer-heading-title,
  .form-actions,
  .coordinate-grid,
  .move-button,
  .search-box,
  .tree-row {
    display: flex;
    align-items: center;
  }

  button {
    border: 0;
  }

  .icon-button,
  .move-button,
  .delete-button,
  .save-button {
    min-height: 40px;
    border-radius: 8px;
    transition:
      transform 0.15s ease,
      background-color 0.15s ease,
      color 0.15s ease,
      box-shadow 0.15s ease;
  }

  .move-button {
    gap: 0.45rem;
    padding: 0 0.8rem;
    background: #243629;
    color: #fff;
    font-weight: 700;
  }

  .move-button.is-active {
    background: #b7791f;
  }

  .icon-button {
    position: relative;
    display: inline-grid;
    place-items: center;
    width: 40px;
    background: #eef2ed;
    color: #243629;
  }

  .icon-button.is-active {
    background: #243629;
    color: #fff;
  }

  .icon-button.subtle {
    background: transparent;
  }

  .icon-button:hover,
  .map-edit-toggle:hover,
  .map-edit-action:hover,
  .move-button:hover,
  .delete-button:hover,
  .save-button:hover {
    transform: translateY(-1px);
  }

  .layer-panel {
    left: 1rem;
    bottom: 1rem;
    display: grid;
    gap: 0.55rem;
    border-radius: 8px;
    padding: 0.8rem;
    color: #263629;
  }

  .layer-heading {
    justify-content: space-between;
    gap: 0.45rem;
  }

  .layer-heading-title {
    gap: 0.45rem;
  }

  .panel-icon-button,
  .layer-panel-toggle {
    display: inline-grid;
    place-items: center;
    color: #243629;
  }

  .panel-icon-button {
    width: 30px;
    height: 30px;
    border-radius: 7px;
    background: transparent;
  }

  .panel-icon-button:hover {
    background: #edf3ee;
  }

  .layer-panel-toggle {
    left: 1rem;
    bottom: 1rem;
    width: 44px;
    height: 44px;
    border-radius: 8px;
  }

  .layer-panel-toggle:hover {
    transform: translateY(-1px);
  }

  .layer-panel label {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.5rem;
    align-items: center;
    color: #39463d;
    font-weight: 650;
  }

  .layer-panel input {
    accent-color: #2f7d45;
  }

  .map-image-tools {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.5rem;
    align-items: center;
    border-top: 1px solid rgba(35, 49, 38, 0.1);
    padding-top: 0.55rem;
  }

  .map-image-tools .mini-button {
    justify-content: flex-start;
  }

  .map-image-size {
    color: #59645c;
    font-size: 0.72rem;
    font-weight: 800;
    white-space: nowrap;
  }

  .coordinate-readout {
    border-top: 1px solid rgba(35, 49, 38, 0.1);
    padding-top: 0.55rem;
    color: #59645c;
    font-size: 0.78rem;
    font-weight: 800;
  }

  .toast {
    left: 50%;
    bottom: 1rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    max-width: min(620px, calc(100% - 2rem));
    transform: translateX(-50%);
    border-radius: 8px;
    padding: 0.75rem 0.85rem 0.75rem 1rem;
    color: #633018;
  }

  .toast button {
    display: inline-grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    background: #f7e4d6;
    color: #633018;
  }

  .sidebar {
    position: relative;
    z-index: 5;
    min-width: 0;
    height: 100vh;
    overflow: auto;
    border-left: 1px solid rgba(35, 49, 38, 0.12);
    background: #fbfaf6;
    color: #1f2d23;
  }

  .sidebar-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    padding: 1.25rem 1.25rem 1rem;
    border-bottom: 1px solid rgba(35, 49, 38, 0.1);
  }

  .sidebar-header p {
    margin: 0 0 0.2rem;
    color: #687367;
    font-size: 0.78rem;
    font-weight: 800;
  }

  .sidebar-header h1 {
    margin: 0;
    overflow-wrap: anywhere;
    font-size: clamp(1.35rem, 1.8vw, 1.8rem);
    line-height: 1.1;
  }

  .sidebar-header-actions {
    display: flex;
    flex: 0 0 auto;
    gap: 0.45rem;
    align-items: center;
  }

  .sidebar-tabs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.25rem;
    margin: 0.9rem 1.25rem 0;
    border: 1px solid #d6ddd4;
    border-radius: 8px;
    padding: 0.25rem;
    background: #f1f4ee;
  }

  .sidebar-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 0.45rem;
    min-width: 0;
    min-height: 38px;
    border-radius: 6px;
    background: transparent;
    color: #526056;
    font-weight: 800;
  }

  .sidebar-tab:hover,
  .sidebar-tab.is-active {
    background: #fff;
    color: #243629;
    box-shadow: 0 5px 16px rgba(35, 49, 38, 0.09);
  }

  .tree-editor,
  .layer-editor {
    display: grid;
    gap: 1rem;
    padding: 1.25rem;
  }

  .tree-detail,
  .tree-form {
    display: grid;
    gap: 1rem;
  }

  .tree-detail {
    border-top: 1px solid rgba(35, 49, 38, 0.1);
    padding-top: 1rem;
  }

  .record-detail-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.85rem;
  }

  .record-eyebrow {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
    margin-bottom: 0.2rem;
  }

  .record-eyebrow p {
    margin: 0;
    color: #687367;
    font-size: 0.76rem;
    font-weight: 800;
  }

  .record-detail-heading h2 {
    margin: 0;
    overflow-wrap: anywhere;
    font-size: 1.15rem;
    line-height: 1.15;
  }

  .unsaved-badge,
  .tab-unsaved-badge,
  .row-badge {
    display: inline-flex;
    align-items: center;
    width: fit-content;
    border-radius: 999px;
    background: #fff4d7;
    color: #825415;
    font-weight: 850;
  }

  .unsaved-badge {
    min-height: 20px;
    padding: 0 0.45rem;
    font-size: 0.68rem;
  }

  .tab-unsaved-badge {
    min-height: 18px;
    padding: 0 0.4rem;
    font-size: 0.62rem;
  }

  .row-badge {
    min-height: 18px;
    margin-top: 0.12rem;
    padding: 0 0.4rem;
    font-size: 0.66rem;
  }

  .sidebar-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 0.65rem;
  }

  .stat-card {
    min-width: 0;
    border: 1px solid #d6ddd4;
    border-radius: 8px;
    padding: 0.75rem;
    background: #fff;
  }

  .stat-card strong,
  .stat-card span {
    display: block;
  }

  .stat-card strong {
    color: #1f2d23;
    font-size: 1.35rem;
    line-height: 1;
  }

  .stat-card span {
    margin-top: 0.25rem;
    color: #687367;
    font-size: 0.78rem;
    font-weight: 800;
  }

  .layer-action-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.65rem;
  }

  .tree-action-grid {
    display: grid;
  }

  .tree-action-grid .layer-action {
    justify-content: flex-start;
    padding: 0 0.85rem;
  }

  .layer-action,
  .mini-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    min-width: 0;
    border-radius: 8px;
    font-weight: 800;
  }

  .layer-action {
    min-height: 44px;
    padding: 0 0.65rem;
    background: #edf3ee;
    color: #263629;
  }

  .layer-action.is-active {
    background: #243629;
    color: #fff;
  }

  .layer-action.danger.is-active {
    background: #8a3a22;
  }

  .layer-utility-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .mini-button {
    min-height: 34px;
    padding: 0 0.7rem;
    background: #f1ede2;
    color: #334237;
    font-size: 0.82rem;
  }

  .mini-button.danger {
    background: #8a3a22;
    color: #fff;
  }

  .tool-hint {
    margin: 0;
    border: 1px solid #d6ddd4;
    border-radius: 8px;
    padding: 0.7rem 0.8rem;
    background: #fff;
    color: #566159;
    font-size: 0.86rem;
    line-height: 1.4;
  }

  .danger-text {
    border-color: #edc8b9;
    background: #fff7f3;
    color: #78351f;
  }

  .layer-feature-form {
    display: grid;
    gap: 0.85rem;
    border-top: 1px solid rgba(35, 49, 38, 0.1);
    padding-top: 1rem;
  }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.85rem;
  }

  .tree-form label,
  .layer-feature-form label {
    display: grid;
    gap: 0.4rem;
    min-width: 0;
    color: #445147;
    font-size: 0.82rem;
    font-weight: 800;
  }

  input,
  select,
  textarea {
    width: 100%;
    min-width: 0;
    border: 1px solid #cfd7ce;
    border-radius: 8px;
    background: #fff;
    color: #1f2d23;
  }

  input,
  select {
    min-height: 42px;
    padding: 0 0.7rem;
  }

  textarea {
    resize: vertical;
    min-height: 118px;
    padding: 0.75rem;
  }

  input:focus,
  select:focus,
  textarea:focus {
    border-color: #2f7d45;
    outline: 3px solid rgba(47, 125, 69, 0.16);
  }

  input[type='range'] {
    padding: 0;
    accent-color: #2f7d45;
  }

  .coordinate-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
    gap: 0.85rem;
  }

  .move-button {
    align-self: end;
    justify-content: center;
    min-width: 104px;
    background: #e8eee8;
    color: #263629;
  }

  .form-actions {
    justify-content: space-between;
    gap: 0.85rem;
    padding-top: 0.25rem;
  }

  .delete-button,
  .save-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    min-width: 120px;
    padding: 0 0.95rem;
    font-weight: 800;
  }

  .delete-button {
    background: #f3e9e4;
    color: #76341f;
  }

  .save-button {
    background: #2f7d45;
    color: #fff;
  }

  .search-box {
    gap: 0.5rem;
    margin: 1rem 1.25rem 0.85rem;
    border: 1px solid #d6ddd4;
    border-radius: 8px;
    padding: 0 0.7rem;
    background: #fff;
    color: #6b756a;
  }

  .search-box input {
    border: 0;
    outline: 0;
  }

  .tree-editor .search-box,
  .layer-editor .search-box {
    margin: 0;
  }

  .tree-list {
    display: grid;
    gap: 0.45rem;
    padding: 0 1.25rem 1.25rem;
  }

  .tree-editor .tree-list,
  .layer-editor .tree-list {
    padding: 0;
  }

  .tree-row {
    width: 100%;
    gap: 0.7rem;
    min-height: 58px;
    border-radius: 8px;
    padding: 0.6rem 0.7rem;
    background: transparent;
    color: #1f2d23;
    text-align: left;
  }

  .tree-row:hover,
  .tree-row.is-selected {
    background: #eef4ee;
  }

  .tree-row > span:nth-child(2) {
    display: grid;
    gap: 0.12rem;
    min-width: 0;
    flex: 1;
  }

  .tree-row strong,
  .tree-row small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tree-row strong {
    font-size: 0.95rem;
  }

  .tree-row small {
    color: #687367;
    font-size: 0.78rem;
  }

  .tree-swatch {
    width: 14px;
    height: 14px;
    flex: 0 0 auto;
    border: 2px solid color-mix(in srgb, var(--tree-color) 84%, #172118);
    border-radius: 999px;
    background: color-mix(in srgb, var(--tree-color) 58%, white);
  }

  .feature-swatch {
    width: 18px;
    height: 18px;
    flex: 0 0 auto;
    border: 2px solid #38423b;
    border-radius: 5px;
    background: #d6b98d;
  }

  .feature-swatch[data-kind='path'],
  .feature-swatch[data-kind='fence'] {
    height: 5px;
    border: 0;
    border-radius: 999px;
    background: #e6a33f;
  }

  .feature-swatch[data-kind='bed'] {
    border-color: #355c4b;
    background: #9dc7a4;
  }

  .feature-swatch[data-kind='driveway'] {
    border-color: #6f7370;
    background: #d4d7d3;
  }

  .feature-swatch[data-kind='water'] {
    border-color: #2f6f95;
    background: #b8d8e8;
  }

  .empty-state {
    margin: 1rem 0;
    border: 1px dashed #cfd7ce;
    border-radius: 8px;
    padding: 1rem;
    color: #6b756a;
    text-align: center;
  }

  .hidden-input {
    display: none;
  }

  @media (max-width: 920px) {
    .app-shell {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(55vh, 1fr) auto;
      min-height: 100vh;
      overflow: auto;
    }

    .map-stage {
      min-height: 58vh;
    }

    .yard-map {
      height: 58vh;
    }

    .sidebar {
      height: auto;
      min-height: 42vh;
      border-top: 1px solid rgba(35, 49, 38, 0.12);
      border-left: 0;
    }
  }

  @media (max-width: 640px) {
    .layer-panel,
    .layer-panel-toggle {
      right: 1rem;
    }

    .form-grid,
    .coordinate-grid {
      grid-template-columns: 1fr;
    }

    .move-button {
      width: 100%;
    }
  }
</style>
