# Vega Analysis — Production Deployment Dependency Audit
### Target: fresh Ubuntu 24.04 LTS, Hostinger KVM 2

Everything below was derived by reading this repository, not from a generic
Node-deployment template. Where a claim is version- or feature-specific, the
file that forces it is named.

---

## 0. What this project actually is (shapes every decision below)

| Fact | Evidence | Consequence for deployment |
|---|---|---|
| Two separate npm projects, **no root `package.json`, no workspaces** | only `client/package.json` and `server/package.json` exist | you run `npm ci` twice, in two directories |
| Backend is **CommonJS Node + Express + raw `http` server** | `server/src/index.js`, `"type": "commonjs"` | no transpile step, no build for the backend |
| Frontend is a **Vite SPA that must be built** into `client/dist` | `client/package.json` → `"build": "vite build"` | a static file server is required |
| **The Express app never serves the frontend** | `grep express.static server/src` → no match; `app.js` mounts API routes only | Nginx (or equivalent) is **mandatory**, not a nicety |
| Frontend calls the API at the **relative** path `/api` | `client/src/api/axios.js` → `axios.create({ baseURL: '/api' })` | SPA and API must be on **one origin** |
| WebSocket URL is built from `window.location.host` | `client/src/services/marketSocket.js:25` → `${protocol}://${window.location.host}/ws/market?token=…` | the same origin must also proxy **`/ws/market`** with Upgrade headers |
| WebSocket path is fixed at `/ws/market`, auth happens on HTTP upgrade | `server/src/services/websocketService.js:6,41-70` | proxy must forward the query string (the JWT rides in it) |
| The backend holds **long-lived state**: KiteTicker socket, in-memory tick map, live ring buffers, 5 in-process cron jobs | `index.js`, `vegaConfig.js`, `kiteTickerService.js` | **single process only** — see the PM2 warning in §3 |
| No Dockerfile, no compose file, no container assumptions | `find . -iname "*docker*" -o -iname "*.y*ml"` → nothing | Docker is **not** required |
| No Redis anywhere | `grep -ri redis server/src client/src` → 0 matches (only a README *roadmap* mention) | Redis is **not** required |
| Zero native/compiled npm modules | both lockfiles: no `node-gyp`, no `node-pre-gyp`; only `esbuild` (prebuilt binary) and `fsevents` (macOS-only, skipped on Linux) have install scripts; `bcryptjs` is pure JS (not `bcrypt`), `mysql2` is pure JS | **`build-essential` / `python3` / `make` / `g++` are NOT required** |
| The app shells out to **`mysqldump`** | `server/src/services/backupService.js:5,32` (`execFile`) | the MySQL **client binaries** are a real runtime dependency of the admin Backup feature |
| Schema files hard-code the database name | `USE vega_analysis;` in all 6 `server/src/schema*.sql` | **`DB_NAME` must be exactly `vega_analysis`** |
| Schema uses `JSON` columns | `schema.vega.sql` (`open_chain JSON NOT NULL`, 10 JSON columns total) | MySQL **5.7+**; MySQL 8.0 recommended |
| Migrations run automatically at every boot and issue `CREATE DATABASE` | `index.js` step 0 → `migrate.run()`; `migrate.js` opens a connection **without** a database and enables `multipleStatements` | the MySQL user needs `CREATE` on `vega_analysis` |

---

## 1. Required — the system will not run without these

### 1.1 Node.js — **REQUIRED** · backend + frontend build

**Version: Node.js 22 LTS.** The floor is enforced by three packages, verified from the lockfiles:

| Package | Declared engine | Where |
|---|---|---|
| `esbuild@0.28.1` (server prod dep) | `>=18` | `server/package-lock.json` |
| `vite@5.4.21` | `^18.0.0 \|\| >=20.0.0` | `client/package-lock.json` |
| `rollup@4.62.2` | `>=18.0.0`, `npm >=8.0.0` | `client/package-lock.json` |

