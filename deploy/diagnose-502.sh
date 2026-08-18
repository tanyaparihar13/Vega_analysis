#!/usr/bin/env bash
#
# Vega Analysis — 502 Bad Gateway root-cause script.
#
#   sudo bash deploy/diagnose-502.sh
#
# READ ONLY. It starts nothing, restarts nothing and changes nothing. Restarting
# the server is how a 502 gets hidden for a day; this is how it gets diagnosed.
#
# A 502 from Nginx with the SPA still loading means exactly one thing: Nginx is
# healthy and nothing is listening on the port it proxies to. Everything below
# narrows down why.
#
# No secret is ever printed. Environment variables are reported as
# "SET (value hidden)" or "MISSING".

set -uo pipefail

PORT="${PORT:-5000}"
APP_DIR="${APP_DIR:-/var/www/vega-analysis}"
ENV_FILE="$APP_DIR/server/.env"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[32mOK\033[0m    %s\n' "$*"; }
fail()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; }
warn()  { printf '  \033[33mWARN\033[0m  %s\n' "$*"; }
info()  { printf '        %s\n' "$*"; }
head()  { printf '\n\033[1m── %s ─────────────────────────────────────────\033[0m\n' "$*"; }

bold ""
bold "Vega Analysis — 502 diagnosis   ($(date -Is))"

# ---------------------------------------------------------------- 1. the port
head "1. Is anything listening on :$PORT ?"
LISTENER="$(ss -ltnp 2>/dev/null | grep -E ":$PORT\b" || true)"
if [ -n "$LISTENER" ]; then
  ok "something is listening on :$PORT"
  info "$LISTENER"
  PORT_UP=1
else
  fail "NOTHING is listening on :$PORT — this is the direct cause of the 502"
  PORT_UP=0
fi

# ------------------------------------------------------------ 2. the process
head "2. The Node process"
if command -v pm2 >/dev/null 2>&1; then
  info "$(pm2 jlist 2>/dev/null | node -e '
    let raw="";process.stdin.on("data",d=>raw+=d).on("end",()=>{
      try{const l=JSON.parse(raw);
        if(!l.length) return console.log("pm2 has NO processes registered");
        for(const p of l) console.log(`pm2: ${p.name}  status=${p.pm2_env.status}  restarts=${p.pm2_env.restart_time}  uptime=${p.pm2_env.pm_uptime?new Date(p.pm2_env.pm_uptime).toISOString():"-"}`);
      }catch(e){console.log("pm2 jlist unreadable");}
    });' 2>/dev/null || echo 'pm2 present but not readable as this user')"
  RESTARTS="$(pm2 jlist 2>/dev/null | grep -o '"restart_time":[0-9]*' | head -1 | cut -d: -f2 || echo 0)"
  if [ "${RESTARTS:-0}" -gt 20 ]; then
    fail "restart_time=$RESTARTS — this is a CRASH LOOP, not a one-off. Read the logs in section 6."
  fi
else
  info "pm2 not installed — checking systemd"
  systemctl is-active --quiet vega-api 2>/dev/null \
    && ok "systemd unit vega-api is active" \
    || warn "systemd unit vega-api is not active (or does not exist)"
fi

pgrep -af "node .*src/index.js" >/dev/null 2>&1 \
  && ok "a node src/index.js process exists" \
  || fail "NO node src/index.js process is running"

# ---------------------------------------------------------------- 3. nginx
head "3. Nginx"
systemctl is-active --quiet nginx && ok "nginx is active" || fail "nginx is NOT active"
nginx -t >/dev/null 2>&1 && ok "nginx config is valid" || { fail "nginx config is INVALID:"; nginx -t 2>&1 | sed 's/^/        /'; }

UPSTREAM="$(grep -rhoE 'proxy_pass +https?://[^;]+' /etc/nginx/sites-enabled/ 2>/dev/null | sort -u || true)"
if [ -n "$UPSTREAM" ]; then
  info "proxy_pass targets found:"
  echo "$UPSTREAM" | sed 's/^/        /'
  echo "$UPSTREAM" | grep -q "127.0.0.1:$PORT" \
    && ok "nginx proxies to 127.0.0.1:$PORT, matching PORT" \
    || fail "nginx does NOT proxy to 127.0.0.1:$PORT — PORT and proxy_pass disagree"
else
  warn "no proxy_pass directive found under /etc/nginx/sites-enabled/"
fi

# ------------------------------------------------------------------ 4. MySQL
head "4. MySQL"
systemctl is-active --quiet mysql 2>/dev/null || systemctl is-active --quiet mariadb 2>/dev/null \
  && ok "the database service is active" \
  || fail "MySQL/MariaDB is NOT active — migrations and seedAdmin will fail (the API still boots)"

# ------------------------------------------------------- 5. environment file
head "5. Environment (values never printed)"
if [ -f "$ENV_FILE" ]; then
  ok "$ENV_FILE exists"
  for k in PORT NODE_ENV DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME JWT_SECRET \
           KITE_API_KEY KITE_API_SECRET KITE_REDIRECT_URL TOKEN_ENCRYPTION_KEY CLIENT_URL; do
    if grep -qE "^${k}=.+" "$ENV_FILE" 2>/dev/null; then
      printf '  \033[32mSET\033[0m   %s — SECRET FOUND, VALUE HIDDEN\n' "$k"
    else
      printf '  \033[31mMISSING\033[0m %s\n' "$k"
    fi
  done
  ENV_PORT="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2 | tr -d '[:space:]' || true)"
  if [ -n "${ENV_PORT:-}" ] && [ "$ENV_PORT" != "$PORT" ]; then
    fail "PORT in .env is $ENV_PORT but this script is checking $PORT — and nginx proxies to one of them"
  fi
else
  fail "$ENV_FILE NOT FOUND — the app will start with no DB credentials and no JWT secret"
fi

# ---------------------------------------------------------------- 6. the logs
head "6. Last 40 log lines (the actual reason)"
if command -v pm2 >/dev/null 2>&1 && pm2 jlist >/dev/null 2>&1; then
  pm2 logs --nostream --lines 40 2>/dev/null | sed 's/^/        /' || info "pm2 logs unavailable"
else
  journalctl -u vega-api -n 40 --no-pager 2>/dev/null | sed 's/^/        /' || info "no journal for vega-api"
fi

# ------------------------------------------------------------- 7. live probes
head "7. Live probes"
LOCAL="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/api/health" || echo 000)"
if [ "$LOCAL" = "200" ]; then
  ok "127.0.0.1:$PORT/api/health -> 200 (the backend is UP; the problem is between nginx and it)"
