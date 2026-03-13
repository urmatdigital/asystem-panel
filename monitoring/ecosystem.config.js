module.exports = {
  apps: [
    {
      name: 'server-monitor',
      script: './simple-monitor.mjs',
      args: '300', // Check every 5 minutes
      cwd: '/Users/urmatmyrzabekov/projects/ASYSTEM/monitoring',
      interpreter: '/opt/homebrew/bin/node',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '100M',
      env: {
        NODE_ENV: 'production'
      },
      error_file: '/Users/urmatmyrzabekov/.openclaw/logs/server-monitor-error.log',
      out_file: '/Users/urmatmyrzabekov/.openclaw/logs/server-monitor.log',
      time: true
    }
  ]
};