Highest floor across **all** transitive dependencies in both lockfiles is **Node 18**. So Node 18 is the absolute minimum, Node 20 or 22 LTS is the correct production choice. **Do not use Ubuntu's `apt install nodejs`** — Ubuntu 24.04's default `nodejs` package is Node 18.19, which technically passes but is EOL and gets no security updates.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs
```

Why: runs the Express/WebSocket API, and compiles the React SPA.

---

### 1.2 npm — **REQUIRED** (bundled with Node — no separate install)

Both lockfiles are `"lockfileVersion": 3` → npm 7+ required; Node 22 ships npm 10. Nothing to install.

**pnpm: NOT required, and actively discouraged here.** The repo commits `package-lock.json` in both projects and no `pnpm-lock.yaml`. Using pnpm would ignore both lockfiles and re-resolve every version, which is precisely what you do not want on a live trading feed. Use `npm ci` (exact lockfile install) — not `npm install`.

> Checked and safe: the Windows-generated lockfiles **do** contain the Linux platform entries (`@esbuild/linux-x64`, `@rollup/rollup-linux-x64-gnu`, …), so `npm ci` on Ubuntu resolves correctly. Those are prebuilt glibc binaries — fine on Ubuntu, would break on Alpine/musl.

---

### 1.3 MySQL Server — **REQUIRED** · database

**MySQL 8.0** (what Ubuntu 24.04's `mysql-server` provides). Minimum is 5.7 because of the `JSON` columns in `schema.vega.sql`, `schema.instruments.sql` and `schema.onboarding.sql`.

```bash
sudo apt install -y mysql-server
```

Why: every user, session, instrument master, option-chain snapshot and the entire Vega time-series lives here. `config/db.js` opens a 15-connection pool with `namedPlaceholders: true` and `dateStrings: true`.

**MariaDB is not a drop-in substitute here** — the migration runner relies on MySQL-specific `information_schema`-guarded `ALTER` blocks and MySQL's native `JSON` type. It may work; it is untested by this codebase. Use MySQL.

Non-obvious requirements this project imposes on MySQL:

* **The database must be named `vega_analysis`.** Hard-coded as `USE vega_analysis;` in all six schema files. Setting `DB_NAME` to anything else will make migrations write to `vega_analysis` while the app pool reads from your name.
* **The app user needs `CREATE`** — `schema.sql:5` runs `CREATE DATABASE IF NOT EXISTS` on every boot.
* **The app user needs `PROCESS`** if you intend to use the admin **Backup** button. `backupService.js` invokes `mysqldump` with no `--no-tablespaces` flag; MySQL 8.0.21+ refuses that without `PROCESS` and the backup fails with error 1227.
* **Set the MySQL session/server timezone to IST.** Several queries use MySQL-side `NOW()` / `DATE_ADD(NOW(), …)` (`authController.js` password resets, `adminController.js` live-activity window, `onboardingController.js`), and the code comments in `zerodhaController.js:38-42` and `adminDataController.js:100` explicitly call out the MySQL-local-time assumption. The `node-cron` jobs are separately pinned to `Asia/Kolkata` in `index.js`, so those are safe regardless — this is about MySQL's own clock.

---

### 1.4 MySQL client binaries (`mysqldump`) — **REQUIRED** · database / backup

Included automatically with `mysql-server`. **Only needs a separate install if your DB is on another host.**

```bash
# only if MySQL runs elsewhere (managed DB / separate VPS):
sudo apt install -y mysql-client-core-8.0
```

Why: `server/src/services/backupService.js` runs `execFile('mysqldump', …)` for `POST /api/admin/data/backup` and `GET /api/admin/data/backups/:filename/download`. Without the binary on `PATH`, those endpoints throw `mysqldump not found`. `MYSQLDUMP_PATH` in `.env` can override the location.

---

### 1.5 Nginx — **REQUIRED** · reverse proxy + static frontend + WebSocket

```bash
sudo apt install -y nginx
```

Why it is not optional in this project specifically:

1. **Nothing else serves the SPA.** There is no `express.static` in the backend. Without Nginx, `https://yourdomain.com/` returns nothing.
2. **Same-origin is a hard requirement.** `axios` uses relative `/api`, and `marketSocket.js` builds `wss://<current host>/ws/market`. Serving the SPA from a different host/port than the API breaks both, and the WS URL cannot be reconfigured — it is not read from any env var (the client uses **zero** `import.meta.env` variables; `VITE_API_TARGET` is dev-proxy-only).
3. It terminates TLS, which the browser requires before it will open `wss://`.

