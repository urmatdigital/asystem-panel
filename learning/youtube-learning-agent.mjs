#!/usr/bin/env node
/**
 * YouTube Learning Agent - Автономное обучение из видео
 * Цикл: Поиск → Анализ → Компрессия → Тест → Внедрение → Метрики
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEARNING_DB = path.join(__dirname, 'learning-db.json');
const PATTERNS_DIR = path.join(__dirname, 'patterns');
const METRICS_DB = path.join(__dirname, 'metrics.json');

// Инициализация
if (!fs.existsSync(PATTERNS_DIR)) fs.mkdirSync(PATTERNS_DIR, { recursive: true });
if (!fs.existsSync(LEARNING_DB)) fs.writeFileSync(LEARNING_DB, JSON.stringify({ videos: [], patterns: [], implementations: [] }, null, 2));
if (!fs.existsSync(METRICS_DB)) fs.writeFileSync(METRICS_DB, JSON.stringify({ tests: [], rollbacks: [], wins: [] }, null, 2));

class YouTubeLearningAgent {
  constructor() {
    this.db = JSON.parse(fs.readFileSync(LEARNING_DB, 'utf8'));
    this.metrics = JSON.parse(fs.readFileSync(METRICS_DB, 'utf8'));
    this.topics = [
      'multi agent orchestration',
      'LLM cost optimization', 
      'autonomous AI systems',
      'self healing infrastructure',
      'token optimization LLM',
      'agent memory systems',
      'production AI deployment'
    ];
  }

  // 1. ПОИСК - найти новые видео по темам
  async searchVideos(topic, limit = 3) {
    console.log(`🔍 Searching: ${topic}`);
    try {
      // Используем yt-dlp для поиска
      const searchQuery = `ytsearch${limit}:${topic} 2024 OR 2025 OR 2026`;
      const cmd = `yt-dlp --get-id --get-title --get-duration '${searchQuery}' 2>/dev/null`;
      const output = execSync(cmd, { encoding: 'utf8' }).trim();
      
      const lines = output.split('\n');
      const videos = [];
      
      for (let i = 0; i < lines.length; i += 3) {
        if (lines[i] && lines[i+1] && lines[i+2]) {
          const title = lines[i];
          const videoId = lines[i+1];
          const duration = parseInt(lines[i+2]) || 0;
          
          // Пропускаем слишком длинные (>45 мин) и уже просмотренные
          if (duration > 2700) continue;
          if (this.db.videos.some(v => v.id === videoId)) continue;
          
          videos.push({ id: videoId, title, duration, topic });
        }
      }
      
      return videos;
    } catch (err) {
      console.error(`❌ Search failed: ${err.message}`);
      return [];
    }
  }

  // 2. АНАЛИЗ - извлечь паттерны из транскрипта
  async analyzeVideo(video) {
    console.log(`📺 Analyzing: ${video.title}`);
    
    try {
      // Получаем транскрипт через yt-dlp
      let transcript;
      try {
        // Сначала пробуем получить автоматические субтитры
        execSync(
          `yt-dlp --quiet --no-warnings --skip-download --write-auto-sub --sub-lang en --sub-format vtt --output "/tmp/${video.id}" "https://youtube.com/watch?v=${video.id}"`,
          { stdio: 'ignore' }
        );
        
        // Читаем и чистим субтитры
        transcript = execSync(
          `cat /tmp/${video.id}.en.vtt 2>/dev/null | sed 's/<[^>]*>//g' | grep -v "^WEBVTT" | grep -v "^$" | grep -v "^[0-9][0-9]:" | head -200`,
          { encoding: 'utf8' }
        ).trim();
        
        // Удаляем временный файл
        try { fs.unlinkSync(`/tmp/${video.id}.en.vtt`); } catch {}
      } catch {
        // Если нет субтитров, пробуем через описание
        try {
          transcript = execSync(
            `yt-dlp --quiet --no-warnings --get-description "https://youtube.com/watch?v=${video.id}" | head -c 2000`,
            { encoding: 'utf8' }
          ).trim();
        } catch {
          transcript = '';
        }
      }
      
      if (!transcript || transcript.length < 100) {
        console.log('⏭️ No useful transcript');
        return null;
      }

      // Компрессия паттернов через LLM
      const prompt = `Extract ONLY actionable patterns from this video transcript. Format:
PROBLEM: [1 sentence]
SOLUTION: [2-3 sentences]
CODE_PATTERN: [if applicable, max 5 lines]
METRICS: [expected improvement]
TAGS: [comma separated]

Transcript: ${transcript.slice(0, 5000)}`;

      const analysis = execSync(
        `echo '${prompt.replace(/'/g, "'\\''")}' | oracle -m anthropic/claude-haiku-4-5 --no-cache 2>/dev/null`,
        { encoding: 'utf8' }
      ).trim();

      const pattern = {
        videoId: video.id,
        videoTitle: video.title,
        topic: video.topic,
        analysis,
        timestamp: new Date().toISOString(),
        tokensSaved: Math.round((transcript.length - analysis.length) / 4), // ~4 chars per token
        status: 'analyzed'
      };

      return pattern;
    } catch (err) {
      console.error(`❌ Analysis failed: ${err.message}`);
      return null;
    }
  }

  // 3. КОМПРЕССИЯ - сохранить только важное
  savePattern(pattern) {
    if (!pattern) return;
    
    // Сохраняем в structured DB
    this.db.patterns.push(pattern);
    this.db.videos.push({ 
      id: pattern.videoId, 
      title: pattern.videoTitle,
      analyzedAt: pattern.timestamp 
    });
    
    // Сохраняем паттерн в отдельный файл
    const filename = `${pattern.videoId}.md`;
    const content = `# ${pattern.videoTitle}\n\n${pattern.analysis}\n\n---\nTokens saved: ${pattern.tokensSaved}`;
    fs.writeFileSync(path.join(PATTERNS_DIR, filename), content);
    
    // Обновляем DB
    fs.writeFileSync(LEARNING_DB, JSON.stringify(this.db, null, 2));
    
    console.log(`✅ Pattern saved: ${pattern.tokensSaved} tokens compressed`);
  }

  // 4. ТЕСТ - проверить применимость паттерна
  async testPattern(pattern) {
    console.log(`🧪 Testing pattern implementation`);
    
    // Создаём тестовый sub-agent для проверки
    const testTask = `Apply this pattern in isolation and validate:
${pattern.analysis}

Create minimal test implementation and report success metrics.`;

    try {
      const result = execSync(
        `echo '${testTask.replace(/'/g, "'\\''")}' | openclaw agent --local --model anthropic/claude-haiku-4-5 --json 2>/dev/null`,
        { encoding: 'utf8', timeout: 60000 }
      );
      
      const success = result.includes('success') || result.includes('implemented');
      
      this.metrics.tests.push({
        patternId: pattern.videoId,
        success,
        timestamp: new Date().toISOString()
      });
      
      fs.writeFileSync(METRICS_DB, JSON.stringify(this.metrics, null, 2));
      
      return success;
    } catch (err) {
      console.error(`❌ Test failed: ${err.message}`);
      return false;
    }
  }

  // 5. ВНЕДРЕНИЕ - применить к системе
  async implementPattern(pattern) {
    if (pattern.status === 'implemented') return;
    
    console.log(`🚀 Implementing pattern system-wide`);
    
    // Добавляем в Inter-Agent Memory для всех агентов
    const sharedMemory = {
      content: pattern.analysis,
      agent: 'learning-agent',
      tags: ['youtube-learning', pattern.topic, 'auto-applied']
    };
    
    try {
      execSync(
        `curl -X POST http://localhost:5190/api/memory/shared -H "Content-Type: application/json" -d '${JSON.stringify(sharedMemory)}' 2>/dev/null`
      );
      
      pattern.status = 'implemented';
      this.db.implementations.push({
        patternId: pattern.videoId,
        timestamp: new Date().toISOString()
      });
      
      fs.writeFileSync(LEARNING_DB, JSON.stringify(this.db, null, 2));
      
      console.log(`✅ Pattern shared with all agents`);
      return true;
    } catch (err) {
      console.error(`❌ Implementation failed: ${err.message}`);
      return false;
    }
  }

  // 6. МЕТРИКИ - отследить эффективность
  calculateROI() {
    const totalTokensSaved = this.db.patterns.reduce((sum, p) => sum + (p.tokensSaved || 0), 0);
    const successRate = this.metrics.tests.filter(t => t.success).length / Math.max(1, this.metrics.tests.length);
    const implementedCount = this.db.implementations.length;
    
    return {
      videosAnalyzed: this.db.videos.length,
      patternsExtracted: this.db.patterns.length,
      patternsImplemented: implementedCount,
      tokensSaved: totalTokensSaved,
      avgCompression: Math.round(totalTokensSaved / Math.max(1, this.db.patterns.length)),
      successRate: Math.round(successRate * 100),
      estimatedMonthlySavings: Math.round(totalTokensSaved * 0.003 * 30) // ~$0.003 per 1K tokens
    };
  }

  // MAIN LOOP - автономный цикл обучения
  async runLearningCycle() {
    console.log('🎓 YouTube Learning Agent - Starting cycle');
    
    // Выбираем случайную тему
    const topic = this.topics[Math.floor(Math.random() * this.topics.length)];
    
    // 1. Поиск новых видео
    const videos = await this.searchVideos(topic, 2);
    
    for (const video of videos) {
      // 2. Анализ
      const pattern = await this.analyzeVideo(video);
      if (!pattern) continue;
      
      // 3. Компрессия
      this.savePattern(pattern);
      
      // 4. Тест
      const testPassed = await this.testPattern(pattern);
      
      // 5. Внедрение (только если тест прошёл)
      if (testPassed) {
        await this.implementPattern(pattern);
      } else {
        console.log('⏭️ Skipping implementation - test failed');
      }
      
      // Пауза между видео
      await new Promise(r => setTimeout(r, 5000));
    }
    
    // 6. Отчёт по метрикам
    const roi = this.calculateROI();
    console.log('\n📊 Learning ROI:', roi);
    
    // Сохраняем отчёт
    fs.writeFileSync(
      path.join(__dirname, 'learning-report.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), ...roi }, null, 2)
    );
    
    return roi;
  }
}

// CLI interface
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const agent = new YouTubeLearningAgent();
  
  const command = process.argv[2];
  
  switch(command) {
    case 'cycle':
      agent.runLearningCycle();
      break;
      
    case 'search':
      const topic = process.argv[3] || 'multi agent orchestration';
      agent.searchVideos(topic, 5).then(videos => {
        console.log('Found videos:', videos);
      });
      break;
      
    case 'metrics':
      console.log('📊 Current metrics:', agent.calculateROI());
      break;
      
    case 'continuous':
      // Запускаем каждые 2 часа
      console.log('🔄 Starting continuous learning mode (every 2 hours)');
      agent.runLearningCycle();
      setInterval(() => agent.runLearningCycle(), 2 * 60 * 60 * 1000);
      break;
      
    default:
      console.log(`Usage:
  node youtube-learning-agent.mjs cycle      # Run one learning cycle
  node youtube-learning-agent.mjs search <topic>  # Search videos
  node youtube-learning-agent.mjs metrics    # Show ROI metrics  
  node youtube-learning-agent.mjs continuous # Run every 2 hours`);
  }
}

export default YouTubeLearningAgent;