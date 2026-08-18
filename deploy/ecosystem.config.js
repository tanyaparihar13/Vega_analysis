/**
 * PM2 process definition — the ONE supported way to run this backend.
 *
 *   pm2 start deploy/ecosystem.config.js
 *   pm2 save && pm2 startup     # survive a reboot
 *
 * ⚠ EXACTLY ONE INSTANCE. NEVER cluster mode.
 *
 * The backend holds long-lived, process-local state that cannot be sharded:
 *   · one KiteTicker WebSocket (Kite allows 3 connections per API key TOTAL,
 *     and ~3,000 instrument tokens per connection)
 *   · the in-memory latestTicks map every chain and every Greek is built from
 *   · the live vega ring buffers and the immutable day-open baselines
 *   · five in-process cron jobs, including the 5-second sampler
 *
 * `instances: 'max'` would give each worker its own ticker (blowing the
 * 3-connection limit), its own divergent tick cache, and N copies of every cron
 * writing the same rows. `exec_mode: 'fork'` and `instances: 1` are load-bearing.
 */
module.exports = {
  apps: [{
    name: 'vega-api',
    script: 'src/index.js',
    cwd: '/var/www/vega-analysis/server',

    instances: 1,
    exec_mode: 'fork',

    // Restart on crash, but back off rather than hammering a broken config.
    autorestart: true,
    max_restarts: 10,
    min_uptime: '30s',
    restart_delay: 5000,

    // The sampler holds ~15 option chains plus the tick cache. 700M is roughly
    // 3x the observed steady state, so hitting it means a genuine leak rather
    // than normal growth.
    max_memory_restart: '700M',

    env: {
      NODE_ENV: 'production',
      // Everything else comes from server/.env, which is NOT in version control.
      // Do not put secrets in this file.
      TZ: 'Asia/Kolkata',
    },

    time: true,
    merge_logs: true,
    error_file: '/var/log/vega/api-error.log',
    out_file: '/var/log/vega/api-out.log',
  }],
};