Minimum viable vhost — the `/ws/market` block is the part people get wrong:

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    root /var/www/vega/client/dist;
    index index.html;

    # SPA history fallback — /dashboard, /vega-analysis etc. are client routes
    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket. Path is fixed in websocketService.js — do not rename it.
    location /ws/market {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
        proxy_set_header X-Real-IP  $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;   # the feed is idle-quiet outside market hours
        proxy_send_timeout 3600s;
    }
}
```

`proxy_read_timeout` matters: the app's own heartbeat is 30 s (`HEARTBEAT_INTERVAL_MS`), so Nginx's 60 s default would not normally cut it — but raise it anyway so a quiet pre-open session is not dropped.

---

### 1.6 Certbot — **REQUIRED in practice** · SSL

```bash
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/bin/certbot
```
(The snap is the EFF-recommended channel and stays current; `apt install certbot python3-certbot-nginx` also works but lags.)

Why this project needs it rather than merely benefiting from it:

* `marketSocket.js` upgrades to `wss://` **only** when the page is `https:`. On plain HTTP the whole live feed runs unencrypted, JWT-in-query-string included.
* Zerodha's Kite Connect redirect URL should be HTTPS, and it must match `KITE_REDIRECT_URL` character-for-character (`index.js:24-45` shouts about this at boot).
* `localStorage`-held JWTs over plain HTTP on a financial product is not defensible.

---

### 1.7 `ca-certificates` — **REQUIRED** · outbound TLS *(preinstalled on Ubuntu 24.04)*

```bash
sudo apt install -y ca-certificates
```
Why: outbound HTTPS to `api.kite.trade` (instrument master, session exchange) and `wss://ws.kite.trade` (KiteTicker), plus SMTP TLS. Present on every stock Ubuntu image — the command is a no-op safety check.

---

### 1.8 `tzdata` + IST system clock — **REQUIRED** · correctness *(package preinstalled)*

```bash
sudo timedatectl set-timezone Asia/Kolkata
```
Why: keeps MySQL's `NOW()`, the systemd/PM2 log timestamps and the app's IST cron schedules in one frame of reference. See §1.3.

---

## 2. Required for deployment mechanics (pick one path)

### 2.1 Git — **RECOMMENDED** · deployment transport

```bash
sudo apt install -y git
```
Optional in the strict sense — the app never shells out to git. Required if you deploy by `git clone` / `git pull`, which is the sane option given this repo has active branches.

### 2.2 `unzip` — **OPTIONAL** · only if you upload a zip instead

```bash
sudo apt install -y unzip
```
Nothing in the codebase reads or writes zip archives. `exceljs` (the Excel export) generates XLSX entirely in-process — it does **not** need the `unzip` binary.

### 2.3 `curl` — **REQUIRED as an install-time tool**, not a runtime dependency

```bash
sudo apt install -y curl
```
Preinstalled on Ubuntu 24.04. You need it for the NodeSource script in §1.1 and for smoke-testing `/api/health`. The application itself makes its HTTP calls through Node, not curl.

---

## 3. Process management

### 3.1 PM2 — **RECOMMENDED (or systemd)** · process management

```bash
sudo npm install -g pm2
```

Why something is needed: the backend is a foreground process that must survive SSH disconnect, restart on crash, and start on reboot. It also holds the KiteTicker socket, the day's in-memory ring buffers and five cron jobs — an unsupervised crash at 10:15 IST silently stops recording for the rest of the session.

> ### ⚠ Run exactly ONE instance. Never use PM2 cluster mode.
> `pm2 start src/index.js -i max` would be actively destructive here:
> * Kite permits roughly **3 concurrent WebSocket connections per API key** (`index.js` SIGUSR2 comment); each cluster worker opens its own KiteTicker and you get locked out with a 403 that looks like a token problem.
> * All five `node-cron` jobs would fire once **per worker** — duplicate OI baselines, duplicate ATM-IV rows, and the retention `DELETE` racing itself.
> * `latestTicks` and `LIVE_BUFFER_POINTS` are per-process memory; workers would serve divergent data to different browser tabs.
>
> Use fork mode, one instance:
> ```bash
> pm2 start src/index.js --name vega-api --time
> ```

**systemd is a fully valid alternative** and installs nothing extra — a 12-line unit with `Restart=always` covers the same ground. Choose PM2 only if you want `pm2 logs` / `pm2 monit`.

