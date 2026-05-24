module.exports = {
  apps: [{
    name: 'bubble',
    script: 'dist/index.js',
    args: '--serve',
    cwd: '/opt/bubble-agent-os',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
    },
    max_memory_restart: '1.5G',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: '/opt/bubble-agent-os/logs/bubble-error.log',
    out_file: '/opt/bubble-agent-os/logs/bubble-out.log',
    merge_logs: true,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
  }]
}
