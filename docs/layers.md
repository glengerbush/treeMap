# Updating Map Layers

The app starts without a satellite photo. Upload one with the `Upload photo` button in the layer panel. Uploaded images are stored under `data/maps/`, and their dimensions are saved in SQLite.

To delete the current satellite photo, hold `Ctrl` or `Shift` while clicking `Change photo`, then confirm the deletion. The app removes the uploaded image file and its SQLite image record, but trees and layer features remain saved at their existing pixel coordinates.

If no photo has been uploaded, the app shows a blank map workspace using the dimensions configured in:

```text
src/lib/mapConfig.js
```

The paths and structures layer can now be edited in the app. The app stores editable features in SQLite.

The plain JSON file is still useful as a starter seed:

```text
static/layers/paths-structures.json
```

On first load, if the SQLite layer is empty, the app imports features from that file. After that, in-app edits are saved to SQLite at `data/treemap.sqlite`, and the app records that the seed was handled so deleted features do not reappear later.

Coordinates use map pixels, with `[0, 0]` at the top-left and `[map width, map height]` at the bottom-right. Once a photo has been uploaded, those dimensions come from the photo. Feature coordinates are written as `[x, y]`.

## In-App Workflow

1. Open the `Features` tab in the sidebar.
2. Choose `Draw path` for walking paths, fences, or bed edges.
3. Choose `Draw area` for structures, patios, garden beds, or filled shapes.
4. Click points on the map.
5. Press Enter to finish or Escape to cancel.
6. Select the new feature in the sidebar.
7. Fill out `Name`, `Kind`, and `Note`.
8. Click `Save`.

Use `Edit vertices` to reshape existing paths and areas. Drag the vertex handles, then click `Stop`; geometry changes are saved when edit mode ends.

Use `Delete mode` to remove features by clicking them on the map, or select a feature and use the `Delete` button in the sidebar.

The app stores curved-looking paths as `LineString` features with multiple points. To make a curve smoother, add more points around the bend.

## Manual JSON Workflow

1. Open the app and turn on the `Paths` layer.
2. Move your cursor around the map and use the coordinate readout in the layer panel.
3. Write down points along each path, structure, bed, fence, or driveway edge.
4. Edit `static/layers/paths-structures.json`.
5. Restart the app or clear the matching `layer_seed_state` row before relying on the seed file again.

## Feature Types

Use a `LineString` for walking paths, fence lines, bed edges, or anything that should be drawn as a line:

```json
{
  "name": "Main walking path",
  "kind": "path",
  "geometry": {
    "type": "LineString",
    "coordinates": [
      [410, 1290],
      [620, 1190],
      [880, 1125],
      [1160, 1080]
    ]
  }
}
```

Use a `Polygon` for structures, patios, garden beds, or other filled areas:

```json
{
  "name": "Shed",
  "kind": "structure",
  "geometry": {
    "type": "Polygon",
    "coordinates": [
      [
        [1240, 690],
        [1510, 690],
        [1510, 910],
        [1240, 910],
        [1240, 690]
      ]
    ]
  }
}
```

Polygon rings must close: the final coordinate should match the first coordinate.

## Full File Shape

`paths-structures.json` should look like this:

```json
{
  "features": [
    {
      "name": "Main walking path",
      "kind": "path",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [410, 1290],
          [620, 1190],
          [880, 1125]
        ]
      }
    },
    {
      "name": "Shed",
      "kind": "structure",
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [1240, 690],
            [1510, 690],
            [1510, 910],
            [1240, 910],
            [1240, 690]
          ]
        ]
      }
    }
  ]
}
```

## Style Controls

The app currently styles features based on `kind`:

- `path`: orange line
- `structure`: filled tan polygon
- anything else: green outline/fill

You can use any `name`; it appears as a tooltip on the map.

## Drawing Outside The App

The safest external workflow is to use an editor that can show image pixel coordinates:

1. If a satellite photo has been uploaded, open that image in an image editor such as GIMP, Krita, Inkscape, or Photoshop.
2. Turn on the coordinate/status readout.
3. Click along each feature and record pixel coordinates.
4. Put those `[x, y]` points into the JSON file.

If the editor reports coordinates from the bottom-left instead of the top-left, convert the y value:

```text
app_y = 1720 - editor_y
```

Use the current map height shown in the app's layer panel when converting bottom-left coordinates.

## Replacing The Seed File

To replace the starter JSON file:

1. Draw the feature coordinates in your drawing tool.
2. Convert the coordinates to image-pixel coordinates if needed.
3. Replace `static/layers/paths-structures.json`.
4. If the SQLite layer has already been seeded, import/export manually or clear both `layer_features` and the matching `layer_seed_state` row before relying on the seed file again.

`static/layers/example-paths-structures.json` has a small sample of the expected shape. It is not loaded by the app.
