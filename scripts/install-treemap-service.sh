#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME="${TREEMAP_SERVICE_NAME:-treemap}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="${TREEMAP_USER:-${SUDO_USER:-$(id -un)}}"
APP_USER_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
APP_DIR="${TREEMAP_APP_DIR:-${APP_USER_HOME:-$HOME}/treemap}"
APP_PORT="${TREEMAP_PORT:-3000}"
INSTALL_PROXY="${TREEMAP_INSTALL_PROXY:-auto}"
PUBLIC_PORT="${TREEMAP_PUBLIC_PORT:-80}"
SERVER_NAME="${TREEMAP_SERVER_NAME:-_}"
BODY_SIZE_LIMIT="${TREEMAP_BODY_SIZE_LIMIT:-100M}"
INSTALL_NODE="${TREEMAP_INSTALL_NODE:-auto}"
OPEN_FIREWALL="${TREEMAP_OPEN_FIREWALL:-auto}"
DISABLE_DEFAULT_SITE="${TREEMAP_DISABLE_DEFAULT_SITE:-auto}"
NODE_MAJOR_REQUIRED=24
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NGINX_SITE_FILE="/etc/nginx/sites-available/${SERVICE_NAME}"
NGINX_SITE_LINK="/etc/nginx/sites-enabled/${SERVICE_NAME}"

log() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

truthy() {
  case "$1" in
    1|true|yes|on|auto) return 0 ;;
    *) return 1 ;;
  esac
}

proxy_enabled() {
  case "$INSTALL_PROXY" in
    auto|1|true|yes|on|nginx) return 0 ;;
    0|false|no|off|skip|never) return 1 ;;
    *) die "Unsupported TREEMAP_INSTALL_PROXY value: $INSTALL_PROXY" ;;
  esac
}

app_host() {
  if [[ -n "${TREEMAP_HOST:-}" ]]; then
    printf '%s' "$TREEMAP_HOST"
  elif proxy_enabled; then
    printf '127.0.0.1'
  else
    printf '0.0.0.0'
  fi
}

run_sudo() {
  if (( EUID == 0 )); then
    "$@"
    return
  fi

  need_cmd sudo
  sudo "$@"
}

run_as_app_user() {
  if [[ "$(id -un)" == "$APP_USER" ]]; then
    "$@"
    return
  fi

  if (( EUID == 0 )); then
    need_cmd runuser
    runuser -u "$APP_USER" -- "$@"
    return
  fi

  die "Run this script as $APP_USER or with sudo."
}

node_major() {
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf '0'
}

node_is_supported() {
  command -v node >/dev/null 2>&1 && [[ "$(node_major)" -ge "$NODE_MAJOR_REQUIRED" ]]
}

install_node_from_nodesource() {
  log "Installing Node.js ${NODE_MAJOR_REQUIRED}.x from NodeSource"

  run_sudo apt-get update
  run_sudo apt-get install -y ca-certificates curl gnupg
  need_cmd curl

  local setup_script
  setup_script="$(mktemp)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_REQUIRED}.x" -o "$setup_script"
  run_sudo bash "$setup_script"
  rm -f "$setup_script"

  run_sudo apt-get install -y nodejs
}

ensure_node() {
  case "$INSTALL_NODE" in
    auto)
      if node_is_supported; then
        log "Using Node.js $(node -v)"
      else
        install_node_from_nodesource
      fi
      ;;
    1|true|yes|nodesource)
      install_node_from_nodesource
      ;;
    0|false|no|skip|never)
      node_is_supported || die "Node.js ${NODE_MAJOR_REQUIRED}+ is required. Install it first or rerun with TREEMAP_INSTALL_NODE=auto."
      ;;
    *)
      die "Unsupported TREEMAP_INSTALL_NODE value: $INSTALL_NODE"
      ;;
  esac

  node_is_supported || die "Node.js ${NODE_MAJOR_REQUIRED}+ is required, but found $(node -v 2>/dev/null || printf 'nothing')."
}

