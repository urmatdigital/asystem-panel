#!/usr/bin/env node
/**
 * CONTEXT COMPRESSION — Gap #4
 * Сжимает старые события (суммирует, архивирует)
 * Задача: decisions.json остаётся быстрым даже спустя месяцы
 * 
 * Стратегия:
 * - Последние 7 дней: полный текст (всё)
 * - 7-30 дней: сжато (summary, category)
 * - 30+ дней: только метаданные (заголовок, дата)
 */

import fs from 'fs';

const STATE_DIR = '/Users/urmatmyrzabekov/.openclaw/state';
const ARCHIVE_DIR = '/Users/urmatmyrzabekov/.openclaw/archive';
const LOG_FILE = '/Users/urmatmyrzabekov/.openclaw/logs/compression.log';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ════════════════════════════════════════════════════════════════════════════
// TIME CLASSIFICATION
// ════════════════════════════════════════════════════════════════════════════

function getAgeCategory(timestamp) {
  const now = Date.now();
  const age = now - new Date(timestamp).getTime();
  
  const DAY = 24 * 60 * 60 * 1000;
  const days = age / DAY;
  
  if (days < 7) return 'recent';      // Последние 7 дней
  if (days < 30) return 'medium';     // 7-30 дней
  return 'archived';                  // 30+ дней
}

// ════════════════════════════════════════════════════════════════════════════
// COMPRESSION STRATEGIES
// ════════════════════════════════════════════════════════════════════════════

function compressRecent(item) {
  // Последние 7 дней - хранить полностью
  return item;
}

function compressMedium(item) {
  // 7-30 дней - сжато (оставить суть)
  return {
    id: item.id,
    created_at: item.created_at,
    type: item.type,
    title: item.title?.slice(0, 50),  // Обрезать длинный текст
    category: item.category,
    summary: item.pattern || item.reasoning || item.content?.slice(0, 30),
    quality: item.success_rate || item.confidence
  };
}

function compressArchived(item) {
  // 30+ дней - только метаданные
  return {
    id: item.id,
    type: item.type,
    title: item.title?.slice(0, 30),
    date: item.created_at?.split('T')[0],  // Только дата, без времени
    location: 'archived'
  };
}

// ════════════════════════════════════════════════════════════════════════════
// COMPRESS SINGLE FILE
// ════════════════════════════════════════════════════════════════════════════

export function compressFile(filename) {
  const filepath = `${STATE_DIR}/${filename}`;
  
  if (!fs.existsSync(filepath)) {
    log(`✗ Файл не найден: ${filename}`);
    return null;
  }
  
  const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  
  if (!Array.isArray(data)) {
    log(`⚠️  ${filename} - не массив, пропускаю`);
    return null;
  }
  
  const before = JSON.stringify(data).length;
  
  // Разделить по возрасту + сжать
  const recent = [];
  const medium = [];
  const archived = [];
  
  data.forEach(item => {
    const category = getAgeCategory(item.created_at || item.timestamp || item.indexed_at || new Date().toISOString());
    
    switch (category) {
      case 'recent':
        recent.push(compressRecent(item));
        break;
      case 'medium':
        medium.push(compressMedium(item));
        break;
      case 'archived':
        archived.push(compressArchived(item));
        break;
    }
  });
  
  // Сохранить основной файл (только recent + medium)
  const compressed = [...recent, ...medium];
  fs.writeFileSync(filepath, JSON.stringify(compressed, null, 2));
  
  const after = JSON.stringify(compressed).length;
  const saved = Math.round((1 - after / before) * 100);
  
  log(`📦 ${filename}: ${data.length} items → ${compressed.length} items, сохранено ${saved}%`);
  
  // Архивировать старые
  if (archived.length > 0) {
    ensureArchiveDir();
    const archivePath = `${ARCHIVE_DIR}/${filename}.${new Date().toISOString().split('T')[0]}.json`;
    fs.writeFileSync(archivePath, JSON.stringify(archived, null, 2));
    log(`  📂 Архивировано ${archived.length} старых записей → ${filename}.YYYY-MM-DD.json`);
  }
  
  return {
    filename,
    before_items: data.length,
    after_items: compressed.length,
    archived_items: archived.length,
    compression_ratio: saved + '%',
    size_before_kb: Math.round(before / 1024),
    size_after_kb: Math.round(after / 1024)
  };
}

// ════════════════════════════════════════════════════════════════════════════
// COMPRESS ALL FILES IN STATE DIR
// ════════════════════════════════════════════════════════════════════════════

export function compressAll() {
  log(`🔄 Запускаю сжатие всех файлов...`);
  
  const files = [
    'decisions.json',
    'lessons.json',
    'incidents.json',
    'forge.json',
    'atlas.json',
    'iron.json',
    'mesa.json'
  ];
  
  const results = [];
  
  for (const file of files) {
    try {
      const result = compressFile(file);
      if (result) results.push(result);
    } catch (err) {
      log(`✗ Ошибка обработки ${file}: ${err.message}`);
    }
  }
  
  log(`✅ Сжатие завершено: ${results.length} файлов обработано`);
  
  return {
    files_compressed: results.length,
    total_before_kb: results.reduce((sum, r) => sum + r.size_before_kb, 0),
    total_after_kb: results.reduce((sum, r) => sum + r.size_after_kb, 0),
    results
  };
}

