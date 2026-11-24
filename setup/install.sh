#!/usr/bin/env bash
# Pasang atau perbarui server-platform: Caddy, Node.js, perintah `app`, user deploy, template
# systemd, config Caddy. Aman dijalankan ulang. Perbarui platform:
#
#   cd /opt/server-platform && sudo git pull && sudo bash setup/install.sh
set -Eeuo pipefail

NODE_MAJOR=24
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB=/usr/local/lib/server-platform

die() { echo "✗ $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
[[ $EUID -eq 0 ]] || die "jalankan sebagai root (sudo)"
export DEBIAN_FRONTEND=noninteractive

step "dbus (dibutuhkan systemd-run untuk sudo app exec)"
if ! dpkg -s dbus >/dev/null 2>&1; then
  apt-get update -q
  apt-get -y -q install dbus
fi
systemctl start dbus.socket dbus.service 2>/dev/null || true

step "Caddy (repo resmi caddyserver.com)"
if ! command -v caddy >/dev/null; then
  apt-get update -q
  apt-get -y -q install debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get -y -q install caddy
fi
caddy version

step "Node.js $NODE_MAJOR (NodeSource)"
if [[ "$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')" != "$NODE_MAJOR" ]]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get -y -q install nodejs
fi
[[ "$(command -v node)" == /usr/bin/node ]] || die "node harus di /usr/bin/node (dipakai template systemd)"
node --version

step "Perintah app, app-deploy, app-deploy-ssh"
rm -rf "$LIB.new"
mkdir -p "$LIB.new"
cp -r "$SRC/bin" "$SRC/lib" "$SRC/package.json" "$LIB.new/"
chown -R root:root "$LIB.new"
chmod -R go-w "$LIB.new"
chmod 755 "$LIB.new"/bin/*
rm -rf "$LIB"
mv "$LIB.new" "$LIB"
for cmd in app app-deploy app-deploy-ssh; do
  ln -sfn "$LIB/bin/$cmd" "/usr/local/bin/$cmd"
done

step "User deploy (hanya untuk GitHub Actions; tanpa password, key per app)"
if ! id deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/sh deploy
fi
usermod -p '*' deploy   # tanpa password, tapi tidak dikunci (login dengan key tetap bisa)
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

step "sudoers: deploy hanya boleh menjalankan app-deploy"
tmp="$(mktemp)"
echo 'deploy ALL=(root) NOPASSWD: /usr/local/bin/app-deploy' > "$tmp"
visudo -cqf "$tmp" || die "sudoers tidak valid"
install -m 440 "$tmp" /etc/sudoers.d/server-platform
rm -f "$tmp"

step "Template systemd app@.service"
install -m 644 "$SRC/systemd/app@.service" /etc/systemd/system/app@.service
systemctl daemon-reload

step "Config Caddy"
install -d -m 755 /etc/caddy/sites /srv/apps
if ! cmp -s "$SRC/caddy/Caddyfile" /etc/caddy/Caddyfile; then
  [[ -f /etc/caddy/Caddyfile ]] && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$(date +%Y%m%d%H%M%S)"
  install -m 644 "$SRC/caddy/Caddyfile" /etc/caddy/Caddyfile
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable --quiet caddy
systemctl reload-or-restart caddy

printf '\n✅ server-platform terpasang. Cek: sudo app list\n'