else
  fail "127.0.0.1:$PORT/api/health -> $LOCAL (the backend is DOWN or not answering)"
fi
info "public /            -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://vegaanalysis.com/ || echo 000)"
info "public /api/health  -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://vegaanalysis.com/api/health || echo 000)"

# ----------------------------------------------------------------- verdict
head "Verdict"
if [ "$PORT_UP" = "0" ]; then
  cat <<'TXT'
  The Node process is not listening. In order of likelihood:

    a) it crashed and the supervisor gave up  -> section 6 has the stack
    b) it is crash-looping                    -> restart_time in section 2
    c) it was never started after a reboot    -> `pm2 startup` / `systemctl enable`
    d) it exited during boot                  -> section 6; with the current
       index.js the port binds FIRST, so a boot-time exit now means the bind
       itself failed (EADDRINUSE, or another copy already running)

  Start it in the FOREGROUND to see the real error, rather than restarting
  under the supervisor where the output is swallowed:

      cd /var/www/vega-analysis/server && node src/index.js
TXT
else
  cat <<'TXT'
  The port is bound. If the public URL still 502s, the fault is between Nginx
  and the app: check that proxy_pass matches PORT (section 3), that SELinux or
  a firewall is not blocking the loopback connection, and that the Nginx vhost
  actually being served is the one you edited.
TXT
fi
echo