// ════════════════════════════════════════════════════════════════════════════
// ARCHIVE MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════

function ensureArchiveDir() {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
}

export function cleanupOldArchives(daysToKeep = 90) {
  ensureArchiveDir();
  
  const files = fs.readdirSync(ARCHIVE_DIR);
  let deleted = 0;
  
  files.forEach(file => {
    const filepath = `${ARCHIVE_DIR}/${file}`;
    const stats = fs.statSync(filepath);
    const age = (Date.now() - stats.mtime.getTime()) / (24 * 60 * 60 * 1000);
    
    if (age > daysToKeep) {
      fs.unlinkSync(filepath);
      deleted++;
      log(`🗑️  Удален архив ${age.toFixed(0)}d old: ${file}`);
    }
  });
  
  if (deleted === 0) {
    log(`💾 Архивы свежие, удаление не требуется`);
  }
  
  return deleted;
}

export function getArchiveStats() {
  ensureArchiveDir();
  
  const files = fs.readdirSync(ARCHIVE_DIR);
  let totalSize = 0;
  
  files.forEach(file => {
    const filepath = `${ARCHIVE_DIR}/${file}`;
    const stats = fs.statSync(filepath);
    totalSize += stats.size;
  });
  
  return {
    archive_files: files.length,
    archive_size_kb: Math.round(totalSize / 1024),
    oldest_file: files.sort()[0] || 'none',
    newest_file: files.sort().pop() || 'none'
  };
}

// ════════════════════════════════════════════════════════════════════════════
// HIERARCHICAL MEMORY STRUCTURE
// ════════════════════════════════════════════════════════════════════════════

export function getMemoryHierarchy() {
  ensureArchiveDir();
  
  const hierarchy = {
    hot_layer: {
      description: 'Последние 7 дней (полный текст)',
      location: STATE_DIR,
      strategy: 'Direct access'
    },
    warm_layer: {
      description: '7-30 дней (сжато)',
      location: STATE_DIR,
      strategy: 'Minimal access'
    },
    cold_layer: {
      description: '30+ дней (архив)',
      location: ARCHIVE_DIR,
      strategy: 'Lazy load if needed',
      retention: '90 days'
    }
  };
  
  // Статистика каждого слоя
  let hotItems = 0, warmItems = 0, coldItems = 0;
  let hotSize = 0, warmSize = 0, coldSize = 0;
  
  // Подсчитать hot + warm
  const stateFiles = fs.readdirSync(STATE_DIR).filter(f => f.endsWith('.json'));
  stateFiles.forEach(file => {
    const filepath = `${STATE_DIR}/${file}`;
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    const fileSize = fs.statSync(filepath).size;
    
    if (Array.isArray(data)) {
      data.forEach(item => {
        const category = getAgeCategory(item.created_at || item.timestamp || item.indexed_at || new Date().toISOString());
        if (category === 'recent') {
          hotItems++;
          hotSize += JSON.stringify(item).length;
        } else if (category === 'medium') {
          warmItems++;
          warmSize += JSON.stringify(item).length;
        }
      });
    }
  });
  
  // Подсчитать cold (архивы)
  const archiveFiles = fs.readdirSync(ARCHIVE_DIR);
  archiveFiles.forEach(file => {
    const filepath = `${ARCHIVE_DIR}/${file}`;
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    if (Array.isArray(data)) {
      coldItems += data.length;
      coldSize += fs.statSync(filepath).size;
    }
  });
  
  hierarchy.hot_layer.items = hotItems;
  hierarchy.hot_layer.size_kb = Math.round(hotSize / 1024);
  hierarchy.warm_layer.items = warmItems;
  hierarchy.warm_layer.size_kb = Math.round(warmSize / 1024);
  hierarchy.cold_layer.items = coldItems;
  hierarchy.cold_layer.size_kb = Math.round(coldSize / 1024);
  
  hierarchy.total = {
    items: hotItems + warmItems + coldItems,
    size_kb: Math.round((hotSize + warmSize + coldSize) / 1024),
    load_time_ms: `Hot: <5ms | Warm: 10-50ms | Cold: 100-500ms`
  };
  
  return hierarchy;
}

// ════════════════════════════════════════════════════════════════════════════
// AUTOMATIC COMPRESSION SCHEDULER
// ════════════════════════════════════════════════════════════════════════════

export function scheduleCompressionCycle(intervalHours = 24) {
  log(`⏰ Расписание сжатия: каждые ${intervalHours} часов`);
  
  setInterval(() => {
    log(`🔄 Запущен автоматический цикл сжатия...`);
    const result = compressAll();
    
    // Почистить старые архивы
    const deleted = cleanupOldArchives(90);
    
    log(`✅ Цикл завершен: ${result.total_before_kb}KB → ${result.total_after_kb}KB`);
  }, intervalHours * 60 * 60 * 1000);
}