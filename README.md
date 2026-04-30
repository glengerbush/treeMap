# TreeMap

I wanted to keep track of the trees I've planted in my yard and nature destroyed every sign I put in front of a tree, so I made a local-first yard map for tracking planted trees.

- Upload an aerial photo of your yard from the layer panel when you want a base map.
- Then mark paths, landmarks, and tree locations, along with details about each.

<video src="https://github.com/user-attachments/assets/324fd65e-f205-4a52-9c5b-d7d48c6b3092" controls width="100%"></video>


## Run Locally

Requires Node 24 or newer because this app uses Node's built-in SQLite module.

```bash
npm install
npm run dev
```

Then open the local URL shown in the terminal.

For a production-style local server:

```bash
npm run build
npm run start
```

## Install TreeMap as a service(for Debian based distros)

On the Linux host that will run TreeMap, copy or clone this project and from the directory, run:

```bash
sudo bash scripts/install-treemap-service.sh
```

The installer:

- Ensures Node.js 24 or newer is available, installing Node.js 24.x from NodeSource if needed.
- Installs npm dependencies and builds the production app.
- Creates a `treemap` systemd service that starts on boot and restarts after crashes or power outages.
- Runs the app privately on `127.0.0.1:3000`.
- Installs nginx and serves the app to the local network on port `80`.
- Disables nginx's default site symlink so TreeMap answers plain IP requests.
- Allows the port through `ufw` if `ufw` is installed and active.

After it finishes, open the app from another computer on the same network:

```text
http://<pc-lan-ip>/
```

Useful service commands:

```bash
sudo systemctl status treemap
sudo journalctl -u treemap -f
sudo systemctl restart treemap
```

Optional installer settings:

```bash
TREEMAP_USER=treemap sudo -E bash scripts/install-treemap-service.sh
TREEMAP_PORT=3001 sudo -E bash scripts/install-treemap-service.sh
TREEMAP_PUBLIC_PORT=8080 sudo -E bash scripts/install-treemap-service.sh
TREEMAP_INSTALL_PROXY=skip TREEMAP_HOST=0.0.0.0 sudo -E bash scripts/install-treemap-service.sh
TREEMAP_INSTALL_NODE=skip sudo -E bash scripts/install-treemap-service.sh
```

`TREEMAP_PORT` changes the app's private internal port. `TREEMAP_PUBLIC_PORT` changes the nginx port that browsers use. If the proxy is skipped, set `TREEMAP_HOST=0.0.0.0` so other computers can reach the app directly.

The live SQLite database and uploaded map images stay on the PC in `data/`, so back up that directory if the PC's storage is replaced.

## Change The Yard Image

Use the `Upload photo` button in the app's layer panel to upload a PNG, JPEG, or WebP satellite image. Uploaded photos are stored locally in:

```text
data/maps/
```

To remove the current photo, hold `Ctrl` or `Shift` while clicking `Change photo`, then confirm the deletion. Tree and layer records stay saved in SQLite at their existing pixel coordinates.

If no photo has been uploaded, the app shows a blank map workspace. The blank workspace dimensions live in:

```text
src/lib/mapConfig.js
```

## Update Paths And Structures

Use the `Layers` button in the app to draw paths and areas directly on the map. Editable layer features are stored in SQLite.

The starter JSON seed file is:

```text
static/layers/paths-structures.json
```

See `docs/layers.md` for step-by-step drawing instructions and the coordinate format.
