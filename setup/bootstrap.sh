#!/usr/bin/env bash
# Setup awal VM baru (Ubuntu 24.04). Jalankan SEKALI sebagai root setelah install ulang:
#
#   git clone https://github.com/dodi345/server-platform.git /opt/server-platform
#   bash /opt/server-platform/setup/bootstrap.sh --user <nama-user>
#
# Opsi: --timezone Asia/Jakarta (default), --swap 2G (default). Aman dijalankan ulang.
# Isi: update sistem, user sudo (login password), SSH tanpa root, fail2ban, ufw, swap,
# update keamanan otomatis, batas log, lalu setup/install.sh (Caddy, Node, perintah app).
set -Eeuo pipefail

USER_NAME=""
TZ_NAME="Asia/Jakarta"
SWAP_SIZE="2G"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) USER_NAME="${2:-}"; shift 2 ;;
    --timezone) TZ_NAME="${2:-}"; shift 2 ;;
    --swap) SWAP_SIZE="${2:-}"; shift 2 ;;
    *) echo "opsi tidak dikenal: $1" >&2; exit 2 ;;
  esac
done

die() { echo "✗ $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

[[ $EUID -eq 0 ]] || die "jalankan sebagai root"
[[ -n "$USER_NAME" ]] || die "wajib: --user <nama-user> (user untuk login harian)"
[[ "$USER_NAME" =~ ^[a-z][a-z0-9_-]{1,31}$ ]] || die "nama user tidak valid: $USER_NAME"
[[ "$USER_NAME" != "deploy" && "$USER_NAME" != app-* ]] || die "nama user itu dipakai platform"
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || echo "Peringatan: dites untuk Ubuntu 24.04, ini ${PRETTY_NAME:-?}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step "Update sistem"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold full-upgrade
apt-get -y -q install fail2ban ufw unattended-upgrades curl git ca-certificates gnupg

step "Zona waktu: $TZ_NAME"
timedatectl set-timezone "$TZ_NAME"

step "User $USER_NAME (sudo, login password)"
if ! id "$USER_NAME" >/dev/null 2>&1; then
  adduser --gecos "" "$USER_NAME"
fi
usermod -aG sudo "$USER_NAME"
if [[ "$(passwd -S "$USER_NAME" | awk '{print $2}')" != "P" ]]; then
  echo "User $USER_NAME belum punya password:"
  passwd "$USER_NAME"
fi

step "SSH: root tidak bisa login, password untuk user biasa, maks 3 percobaan"
cat > /etc/ssh/sshd_config.d/00-hardening.conf <<'EOF'
# server-platform (bootstrap.sh). Nama 00- supaya dibaca sebelum file bawaan (50-cloud-init.conf).
PermitRootLogin no
PasswordAuthentication yes
KbdInteractiveAuthentication no
MaxAuthTries 3
LoginGraceTime 30
EOF
sshd -t
systemctl restart ssh

step "fail2ban (5 gagal dalam 10 menit = blokir 1 jam)"
cat > /etc/fail2ban/jail.local <<'EOF'
[sshd]
enabled  = true
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
systemctl enable --quiet fail2ban
systemctl restart fail2ban

step "Firewall: SSH, HTTP, HTTPS"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable

step "Swap $SWAP_SIZE"
if [[ -z "$(swapon --show --noheadings)" ]]; then
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swap.conf
sysctl -q --system

step "Update keamanan otomatis"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

step "Batas ukuran log journald (200 MB)"
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\n' > /etc/systemd/journald.conf.d/00-size.conf
systemctl restart systemd-journald

bash "$HERE/install.sh"

cat <<EOF

✅ Bootstrap selesai.
   1. Dari terminal LAIN di laptop, tes: ssh $USER_NAME@<ip-vm>  lalu  sudo -v
      (root sudah tidak bisa login lewat SSH; jangan tutup sesi ini sebelum tes berhasil)
   2. $( [[ -f /var/run/reboot-required ]] && echo "Server minta reboot: sudo reboot" || echo "Tidak perlu reboot." )
   3. Daftarkan app: sudo app register <nama>
EOF