If you use PM2, also install log rotation — `morgan('dev')` logs every request and the logs will grow unbounded:
```bash
pm2 install pm2-logrotate
```

---

## 4. Explicitly NOT required — verified against the code

| Candidate | Verdict | Evidence |
|---|---|---|
| **Docker / docker-compose** | **NOT required** | no Dockerfile, no `.yml`/`.yaml` of any kind in the repo; nothing references container networking or env-var injection patterns |
| **`build-essential`, `g++`, `make`, `python3`, `node-gyp`** | **NOT required** | neither lockfile contains `node-gyp` or `node-pre-gyp`; the only `hasInstallScript` packages are `esbuild` (downloads a prebuilt binary) and `fsevents` (`os: darwin`, skipped on Linux). `bcryptjs` is the pure-JS implementation; `mysql2` is pure JS |
| **Redis / memcached** | **NOT required** | zero references in `server/src` or `client/src`. Only appears in the README's *Phase 6 roadmap* |
| **pnpm / yarn** | **NOT required** | `package-lock.json` in both projects, no pnpm/yarn lockfile |
| **`libcairo`, `libpango`, fonts, `node-canvas`** | **NOT required** | no chart is rendered server-side; `lightweight-charts` and `recharts` run in the browser |
| **Chromium / Puppeteer / Playwright** | **NOT required** | no PDF/screenshot generation anywhere |
| **`ffmpeg`, `imagemagick`** | **NOT required** | no media processing |
| **Cloudflared / a tunnel** | **NOT required in production** | `index.js:35` handles `trycloudflare.com` redirect URLs — that is a *development* convenience. With a real domain + Certbot you point `KITE_REDIRECT_URL` at your own HTTPS host |
| **A separate cron daemon / crontab entries** | **NOT required** | all five scheduled jobs run in-process via `node-cron`, timezone-pinned to `Asia/Kolkata` in `index.js`. They only run while the Node process is alive — one more reason for §3 |
| **Swap file** | **Not needed on 8 GB** | the only memory spike is `vite build` (Rollup), comfortably under 2 GB. Add 2 GB swap only if you deploy to a 1–2 GB plan |

---

## 5. Optional — recommended hardening / operations

| Package | Required? | Why | Command |
|---|---|---|---|
| `ufw` | Optional, strongly advised | Port **5000 must not be publicly reachable** — the API is meant to sit behind Nginx only | `sudo apt install -y ufw` |
| `fail2ban` | Optional | SSH brute-force protection. The app has its own `express-rate-limit` on `/api/auth` (50 req / 15 min) and `/api/public` (120 req/min) | `sudo apt install -y fail2ban` |
| `unattended-upgrades` | Optional | automatic security patches | `sudo apt install -y unattended-upgrades` |
| `htop` | Optional, monitoring | eyeball RSS during market hours | `sudo apt install -y htop` |
| `pm2 install pm2-logrotate` | Recommended, monitoring | `morgan('dev')` is on in production | see §3 |

---

## 6. Capacity check against this VPS

From the project's own `VEGA-CAPACITY-CALCULATION.md`, cross-checked against `vegaConfig.js`:

| Resource | Steady state | Note |
|---|---|---|
| Node RSS | ~250 MB at ~65 concurrent series | dominated by the instrument master (`bySymbol` / `searchIndex` over ~120k contracts) plus `LIVE_BUFFER_POINTS` (4,500 pts × series) |
| MySQL data + index | **~1.85 GB per 30 days** | at `VEGA_RETENTION_DAYS=30` with 5s persistence for both indices and stocks (`PERSIST_RESOLUTION`), recording the 26-symbol universe in `constants/nifty50.js` |
| Peak insert rate | ~292,500 rows/day | the nightly retention cron at 03:30 IST is what keeps this bounded |
| Build-time RAM | < 2 GB | `vite build` only |

Comfortable on a KVM 2-class box (2 vCPU / 8 GB / 100 GB NVMe). Two levers if you ever raise `VEGA_RETENTION_DAYS` or flip `VEGA_RECORD_ALL_STOCKS=1`: disk grows linearly, and the Kite ~3,000-token cap (`TOKEN_BUDGET`) truncates the recorded set before anything breaks.

---

## 7. Firewall / network requirements

