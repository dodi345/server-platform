# server-platform

Deploy banyak app ke **satu VM kecil** tanpa Docker dan tanpa dashboard: **Caddy** (HTTPS otomatis) +
**systemd** + satu file **`deploy.json`** per repo. Build selalu di GitHub Actions, jadi RAM server hanya
dipakai aplikasi (Caddy ~15 MB).

Menambah project = tulis `deploy.json`, daftarkan sekali di server, lalu `git push`. Tidak ada config
vhost, unit systemd, atau sertifikat yang ditulis tangan.

```
git push ──► GitHub Actions: build → tar.gz ──SSH (key khusus app)──► server: app-deploy
                                                                          │
   releases/<waktu>-<sha>  ◄── ekstrak, cek deploy.json, sambungkan shared/ ─┘
   current ──► release baru → systemd app@<nama> restart → health check
                           → /etc/caddy/sites/<nama>.caddy → caddy validate → reload
   gagal di langkah mana pun → kembali ke release sebelumnya, job GitHub merah
```

## Isi server

| Lokasi | Isi |
|---|---|
| `/srv/apps/<nama>/releases/` | 3 release terakhir (+ release sebelumnya untuk rollback) |
| `/srv/apps/<nama>/current` | symlink ke release aktif |
| `/srv/apps/<nama>/shared/.env` | env app (root, 600); dibaca systemd, **tidak pernah lewat GitHub** |
| `/srv/apps/<nama>/shared/<folder>` | data yang bertahan antar deploy (mis. `data/` SQLite), milik user `app-<nama>` |
| `/srv/apps/<nama>/state.json` | versi aktif, sebelumnya, riwayat deploy (dibaca `app list --json`) |
| `/etc/caddy/sites/<nama>.caddy` | vhost, dibuat otomatis dari `deploy.json` |
| `/etc/systemd/system/app@.service` | template service semua app node |
| `/usr/local/bin/app`, `app-deploy`, `app-deploy-ssh` | perintah platform |

## 1. Server baru (sekali, sebagai root)

Ubuntu 24.04, setelah install ulang:

```bash
git clone https://github.com/dodi345/server-platform.git /opt/server-platform
bash /opt/server-platform/setup/bootstrap.sh --user <nama-user>
```

`bootstrap.sh`:
- update sistem;
- user sudo (login password; root tidak bisa login lewat SSH);
- fail2ban, ufw (22/80/443);
- swap 2 GB;
- update keamanan otomatis;
- batas log 200 MB;
- lalu `install.sh` (Caddy dari repo resmi, Node 24 dari NodeSource, user `deploy`, perintah `app`).

**Sebelum menutup sesi root:** tes `ssh <nama-user>@<ip>` lalu `sudo -v` dari terminal lain.

Cloudflare (sekali):

1. Record wildcard `A *` → IP VM, Proxied. Semua subdomain langsung mengarah ke VM.
2. SSL/TLS: **Full (strict)**.

## 2. Menambah project

**a. Di repo project, tambahkan `deploy.json`.** Contoh ada di `templates/deploy.node.json` dan
`templates/deploy.static.json`.

**b. Di repo project, tambahkan workflow.** Salin `templates/caller-workflow.yml` ke
`.github/workflows/deploy.yml`, atau tambahkan job-nya ke workflow CI yang sudah ada dengan
`needs: <job-test>`.

**c. Di server, daftarkan app:**

```bash
sudo app register <nama>      # mencetak DEPLOY_HOST, DEPLOY_HOST_KEY, DEPLOY_SSH_KEY (sekali saja)
sudo app env <nama>           # isi .env di editor (nano)
```

**d. Di GitHub, isi tiga secret** yang dicetak tadi: repo → Settings → Secrets and variables → Actions.

**e. Push ke `main`.**

Kalau memakai **domain baru** (bukan `*.stackfolio.web.id`):

1. Tambahkan domain itu di Cloudflare (ganti nameserver di registrar).
2. Buat record `A @` → IP VM, dan `CNAME www` → domain itu.
3. Set **SSL/TLS = Full (strict)**. Kalau dibiarkan "Flexible", terjadi redirect loop.
4. Tulis domain itu di `deploy.json`, lalu push.

## 3. `deploy.json`

