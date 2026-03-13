module.exports = {
  apps: [
    {
      name: 'asystem-api',
      script: './api/server.mjs',
      cwd: '/Users/urmatmyrzabekov/projects/ASYSTEM',
      interpreter: 'node',
      env: {
        HOME: '/Users/urmatmyrzabekov',
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/Users/urmatmyrzabekov/projects/ASYSTEM/api/error.log',
      out_file: '/Users/urmatmyrzabekov/projects/ASYSTEM/api/out.log',
    },
  ],
};
