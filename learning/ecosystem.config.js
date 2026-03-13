module.exports = {
  apps: [
    {
      name: 'youtube-learner',
      script: './youtube-learning-agent.mjs',
      args: 'continuous',
      cwd: '/Users/urmatmyrzabekov/projects/ASYSTEM/learning',
      interpreter: '/opt/homebrew/bin/node',
      env: {
        NODE_ENV: 'production',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY
      },
      max_memory_restart: '500M',
      cron_restart: '0 */6 * * *', // Рестарт каждые 6 часов для очистки памяти
      error_file: '/Users/urmatmyrzabekov/.openclaw/logs/youtube-learner-error.log',
      out_file: '/Users/urmatmyrzabekov/.openclaw/logs/youtube-learner.log',
      time: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    }
  ]
};