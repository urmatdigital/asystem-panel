/**
 * Learning API - эндпоинты для YouTube Learning Agent
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEARNING_DIR = path.join(__dirname, '../learning');
const LEARNING_DB = path.join(LEARNING_DIR, 'learning-db.json');
const METRICS_DB = path.join(LEARNING_DIR, 'metrics.json');
const PATTERNS_DIR = path.join(LEARNING_DIR, 'patterns');

// Проверка наличия файлов
function ensureFiles() {
  if (!fs.existsSync(LEARNING_DB)) {
    fs.writeFileSync(LEARNING_DB, JSON.stringify({ videos: [], patterns: [], implementations: [] }, null, 2));
  }
  if (!fs.existsSync(METRICS_DB)) {
    fs.writeFileSync(METRICS_DB, JSON.stringify({ tests: [], rollbacks: [], wins: [] }, null, 2));
  }
}

export function registerLearningEndpoints(server, requestHandler) {
  // GET /api/learning/status - общий статус обучения
  requestHandler.register('GET', '/api/learning/status', async (req, res) => {
    ensureFiles();
    
    try {
      const db = JSON.parse(fs.readFileSync(LEARNING_DB, 'utf8'));
      const metrics = JSON.parse(fs.readFileSync(METRICS_DB, 'utf8'));
      
      // Расчёт метрик
      const totalTokensSaved = db.patterns.reduce((sum, p) => sum + (p.tokensSaved || 0), 0);
      const successRate = metrics.tests.filter(t => t.success).length / Math.max(1, metrics.tests.length);
      
      // Последние паттерны
      const recentPatterns = db.patterns
        .slice(-5)
        .map(p => ({
          videoId: p.videoId,
          title: p.videoTitle,
          topic: p.topic,
          tokensSaved: p.tokensSaved,
          status: p.status,
          timestamp: p.timestamp
        }));
      
      const status = {
        stats: {
          videosAnalyzed: db.videos.length,
          patternsExtracted: db.patterns.length,
          patternsImplemented: db.implementations.length,
          totalTokensSaved,
          avgCompressionRatio: Math.round(totalTokensSaved / Math.max(1, db.patterns.length)),
          successRate: Math.round(successRate * 100),
          estimatedMonthlySavingsUSD: Math.round(totalTokensSaved * 0.003 * 30)
        },
        recentPatterns,
        lastRun: db.patterns[db.patterns.length - 1]?.timestamp || null,
        isRunning: false // TODO: check PM2 status
      };
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...status }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });

  // GET /api/learning/patterns - все извлечённые паттерны
  requestHandler.register('GET', '/api/learning/patterns', async (req, res) => {
    ensureFiles();
    
    try {
      const db = JSON.parse(fs.readFileSync(LEARNING_DB, 'utf8'));
      
      // Фильтрация по топику если указан
      const url = new URL(req.url, `http://${req.headers.host}`);
      const topic = url.searchParams.get('topic');
      const limit = parseInt(url.searchParams.get('limit')) || 50;
      
      let patterns = db.patterns;
      if (topic) {
        patterns = patterns.filter(p => p.topic === topic);
      }
      
      // Последние N паттернов
      patterns = patterns.slice(-limit);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, patterns, count: patterns.length }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });

  // GET /api/learning/pattern/:id - конкретный паттерн с полным анализом
  requestHandler.register('GET', '/api/learning/pattern/:id', async (req, res, params) => {
    const patternFile = path.join(PATTERNS_DIR, `${params.id}.md`);
    
    if (!fs.existsSync(patternFile)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Pattern not found' }));
      return;
    }
    
    try {
      const content = fs.readFileSync(patternFile, 'utf8');
      const db = JSON.parse(fs.readFileSync(LEARNING_DB, 'utf8'));
      const pattern = db.patterns.find(p => p.videoId === params.id);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        ok: true, 
        pattern,
        content,
        implemented: db.implementations.some(i => i.patternId === params.id)
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });

  // POST /api/learning/trigger - запустить цикл обучения вручную
  requestHandler.register('POST', '/api/learning/trigger', async (req, res) => {
    try {
      const { execSync } = await import('child_process');
      
      // Запускаем асинхронно
      execSync('cd ~/projects/ASYSTEM/learning && node youtube-learning-agent.mjs cycle > /tmp/learning-cycle.log 2>&1 &');
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        ok: true, 
        message: 'Learning cycle triggered',
        logPath: '/tmp/learning-cycle.log'
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });

  // POST /api/learning/implement/:id - применить конкретный паттерн
  requestHandler.register('POST', '/api/learning/implement/:id', async (req, res, params) => {
    ensureFiles();
    
    try {
      const db = JSON.parse(fs.readFileSync(LEARNING_DB, 'utf8'));
      const pattern = db.patterns.find(p => p.videoId === params.id);
      
      if (!pattern) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Pattern not found' }));
        return;
      }
      
      if (pattern.status === 'implemented') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Already implemented' }));
        return;
      }
      
      // Добавляем в shared memory
      const { execSync } = await import('child_process');
      const sharedMemory = {
        content: pattern.analysis,
        agent: 'learning-agent-manual',
        tags: ['youtube-learning', pattern.topic, 'manually-applied']
      };
      
      execSync(
        `curl -X POST http://localhost:5190/api/memory/shared -H "Content-Type: application/json" -d '${JSON.stringify(sharedMemory)}' 2>/dev/null`
      );
      
      // Обновляем статус
      pattern.status = 'implemented';
      db.implementations.push({
        patternId: pattern.videoId,
        timestamp: new Date().toISOString(),
        manual: true
      });
      
      fs.writeFileSync(LEARNING_DB, JSON.stringify(db, null, 2));
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Pattern implemented successfully' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });

  // GET /api/learning/topics - список топиков для поиска
  requestHandler.register('GET', '/api/learning/topics', async (req, res) => {
    const topics = [
      { id: 'multi-agent', name: 'Multi-Agent Orchestration', priority: 'high' },
      { id: 'cost-opt', name: 'LLM Cost Optimization', priority: 'critical' },
      { id: 'autonomous', name: 'Autonomous AI Systems', priority: 'high' },
      { id: 'self-healing', name: 'Self-Healing Infrastructure', priority: 'medium' },
      { id: 'token-opt', name: 'Token Optimization', priority: 'critical' },
      { id: 'memory', name: 'Agent Memory Systems', priority: 'high' },
      { id: 'production', name: 'Production AI Deployment', priority: 'medium' }
    ];
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, topics }));
  });

  console.log('✅ Learning API endpoints registered');
}

// Export for testing
export function getLearningStats() {
  ensureFiles();
  
  try {
    const db = JSON.parse(fs.readFileSync(LEARNING_DB, 'utf8'));
    const metrics = JSON.parse(fs.readFileSync(METRICS_DB, 'utf8'));
    
    const totalTokensSaved = db.patterns.reduce((sum, p) => sum + (p.tokensSaved || 0), 0);
    
    return {
      videos: db.videos.length,
      patterns: db.patterns.length,
      implemented: db.implementations.length,
      tokensSaved: totalTokensSaved
    };
  } catch {
    return { videos: 0, patterns: 0, implemented: 0, tokensSaved: 0 };
  }
}