| Direction | Port | Purpose | Required |
|---|---|---|---|
| Inbound | 22 | SSH | yes |
| Inbound | 80 | HTTP → redirect + ACME challenge | yes |
| Inbound | 443 | HTTPS + `wss://` | yes |
| Inbound | **5000** | Node API | **NO — must stay closed.** Nginx reaches it over `127.0.0.1` |
| Inbound | 3306 | MySQL | **NO** if MySQL is local (bind to `127.0.0.1`) |
| Outbound | 443 | `api.kite.trade` (REST + instrument CSV) and `ws.kite.trade` (KiteTicker) | yes |
| Outbound | 587 / 465 | SMTP for password-reset email | only if you configure SMTP |

---

## 8. Environment configuration (not a package, but a hard dependency)

`server/.env` — every variable the code actually reads, extracted with `grep -rho "process\.env\.[A-Z_0-9]*" server/src`.

**Required — the app misbehaves or fails without these:**

| Variable | Production value / note |
|---|---|
| `PORT` | `5000` (must match the Nginx `proxy_pass`) |
| `NODE_ENV` | `production` — also silences the DB-connection diagnostic in `config/db.js` |
| `CLIENT_URL` | `https://yourdomain.com` — CORS origin in `app.js` **and** the base for password-reset links in `mailService.js` |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` | your MySQL credentials |
| `DB_NAME` | **must be `vega_analysis`** (see §1.3) |
| `JWT_SECRET` | long random string; also verifies the WebSocket upgrade token |
| `JWT_EXPIRES_IN` | e.g. `7d` |
| `TOKEN_ENCRYPTION_KEY` | **exactly 64 hex characters.** `utils/crypto.js` throws `must be a 32-byte hex string` otherwise, and connecting Zerodha fails. Generate: `openssl rand -hex 32` |
| `KITE_API_KEY` / `KITE_API_SECRET` | from developers.kite.trade |
| `KITE_REDIRECT_URL` | `https://yourdomain.com/api/zerodha/callback` — must match the Kite app field **character for character** (`routes/zerodhaRoutes.js:11`) |
| `ADMIN_WHATSAPP_NUMBER` | digits only, country code, **no** leading `+` (for `wa.me/`) |
| `ADMIN_NAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `seedAdmin.js` runs on every boot; without an admin nothing works, because only an admin can connect Zerodha |

**Optional — sensible defaults apply:**
`ADMIN_RESET_PASSWORD`, `RISK_FREE_RATE`, `OPTION_STRIKE_WINDOW`, `CHAIN_PUSH_INTERVAL_MS`, `ONBOARDING_TOKEN_TTL`, `PUBLIC_VEGA_DELAY_MINUTES`, `PUBLIC_CONTACT_EMAIL`, `PUBLIC_CONTACT_PHONE`, `MYSQLDUMP_PATH`, and the whole `VEGA_*` family (`VEGA_STRIKE_MODE`, `VEGA_RETENTION_DAYS`, `VEGA_INDEX_RESOLUTION`, `VEGA_STOCK_RESOLUTION`, `VEGA_TOKEN_BUDGET`, `VEGA_RECORDED_STOCKS`, `VEGA_RECORD_ALL_STOCKS`, `VEGA_EXPIRY_COUNT`, `VEGA_STOCK_EXPIRY_COUNT`, `VEGA_STOCK_STRIKE_WINDOW`, `VEGA_LIVE_BUFFER_POINTS`, `VEGA_DELTA_MAX`, `VEGA_STOCK_DELTA_START`, `VEGA_STRIKE_HYSTERESIS`, `VEGA_DISPLAY_SIGN`).

**SMTP — currently unset in your local `.env`, and the code fails closed:**
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. Until these are set, `mailService.isConfigured()` returns false and **"Forgot password" is disabled by design** — it refuses rather than letting anyone reset an account without inbox proof (`mailService.js` header comment). Decide before launch whether you want that feature live.

The client needs **no** build-time environment variables — it uses zero `import.meta.env` values, so `client/dist` is environment-independent.

---

## 9. Two code changes to make before you deploy

Not packages, but they are production defects that only appear behind a reverse proxy:

1. **`app.set('trust proxy', 1)` is missing** (`server/src/app.js`). Behind Nginx every request's `req.ip` becomes `127.0.0.1`, so `express-rate-limit` buckets **all** visitors into one counter — 50 login attempts per 15 minutes shared across the whole internet will lock out real users, and the public limiter's 120/min becomes a global cap. Add it immediately after `const app = express();`.

2. **`morgan('dev')` in production** (`app.js`) — dev-formatted, colour-coded, one line per request including every 5-second WebSocket-adjacent poll. Switch to `morgan('combined')` or gate it on `NODE_ENV`, and set up `pm2-logrotate` either way.

Minor, worth noting: `esbuild` is listed as a **production** dependency in `server/package.json` but is never imported anywhere in `server/src`. It costs you a ~10 MB binary download on every deploy. Safe to remove from `dependencies`.

---

## 10. Minimal production install plan

Total: **five** things to install beyond a stock Ubuntu 24.04 image.

| # | Package | Category | Required |
|---|---|---|---|
| 1 | Node.js 22 LTS (NodeSource) — includes npm | backend + frontend build | **Yes** |
| 2 | `mysql-server` — includes `mysqldump` | database + backup | **Yes** |
| 3 | `nginx` | reverse proxy + static frontend + WebSocket | **Yes** |
| 4 | `certbot` (snap) | SSL | **Yes** (for `wss://` and Kite HTTPS redirect) |
| 5 | `git` | deployment transport | Recommended |
| 6 | `pm2` (via npm -g) | process management | Recommended (or use systemd — installs nothing) |