| Field | Tipe | Wajib | Isi |
|---|---|---|---|
| `name` | semua | ✓ | sama dengan `sudo app register <nama>` (huruf kecil, angka, `-`) |
| `type` | semua | ✓ | `"node"` (service) atau `"static"` (file statis) |
| `domains` | semua | ✓ | daftar domain; sertifikat HTTPS otomatis |
| `redirect_www` | semua | | `true` = `www.x` dialihkan ke `x` (keduanya harus ada di `domains`) |
| `node` | semua | node: ✓ | versi mayor Node untuk build di GitHub (dan di server untuk app node), mis. `"24"` |
| `build` | semua | | perintah build di GitHub, mis. `"npm ci && npm run build && npm prune --omit=dev"` |
| `package` | semua | ✓ | path hasil build yang dikirim ke server (`deploy.json` selalu ikut) |
| `port` | node | ✓ | port app di `127.0.0.1` (unik per server, 1024–65535) |
| `start` | node | ✓ | `["node", "<file>", ...]` relatif ke folder release |
| `health` | node | | path health check (default `/`); harus 2xx/3xx dalam 60 detik |
| `shared` | node | | folder data yang bertahan antar deploy, mis. `["data"]` (tidak boleh ikut `package`) |
| `memory` | node | | batas RAM systemd, default `"300M"` |
| `required_env` | node | | variabel `.env` yang wajib terisi; kosong = deploy ditolak sebelum restart |
| `root` | static | | folder berisi `index.html` (default `.`) |
| `spa` | static | | `true` = path tak dikenal → `index.html` |
| `clean_urls` | static | | `true` = `/card` menyajikan `card.html` (atau `card/index.html`) |
| `not_found` | static | | halaman 404 relatif ke `root`: `"404.html"`, atau per awalan `{"/id/": "id/404.html", "/": "404.html"}`. Status tetap 404 |
| `headers` | static | | header untuk semua respons, mis. CSP dan header keamanan |
| `file_headers` | static | | header untuk path tertentu, mis. `{"/kartu.vcf": {"Content-Type": "text/vcard; charset=utf-8"}}` |
| `immutable` | static | | pola path yang di-cache setahun, mis. `["/_astro/*"]`. Selain itu selalu `Cache-Control: no-cache` (dicek ulang, 304 kalau sama), supaya pengunjung langsung dapat versi baru |
| `redirects` | static | | daftar `{ "from": "/cv.pdf", "to": "/cv-en.pdf", "status": 301 }`, dievaluasi berurutan. Syarat opsional `"when": { "cookie": "lang=id" }` atau `"when": { "header": "Accept-Language", "prefix": "id" }` |

Semua nilai divalidasi ketat (tanpa kutip, kurung kurawal, atau baris baru), jadi `deploy.json` tidak bisa
menyisipkan config Caddy lain. `Cache-Control` diatur platform lewat `immutable`.

App node berjalan dengan `WorkingDirectory` = folder release, sebagai user `app-<nama>`, dengan env dari
`shared/.env`. App hanya bisa menulis ke `shared/`, dan harus listen di `127.0.0.1:<port>`; Caddy yang
melayani publik.

## 4. Perintah `app` (di server)

```
sudo app list [--json]          semua app: status, port, versi, domain (--json untuk panel monitoring)
sudo app status <nama>          detail + health check + riwayat deploy
sudo app logs <nama> [-f]       log aplikasi
sudo app env <nama> [--keys]    ubah .env (--keys: nama variabel saja, tanpa nilai)
sudo app exec <nama> <cmd...>   jalankan perintah sebagai user app, dengan .env + folder release
                                (mis. perintah admin/migrasi; jangan jalankan app sebagai root langsung)
sudo app restart <nama>         restart + health check (setelah .env diubah)
sudo app rollback <nama>        kembali ke release sebelumnya
sudo app env-set <nama> <VAR>   isi/ganti satu variabel (nilai dari stdin, tidak tampil di layar/history)
sudo app env-unset <nama> <VAR> hapus satu variabel
sudo app agent-access <nama>    izinkan app ini memakai agent (untuk panel monitoring)
sudo app register <nama> --rotate-key   key deploy baru (key lama langsung tidak berlaku)
sudo app remove <nama> [--purge]        cabut app (--purge: termasuk data)
```

## 5. Keamanan

