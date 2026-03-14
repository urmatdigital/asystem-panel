#!/usr/bin/env node
/**
 * YouTube Learning Agent v2 — Deep Single-Video Learning
 * 
 * Один цикл = одно видео = глубокое изучение:
 * 1. Найти 1 новое видео по теме
 * 2. Скачать ПОЛНЫЙ транскрипт (без обрезки)
 * 3. Многоуровневый анализ: проблема → решение → код → метрики → применение
 * 4. Записать в Qdrant + файл
 * 5. Отправить краткий отчёт в Telegram
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEARNING_DB   = path.join(__dirname, 'learning-db.json');
const PATTERNS_DIR  = path.join(__dirname, 'patterns');
const LOG_FILE      = path.join(process.env.HOME, '.openclaw/logs/youtube-learner.log');

if (!fs.existsSync(PATTERNS_DIR)) fs.mkdirSync(PATTERNS_DIR, { recursive: true });
if (!fs.existsSync(LEARNING_DB))  fs.writeFileSync(LEARNING_DB, JSON.stringify({ videos: [], patterns: [] }, null, 2));

const OPENAI_KEY = (() => {
  try { return execSync(`grep OPENAI_API_KEY $HOME/.openclaw/workspace/.env | tail -1 | cut -d= -f2`, { encoding: 'utf8' }).trim(); }
  catch { return process.env.OPENAI_API_KEY || ''; }
})();

function log(msg) {
  const line = `[${new Date().toISOString().slice(0,19).replace('T',' ')}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// Темы для поиска (из видео b12LMts3pHk: Context Engineering фреймворк)
const TOPICS = [
  'context engineering AI agents 2025',
  'multi agent orchestration production',
  'LLM cost optimization techniques',
  'autonomous AI systems patterns',
  'self healing infrastructure AI',
  'agent memory systems Qdrant vector',
  'Claude Code workflow best practices',
  'MCP model context protocol tutorial',
  'RAG retrieval augmented generation production',
  'AI agent task automation 2025',
];

class DeepLearningAgent {
  constructor() {
    this.db = JSON.parse(fs.readFileSync(LEARNING_DB, 'utf8'));
  }

  save() {
    fs.writeFileSync(LEARNING_DB, JSON.stringify(this.db, null, 2));
  }

  // Уже просмотренные видео
  seenIds() {
    return new Set(this.db.videos.map(v => v.id));
  }

  // Выбор темы: из Convex активных задач или ротация
  async chooseTopic() {
    try {
      const res = execSync(
        `curl -s --max-time 6 "https://expert-dachshund-299.convex.site/agent/tasks/list"`,
        { encoding: 'utf8', timeout: 8000 }
      );
      const data = JSON.parse(res);
      const active = (data.tasks || []).filter(t => t.status === 'todo' || t.status === 'in_progress');
      if (active.length > 0) {
        const task = active[Math.floor(Math.random() * Math.min(3, active.length))];
        const title = (task.title || '').toLowerCase();
        if (title.includes('qdrant') || title.includes('memory'))  return 'agent memory systems vector database 2025';
        if (title.includes('dispatch') || title.includes('agent')) return 'multi agent orchestration patterns 2025';
        if (title.includes('react') || title.includes('frontend')) return 'React AI integration best practices 2025';
        if (title.includes('cost') || title.includes('token'))     return 'LLM cost optimization production 2025';
        return `${task.title.split(' ').slice(0, 5).join(' ')} AI 2025`;
      }
    } catch {}
    // Ротация по индексу дня
    const idx = new Date().getDate() % TOPICS.length;
    return TOPICS[idx];
  }

  // 1. Найти одно новое видео (не просмотренное)
  async findVideo(topic) {
    log(`🔍 Тема: "${topic}"`);
    const seen = this.seenIds();

    // Пробуем до 5 видео пока не найдём непросмотренное
    const query = `ytsearch5:${topic}`;
    const lines = execSync(
      `yt-dlp --get-id --get-title --get-duration '${query}' 2>/dev/null`,
      { encoding: 'utf8', timeout: 30000 }
    ).trim().split('\n');

    for (let i = 0; i < lines.length; i += 3) {
      const title = lines[i]?.trim();
      const id    = lines[i+1]?.trim();
      const dur   = parseInt(lines[i+2]) || 0;

      if (!id || !title) continue;
      if (seen.has(id)) { log(`⏭  Уже смотрели: ${title.slice(0,50)}`); continue; }
      if (dur > 3600)   { log(`⏭  Слишком длинное (${Math.round(dur/60)}мин): ${title.slice(0,50)}`); continue; }
      // duration check removed

      log(`🎬 Выбрано: "${title}" (${Math.round(dur/60)}мин)`);
      return { id, title, duration: dur, topic, url: `https://youtube.com/watch?v=${id}` };
    }
    return null;
  }

  // 2. Скачать ПОЛНЫЙ транскрипт
  async getTranscript(video) {
    log(`📄 Скачиваю транскрипт...`);
    const tmp = `/tmp/yt-${video.id}`;

    try {
      // Автоматические субтитры
      execSync(
        `yt-dlp --quiet --no-warnings --skip-download --write-auto-sub --sub-lang en --sub-format vtt -o "${tmp}" "${video.url}" 2>/dev/null`,
        { timeout: 60000 }
      );
      const vttFile = `${tmp}.en.vtt`;
      if (fs.existsSync(vttFile)) {
        // Чистим VTT → чистый текст (убираем теги, временные метки, дубликаты)
        const raw = fs.readFileSync(vttFile, 'utf8');
        try { fs.unlinkSync(vttFile); } catch {}

        const lines = raw.split('\n')
          .filter(l => l.trim())
          .filter(l => !l.startsWith('WEBVTT'))
          .filter(l => !/^\d{2}:\d{2}/.test(l))           // убрать таймкоды
          .filter(l => !/^[0-9]+$/.test(l.trim()))          // убрать числа
          .map(l => l.replace(/<[^>]+>/g, '').trim())       // убрать HTML теги
          .filter(Boolean);

        // Дедупликация соседних строк
        const deduped = lines.filter((l, i) => i === 0 || l !== lines[i - 1]);
        const transcript = deduped.join(' ').replace(/\s+/g, ' ').trim();

        if (transcript.length > 500) {
          log(`✅ Транскрипт: ${transcript.length} символов (~${Math.round(transcript.length/4)} токенов)`);
          return transcript;
        }
      }
    } catch (e) {
      log(`⚠️  VTT failed: ${e.message.slice(0,80)}`);
    }

    // Fallback: описание
    try {
      const desc = execSync(
        `yt-dlp --quiet --no-warnings --get-description "${video.url}" 2>/dev/null`,
        { encoding: 'utf8', timeout: 15000 }
      ).trim();
      if (desc.length > 200) {
        log(`📝 Используем описание (${desc.length} символов)`);
        return desc;
      }
    } catch {}

    return null;
  }

  // 3. Глубокий анализ — многоуровневый промпт
  async deepAnalyze(video, transcript) {
    log(`🧠 Глубокий анализ...`);

    // Используем ПОЛНЫЙ транскрипт (до 15000 символов)
    const fullText = transcript.slice(0, 15000);
    const wordCount = fullText.split(' ').length;
    log(`   Анализирую ${wordCount} слов из транскрипта`);

    const prompt = `You are an expert AI systems architect analyzing a technical video.

VIDEO: "${video.title}"
TOPIC: ${video.topic}
TRANSCRIPT (${wordCount} words):
${fullText}

Provide a DEEP analysis in this exact format:

## CORE PROBLEM
[2-3 sentences: what problem does this video address?]

## KEY INSIGHT  
[The single most important idea from this video in 1-2 sentences]

## SOLUTION APPROACH
[3-5 sentences: how does the speaker solve the problem?]

## ACTIONABLE STEPS
1. [First concrete step]
2. [Second concrete step]
3. [Third concrete step]
(up to 5 steps)

## CODE PATTERN
\`\`\`
[If code was shown or implied, write the key pattern in <15 lines. If no code, write "N/A"]
\`\`\`

## METRICS & RESULTS
[What improvement/result was demonstrated or promised? Be specific with numbers if available]

## APPLY TO ASYSTEM
[2-3 sentences: how exactly can Forge apply this to ASYSTEM infrastructure/panel/agents?]

## TAGS
[5-8 comma-separated tags]`;

    const tmpFile = `/tmp/yt-deep-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, prompt);

    try {
      // Используем /api/chat/forge (openclaw gateway → Anthropic)
      try { fs.unlinkSync(tmpFile); } catch {}
      const chatResp = execSync(
        `curl -s -X POST http://localhost:5190/api/chat/forge ` +
        `-H "Content-Type: application/json" ` +
        `-H "Authorization: Bearer 5f91b3b7171a9a2af12231b7c6bb3701b039a37a77a7d40e" ` +
        `-d ${JSON.stringify(JSON.stringify({message: prompt, stream: false}))} 2>/dev/null`,
        { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 }
      );
      // Парсим SSE: ищем done event с reply
      const doneMatch = chatResp.match(/"done":true.*?"reply":"(.*?)","agent"/);
      const analysis = doneMatch 
        ? doneMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
        : chatResp.split('\n').filter(l => l.includes('"text"') && !l.includes('connecting')).map(l => {
            try { return JSON.parse(l.replace('data: ','')).text || ''; } catch { return ''; }
          }).join('').trim();

      log(`✅ Анализ: ${analysis.length} символов`);
      return analysis;
    } catch (e) {
      try { fs.unlinkSync(tmpFile); } catch {}
      log(`❌ Анализ failed: ${e.message.slice(0, 100)}`);
      return null;
    }
  }

  // 4. Сохранить в Qdrant + файл
  async saveResult(video, transcript, analysis) {
    const pattern = {
      videoId:    video.id,
      videoTitle: video.title,
      videoUrl:   video.url,
      topic:      video.topic,
      duration:   video.duration,
      analysis,
      transcriptLength: transcript.length,
      analyzedAt: new Date().toISOString(),
    };

    // Файл паттерна
    const filename = path.join(PATTERNS_DIR, `${video.id}.md`);
    fs.writeFileSync(filename, `# ${video.title}\n\nURL: ${video.url}\nТема: ${video.topic}\nДата: ${new Date().toISOString().slice(0,10)}\n\n${analysis}`);
    log(`📁 Сохранено: patterns/${video.id}.md`);

    // DB
    this.db.videos.push({ id: video.id, title: video.title, analyzedAt: pattern.analyzedAt });
    this.db.patterns.push(pattern);
    this.save();

    // Qdrant
    try {
      const content = `[${video.topic}] ${video.title}\n\n${analysis}`;
      const tmpQ = `/tmp/qdrant-content-${Date.now()}.txt`;
      fs.writeFileSync(tmpQ, content);
      execSync(
        `OPENAI_API_KEY=${OPENAI_KEY} python3 $HOME/.openclaw/workspace/scripts/memory_write.py ` +
        `--content "$(cat ${tmpQ})" ` +
        `--type pattern --tags "youtube,learning,${video.topic.replace(/\s+/g,'-').slice(0,30)}" 2>/dev/null`,
        { encoding: 'utf8', timeout: 25000 }
      );
      try { fs.unlinkSync(tmpQ); } catch {}
      log(`🔍 Qdrant: паттерн сохранён`);
    } catch (e) {
      log(`⚠️  Qdrant skip: ${e.message.slice(0,50)}`);
    }

    return pattern;
  }

  // 5. Отправить краткий отчёт в Telegram
  async sendReport(video, analysis) {
    const lines = analysis.split('\n');
    const insightLine = lines.find(l => l.startsWith('## KEY INSIGHT')) ;
    const insightIdx = lines.indexOf(insightLine);
    const insight = insightIdx >= 0
      ? lines.slice(insightIdx + 1, insightIdx + 3).join(' ').trim()
      : analysis.slice(0, 200);

    const applyLine = lines.find(l => l.startsWith('## APPLY TO ASYSTEM'));
    const applyIdx = lines.indexOf(applyLine);
    const apply = applyIdx >= 0
      ? lines.slice(applyIdx + 1, applyIdx + 3).join(' ').trim()
      : '';

    const msg = `🎓 *YouTube Learning*\n\n` +
      `📺 [${video.title.slice(0,60)}](${video.url})\n` +
      `⏱ ${Math.round(video.duration/60)}мин | тема: ${video.topic}\n\n` +
      `💡 *Инсайт:* ${insight.slice(0, 300)}\n\n` +
      (apply ? `🔧 *Для ASYSTEM:* ${apply.slice(0, 200)}` : '');

    try {
      execSync(
        `curl -s -X POST "https://api.telegram.org/bot8465084666:AAGAoSMxdzkSc5m39ItRX2VaSrmYFidxSSo/sendMessage" ` +
        `-H "Content-Type: application/json" ` +
        `-d '{"chat_id":"861276843","text":${JSON.stringify(msg)},"parse_mode":"Markdown","disable_web_page_preview":true}' 2>/dev/null`,
        { timeout: 10000 }
      );
      log(`📱 Отчёт отправлен в Telegram`);
    } catch {}
  }

  // ГЛАВНЫЙ ЦИКЛ — одно видео, глубокое изучение
  async runCycle() {
    const startTime = Date.now();
    log(`\n${'='.repeat(60)}`);
    log(`🎓 YouTube Deep Learning — старт цикла`);
    log(`Видео в базе: ${this.db.videos.length} | Паттернов: ${this.db.patterns.length}`);

    try {
      // 1. Выбрать тему
      const topic = await this.chooseTopic();

      // 2. Найти одно видео
      const video = await this.findVideo(topic);
      if (!video) {
        log(`❌ Не найдено новых видео по теме "${topic}"`);
        return;
      }

      // 3. Транскрипт
      const transcript = await this.getTranscript(video);
      if (!transcript) {
        log(`❌ Нет транскрипта для ${video.id}`);
        // Всё равно записываем в seen
        this.db.videos.push({ id: video.id, title: video.title, analyzedAt: new Date().toISOString(), noTranscript: true });
        this.save();
        return;
      }

      // 4. Глубокий анализ
      const analysis = await this.deepAnalyze(video, transcript);
      if (!analysis) {
        log(`❌ Анализ не получился`);
        return;
      }

      // 5. Сохранить
      await this.saveResult(video, transcript, analysis);

      // 6. Отчёт
      await this.sendReport(video, analysis);

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      log(`\n✅ Цикл завершён за ${elapsed}с`);
      log(`   Видео: ${this.db.videos.length} | Паттернов: ${this.db.patterns.length}`);
      log(`${'='.repeat(60)}\n`);

    } catch (e) {
      log(`💥 Цикл упал: ${e.message}`);
      log(e.stack?.slice(0, 500) || '');
    }
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────
const agent = new DeepLearningAgent();
const cmd = process.argv[2] || 'cycle';

switch (cmd) {
  case 'cycle':
    await agent.runCycle();
    break;

  case 'continuous':
    log('🔄 Continuous mode: цикл каждые 3 часа');
    await agent.runCycle();
    setInterval(() => agent.runCycle(), 3 * 60 * 60 * 1000);
    break;

  case 'metrics':
    console.log('📊 База знаний:');
    console.log(`  Видео: ${agent.db.videos.length}`);
    console.log(`  Паттернов: ${agent.db.patterns.length}`);
    if (agent.db.patterns.length > 0) {
      console.log('\nПоследние 5:');
      agent.db.patterns.slice(-5).forEach(p => {
        console.log(`  📺 ${p.videoTitle?.slice(0,60)}`);
        console.log(`     тема: ${p.topic} | ${new Date(p.analyzedAt).toLocaleDateString()}`);
      });
    }
    break;

  default:
    console.log(`Usage: node youtube-learning-agent.mjs [cycle|continuous|metrics]`);
}

export default DeepLearningAgent;