`curl`, `ca-certificates` and `tzdata` are already on the image. `unzip`, Docker, Redis, and build tools are not needed at all.

---

## 11. Exact installation commands, in order, for a fresh Ubuntu 24.04 VPS

Run as a sudo-capable non-root user.

### Step 1 — base system and timezone

```bash
sudo apt update && sudo apt upgrade -y
```

```bash
sudo apt install -y curl ca-certificates git ufw
```

```bash
sudo timedatectl set-timezone Asia/Kolkata
```

### Step 2 — Node.js 22 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
```

```bash
sudo -E bash /tmp/nodesource_setup.sh
```

```bash
sudo apt-get install -y nodejs
```

```bash
node -v && npm -v
```
Expect `v22.x` and `10.x`.

### Step 3 — MySQL 8.0

```bash
sudo apt install -y mysql-server
```

```bash
sudo systemctl enable --now mysql
```

```bash
sudo mysql_secure_installation
```

Create the database and user — **the database name must be `vega_analysis`**:

```bash
sudo mysql -e "CREATE DATABASE IF NOT EXISTS vega_analysis CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER IF NOT EXISTS 'vega'@'localhost' IDENTIFIED BY 'CHANGE_THIS_STRONG_PASSWORD'; GRANT ALL PRIVILEGES ON vega_analysis.* TO 'vega'@'localhost'; GRANT PROCESS ON *.* TO 'vega'@'localhost'; FLUSH PRIVILEGES;"
```
`GRANT PROCESS` is what lets the admin Backup button's `mysqldump` succeed on MySQL 8 (§1.3).

Pin MySQL's clock to IST:

```bash
sudo mysql -e "SET GLOBAL time_zone = '+05:30';"
```

```bash
printf "[mysqld]\ndefault-time-zone='+05:30'\nbind-address=127.0.0.1\n" | sudo tee /etc/mysql/mysql.conf.d/vega.cnf && sudo systemctl restart mysql
```

### Step 4 — Nginx

```bash
sudo apt install -y nginx
```

```bash
sudo systemctl enable --now nginx
```

### Step 5 — PM2

```bash
sudo npm install -g pm2
```

```bash
pm2 install pm2-logrotate
```

### Step 6 — Firewall

```bash
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw --force enable
```
Note that 5000 and 3306 are deliberately absent.

### Step 7 — Get the code

```bash
sudo mkdir -p /var/www && sudo chown -R $USER:$USER /var/www
```

```bash
git clone <your-repo-url> /var/www/vega
```

### Step 8 — Backend

```bash
cd /var/www/vega/server && npm ci --omit=dev
```

Create `/var/www/vega/server/.env` with the values from §8, then lock it down:

```bash
chmod 600 /var/www/vega/server/.env
```

Run migrations explicitly once, so failures are visible rather than swallowed by the boot handler:

```bash
cd /var/www/vega/server && npm run db:migrate
```

### Step 9 — Frontend build

Dev dependencies are needed here — Vite is a devDependency, so **do not** pass `--omit=dev`:

```bash
cd /var/www/vega/client && npm ci
```

```bash
cd /var/www/vega/client && npm run build
```

Optional, reclaims ~250 MB once `dist/` exists:

```bash
rm -rf /var/www/vega/client/node_modules
```

Nginx runs as `www-data` and must be able to traverse to `dist`:

```bash
sudo chmod o+x /var/www /var/www/vega /var/www/vega/client && sudo chmod -R o+rX /var/www/vega/client/dist
```

### Step 10 — Nginx vhost

```bash
sudo nano /etc/nginx/sites-available/vega
```
Paste the vhost from §1.5, replacing `yourdomain.com` and confirming `root /var/www/vega/client/dist;`.

```bash
sudo ln -sf /etc/nginx/sites-available/vega /etc/nginx/sites-enabled/vega && sudo rm -f /etc/nginx/sites-enabled/default
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### Step 11 — SSL