validate_settings() {
  [[ "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+$ ]] || die "Invalid service name: $SERVICE_NAME"
  [[ "$APP_PORT" =~ ^[0-9]+$ ]] || die "TREEMAP_PORT must be a number."
  (( APP_PORT >= 1 && APP_PORT <= 65535 )) || die "TREEMAP_PORT must be between 1 and 65535."
  [[ "$PUBLIC_PORT" =~ ^[0-9]+$ ]] || die "TREEMAP_PUBLIC_PORT must be a number."
  (( PUBLIC_PORT >= 1 && PUBLIC_PORT <= 65535 )) || die "TREEMAP_PUBLIC_PORT must be between 1 and 65535."
  if proxy_enabled && [[ "$APP_PORT" == "$PUBLIC_PORT" ]]; then
    die "TREEMAP_PORT and TREEMAP_PUBLIC_PORT must be different when nginx proxying is enabled."
  fi
  [[ -f "$SOURCE_DIR/package.json" ]] || die "Source checkout missing package.json: $SOURCE_DIR"
  id "$APP_USER" >/dev/null 2>&1 || die "User does not exist: $APP_USER"
  need_cmd systemctl
  need_cmd git
}

prepare_app_directory() {
  local app_group
  app_group="$(id -gn "$APP_USER")"

  log "Preparing deployment root at $APP_DIR for $APP_USER"

  if (( EUID == 0 )); then
    mkdir -p "$APP_DIR"
    chown "$APP_USER:$app_group" "$APP_DIR"
  else
    run_as_app_user mkdir -p "$APP_DIR"
  fi

  if ! run_as_app_user test -w "$APP_DIR"; then
    die "$APP_USER cannot write to $APP_DIR. Fix ownership or rerun with sudo."
  fi

  run_as_app_user mkdir -p \
    "$APP_DIR/releases" \
    "$APP_DIR/data" \
    "$APP_DIR/data/maps" \
    "$APP_DIR/data/snapshots" \
    "$APP_DIR/data/incoming"
}

clone_initial_release() {
  local sha release_dir
  sha="$(git -C "$SOURCE_DIR" rev-parse --short=12 HEAD 2>/dev/null || true)"
  [[ -n "$sha" ]] || die "Source checkout $SOURCE_DIR is not a git repository."
  release_dir="$APP_DIR/releases/$sha"

  if [[ -d "$release_dir" ]]; then
    log "Release $sha already present, skipping clone"
  else
    log "Cloning source into release $sha"
    run_as_app_user git clone --local --no-hardlinks "$SOURCE_DIR" "$release_dir"
  fi

  log "Linking current -> releases/$sha"
  run_as_app_user ln -sfn "releases/$sha" "$APP_DIR/current"
}

install_dependencies_and_build() {
  local npm_bin release_dir
  need_cmd npm
  npm_bin="$(command -v npm)"
  release_dir="$(readlink -f "$APP_DIR/current")"

  log "Installing npm dependencies in $release_dir"
  if [[ -f "$release_dir/package-lock.json" ]]; then
    (cd "$release_dir" && run_as_app_user "$npm_bin" ci)
  else
    (cd "$release_dir" && run_as_app_user "$npm_bin" install)
  fi

  log "Building production app"
  (cd "$release_dir" && run_as_app_user "$npm_bin" run build)
}

write_service() {
  local node_bin app_group tmp_service
  node_bin="$(command -v node)"
  app_group="$(id -gn "$APP_USER")"
  tmp_service="$(mktemp)"

  log "Writing systemd service: $SERVICE_FILE"
  cat > "$tmp_service" <<SERVICE
[Unit]
Description=TreeMap local network app
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${app_group}
WorkingDirectory=${APP_DIR}
Environment=HOST=$(app_host)
Environment=PORT=${APP_PORT}
Environment=NODE_ENV=production
Environment=BODY_SIZE_LIMIT=${BODY_SIZE_LIMIT}
ExecStart=${node_bin} current/build
Restart=always
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
SERVICE

  run_sudo install -m 0644 "$tmp_service" "$SERVICE_FILE"
  rm -f "$tmp_service"
}

install_and_configure_nginx() {
  proxy_enabled || return

  log "Installing and configuring nginx reverse proxy"
  command -v apt-get >/dev/null 2>&1 || die "Automatic proxy setup requires apt-get. Install nginx manually or rerun with TREEMAP_INSTALL_PROXY=skip."

  run_sudo apt-get update
  run_sudo apt-get install -y nginx
  run_sudo mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled

  if [[ -e /etc/nginx/sites-enabled/default ]] && truthy "$DISABLE_DEFAULT_SITE"; then
    log "Disabling nginx default site"
    run_sudo rm -f /etc/nginx/sites-enabled/default
  fi

  local tmp_site
  tmp_site="$(mktemp)"

  cat > "$tmp_site" <<NGINX
server {
    listen ${PUBLIC_PORT} default_server;
    listen [::]:${PUBLIC_PORT} default_server;
    server_name ${SERVER_NAME};

    client_max_body_size ${BODY_SIZE_LIMIT};

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX

  run_sudo install -m 0644 "$tmp_site" "$NGINX_SITE_FILE"
  rm -f "$tmp_site"

  run_sudo ln -sfn "$NGINX_SITE_FILE" "$NGINX_SITE_LINK"
  run_sudo nginx -t
  run_sudo systemctl enable nginx
  run_sudo systemctl restart nginx
}

open_firewall_if_needed() {
  command -v ufw >/dev/null 2>&1 || return

  local firewall_port
  firewall_port="$APP_PORT"
  if proxy_enabled; then
    firewall_port="$PUBLIC_PORT"
  fi

  local ufw_status
  ufw_status="$(run_sudo ufw status 2>/dev/null | sed -n '1p' || true)"

  if [[ "$OPEN_FIREWALL" == "1" || "$OPEN_FIREWALL" == "true" || ( "$OPEN_FIREWALL" == "auto" && "$ufw_status" == "Status: active" ) ]]; then
    log "Allowing TCP port $firewall_port through ufw"
    run_sudo ufw allow "${firewall_port}/tcp" comment "TreeMap"
  fi
}

enable_service() {
  log "Enabling and starting $SERVICE_NAME"
  run_sudo systemctl daemon-reload
  run_sudo systemctl enable "$SERVICE_NAME"
  run_sudo systemctl restart "$SERVICE_NAME"
}

print_summary() {
  local lan_ip
  lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"

  printf '\nTreeMap is installed as %s.\n' "$SERVICE_NAME"
  printf 'Deployment root:       %s\n' "$APP_DIR"
  printf 'Active release:        %s -> %s\n' "$APP_DIR/current" "$(readlink "$APP_DIR/current")"
  printf 'Shared data:           %s/data\n' "$APP_DIR"
  printf 'Local service status:  systemctl status %s\n' "$SERVICE_NAME"
  printf 'Service logs:          journalctl -u %s -f\n' "$SERVICE_NAME"

  if [[ -n "$lan_ip" ]]; then
    if proxy_enabled && [[ "$PUBLIC_PORT" == "80" ]]; then
      printf 'LAN URL:               http://%s/\n' "$lan_ip"
    elif proxy_enabled; then
      printf 'LAN URL:               http://%s:%s/\n' "$lan_ip" "$PUBLIC_PORT"
    else
      printf 'LAN URL:               http://%s:%s/\n' "$lan_ip" "$APP_PORT"
    fi
  else
    if proxy_enabled && [[ "$PUBLIC_PORT" == "80" ]]; then
      printf 'LAN URL:               http://<this-pi-lan-ip>/\n'
    elif proxy_enabled; then
      printf 'LAN URL:               http://<this-pi-lan-ip>:%s/\n' "$PUBLIC_PORT"
    else
      printf 'LAN URL:               http://<this-pi-lan-ip>:%s/\n' "$APP_PORT"
    fi
  fi
}

main() {
  validate_settings
  ensure_node
  prepare_app_directory
  clone_initial_release
  install_dependencies_and_build
  write_service
  enable_service
  install_and_configure_nginx
  open_firewall_if_needed
  print_summary
}

main "$@"