- **Satu key deploy per app.** Di `authorized_keys`, key itu dibatasi `restrict,command="app-deploy-ssh <nama>"`, sehingga
  hanya bisa mengirim `deploy <sha>` untuk app itu: tanpa shell, tanpa forwarding. Key bocor = hanya
  app itu yang bisa di-deploy ulang, dan `--rotate-key` langsung mencabutnya.
- **User `deploy`:** tanpa password, dan hanya boleh `sudo /usr/local/bin/app-deploy`.
- **`app-deploy` memvalidasi `deploy.json` secara ketat** sebelum apa pun ditulis ke Caddy atau systemd (domain, port,
  argumen start tanpa karakter khusus), dan menolak domain atau port yang dipakai app lain.
- **Service app memakai pengamanan systemd:** `ProtectSystem=strict`, `ProtectHome`, `NoNewPrivileges`, dan
  tulis hanya ke `shared/`.
- **IP pengunjung tidak bisa dipalsukan.** Caddy hanya memercayai `CF-Connecting-IP`/`X-Forwarded-For` dari rentang
  IP Cloudflare (`caddy/Caddyfile`), lalu mengirim IP asli ke app node sebagai `X-Real-IP` (selalu ditimpa). Pakai
  header itu untuk pembatas percobaan login.
- **Rahasia hanya di `shared/.env` di server.** `app env --keys` dan pesan error tidak pernah menampilkan nilainya.

## 6. Agent (untuk panel)

Panel ([server-panel](https://github.com/dodi345/server-panel)) tidak jalan sebagai root. Aksinya lewat **agent**:

- **Akses:** socket `/run/server-platform/agent.sock` (`root:platform-agent`, 660), diaktifkan systemd per
  permintaan (`server-platform-agent.socket`). Tidak ada proses yang jalan saat idle.
- **Operasi yang ada:** `list`, `status`, `logs`, `restart`, `rollback`, `env-keys` (nama variabel saja), `env-set`,
  dan `env-unset`. Tidak ada register/remove/exec, tidak ada perintah bebas, dan tidak ada operasi yang
  mengembalikan nilai env.
- **`list` / `status`:** per app: tipe, domain, port, versi aktif dan sebelumnya, hasil deploy terakhir
  (`lastDeploy`, termasuk yang gagal/rollback; v1.4), dan properti systemd (status, RAM, jumlah restart otomatis).
- **Siapa yang boleh:** hanya app yang diberi `sudo app agent-access <nama>`; app lain ditolak di level socket.
- **Audit:** setiap perubahan tercatat di journald: `journalctl -t server-platform-agent`.

## 7. Memperbarui platform

```bash
cd /opt/server-platform && sudo git pull && sudo bash setup/install.sh
```

App yang sedang jalan tidak terganggu. Template systemd dan config utama Caddy diperbarui, lalu Caddy
di-reload.

## 8. Troubleshooting

| Gejala | Penyebab / solusi |
|---|---|
| Job deploy: `env belum diisi: X` | `sudo app env <nama>`, isi `X`, lalu Re-run job |
| Job deploy: `crash saat start` | Lihat log yang dicetak di job, atau `sudo app logs <nama>`. Versi lama tetap jalan |
| Job deploy: `tidak menjawab dalam 60 detik` | App tidak listen di port `deploy.json`, atau path `health` salah |
| Browser: error 526 (Cloudflare) | Sertifikat belum terbit. Set record ke DNS only sebentar, cek `journalctl -u caddy`, lalu kembalikan ke Proxied |
| Browser: "too many redirects" | SSL/TLS domain di Cloudflare masih Flexible; ubah ke **Full (strict)** |
| `Permission denied (publickey)` di job | Secret `DEPLOY_SSH_KEY` salah atau key sudah di-rotate |
| `Host key verification failed` di job | Server di-install ulang: `sudo app register <nama> --rotate-key` lalu perbarui ketiga secret |

## Pengembangan

```bash
npm test     # node --test: manifest, render, deploy/rollback di folder sementara, CLI,
             # validasi Caddyfile + situs statis yang benar-benar disajikan image caddy:2 (kalau Docker ada)
```

Tanpa dependency npm. Kode server di `lib/` (ESM + JSDoc), perintah di `bin/`, skrip setup di `setup/`.