```bash
sudo snap install --classic certbot
```

```bash
sudo ln -sf /snap/bin/certbot /usr/bin/certbot
```

```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

```bash
sudo certbot renew --dry-run
```

### Step 12 — Start the backend under PM2

Single instance, fork mode — see the warning in §3:

```bash
cd /var/www/vega/server && pm2 start src/index.js --name vega-api --time
```

```bash
pm2 save
```

```bash
pm2 startup systemd
```
Run the `sudo env PATH=…` line it prints back to you, then `pm2 save` once more.

### Step 13 — Verify

```bash
curl -s https://yourdomain.com/api/health
```
Expect `{"status":"ok","service":"Vega Analysis API"}`.

```bash
pm2 logs vega-api --lines 60
```
Look for, in order: `[Migrate] Done`, `[DB] MySQL pool connected successfully`, `[Vega Analysis] API + WebSocket server running on port 5000`, the `[Zerodha] Kite app configuration` banner with your **exact** redirect URL, and `[Boot] Startup complete.`

```bash
curl -s "https://yourdomain.com/api/public/vega/NIFTY/delayed-series?timeframe=5m" | head -c 400
```
Exercises the public route and MySQL read path without a login.

Then, in a browser: load the site, log in as the seeded admin, and press **Connect Zerodha**. That must be done **once per trading day** — Kite invalidates access tokens around 07:30 IST and offers no silent refresh (README, and `index.js` cron at 08:00 IST).

---

## 12. One-line answer to each package you asked about

| You asked | Verdict |
|---|---|
| **Node.js — which version?** | Required. **22 LTS.** Hard floor is 18 (`esbuild@0.28.1`, `vite@5`, `rollup@4`). Do not use Ubuntu's default Node 18 package |
| **npm or pnpm?** | **npm**, bundled with Node — nothing to install. pnpm is not required and would discard the committed `package-lock.json` files |
| **PM2?** | Recommended, not strictly required. **Fork mode, one instance only** — cluster mode breaks the Kite connection limit and duplicates every cron. systemd is an equally valid, zero-install alternative |
| **Nginx?** | **Required.** The backend serves no static files, and the frontend hard-requires same-origin `/api` and `/ws/market` |
| **MySQL?** | **Required.** 8.0. Database must be named `vega_analysis`; the app user needs `CREATE` and, for backups, `PROCESS` |
| **Git?** | Recommended, for deployment only. The app never invokes it |
| **unzip?** | **Not required.** Nothing in the code touches zip archives; `exceljs` builds XLSX in-process |
| **curl?** | Required as an install-time tool (NodeSource, health checks). Preinstalled. Not a runtime dependency |
| **Certbot?** | **Required in practice** — `wss://` only engages on HTTPS pages, and Kite's redirect URL should be HTTPS |
| **Build tools?** | **Not required.** Verified zero native modules in both lockfiles: no `node-gyp`, `bcryptjs` and `mysql2` are pure JS, `esbuild`/`rollup` ship prebuilt glibc binaries |
| **Docker?** | **Not required.** No Dockerfile, no compose file, no container assumptions anywhere in the repo |
| **Additional system libraries?** | Only `mysqldump` (comes with `mysql-server`; separate `mysql-client-core-8.0` if the DB is remote), plus `ca-certificates` and `tzdata` — both already on a stock Ubuntu 24.04 image |
