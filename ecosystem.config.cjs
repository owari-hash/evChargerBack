/**
 * PM2 process definition for the OCPP 1.6J Central System.
 *
 *   pm2 start ecosystem.config.cjs --env production
 *
 * IMPORTANT: single instance, fork mode. Live charge point WebSockets, the call
 * queue and the SSE event bus all live in this process's memory, so a second
 * worker would only see half the charge points and REST commands would hit the
 * wrong one. Scale vertically, not with `instances: 'max'`.
 */
module.exports = {
  apps: [
    {
      name: 'csms',
      script: 'dist/src/index.js',
      cwd: __dirname, // dotenv resolves .env from the working directory
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      max_memory_restart: '512M',
      // index.ts closes sockets and Mongo on SIGINT, then exits within 10 s.
      kill_timeout: 12000,
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/csms.out.log',
      error_file: './logs/csms.err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
