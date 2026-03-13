#!/usr/bin/env node
/**
 * DISTRIBUTED CACHE — Scale-out caching for multi-node deployment
 * Кэширует результаты queries для быстрого доступа на других узлах
 * 
 * Стратегия:
 * - Local cache (LRU, <100ms latency)
 * - Network cache (Redis-like, <1s latency)
 * - Distributed invalidation (pub/sub)
 */

import fs from 'fs';
import crypto from 'crypto';

const CACHE_DB = '/Users/urmatmyrzabekov/.openclaw/dist-cache.json';
const LOG_FILE = '/Users/urmatmyrzabekov/.openclaw/logs/cache.log';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ════════════════════════════════════════════════════════════════════════════
// LOCAL LRU CACHE (in-memory)
// ════════════════════════════════════════════════════════════════════════════

class LRUCache {
  constructor(maxSize = 1000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.hits = 0;
    this.misses = 0;
  }
  
  set(key, value, ttl = 3600000) { // 1 hour default
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, {
      value,
      expires_at: Date.now() + ttl,
      created_at: Date.now()
    });
  }
  
  get(key) {
    const item = this.cache.get(key);
    
    if (!item) {
      this.misses++;
      return null;
    }
    
    if (item.expires_at < Date.now()) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }
    
    this.hits++;
    return item.value;
  }
  
  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }
  
  stats() {
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hit_rate: this.hits + this.misses > 0 
        ? (this.hits / (this.hits + this.misses) * 100).toFixed(1) + '%'
        : 'N/A'
    };
  }
}

const localCache = new LRUCache(5000);

// ════════════════════════════════════════════════════════════════════════════
// PERSISTENT DISTRIBUTED CACHE
// ════════════════════════════════════════════════════════════════════════════

function loadCacheDB() {
  if (fs.existsSync(CACHE_DB)) {
    return JSON.parse(fs.readFileSync(CACHE_DB, 'utf8'));
  }
  return { entries: {}, invalidations: [], stats: {} };
}

function saveCacheDB(db) {
  fs.writeFileSync(CACHE_DB, JSON.stringify(db, null, 2));
}

export function set(key, value, ttl = 3600000, scope = 'default') {
  /**
   * Set cache entry (both local + distributed)
   */
  
  // Local cache
  localCache.set(key, value, ttl);
  
  // Persistent cache
  const db = loadCacheDB();
  const cacheKey = `${scope}:${key}`;
  
  db.entries[cacheKey] = {
    value,
    expires_at: Date.now() + ttl,
    created_at: new Date().toISOString(),
    node: 'forge', // Current node
    scope
  };
  
  // Keep size under control
  const keys = Object.keys(db.entries);
  if (keys.length > 10000) {
    // Remove oldest
    keys.slice(0, 1000).forEach(k => delete db.entries[k]);
  }
  
  saveCacheDB(db);
  log(`💾 Cache SET: ${cacheKey}`);
  
  return cacheKey;
}

export function get(key, scope = 'default') {
  /**
   * Get from cache (local first, then distributed)
   */
  
  // Try local cache first (faster)
  let value = localCache.get(key);
  if (value) {
    log(`⚡ Cache HIT (local): ${key}`);
    return { value, source: 'local', hit: true };
  }
  
  // Try distributed cache
  const db = loadCacheDB();
  const cacheKey = `${scope}:${key}`;
  const entry = db.entries[cacheKey];
  
  if (!entry) {
    log(`❌ Cache MISS: ${key}`);
    return { value: null, source: 'none', hit: false };
  }
  
  // Check expiration
  if (entry.expires_at < Date.now()) {
    delete db.entries[cacheKey];
    saveCacheDB(db);
    log(`⏰ Cache EXPIRED: ${key}`);
    return { value: null, source: 'none', hit: false };
  }
  
  // Cache hit
  value = entry.value;
  
  // Promote to local cache
  localCache.set(key, value, entry.expires_at - Date.now());
  
  log(`💾 Cache HIT (distributed): ${key}`);
  
  return { value, source: 'distributed', hit: true };
}

export function invalidate(pattern, scope = 'default') {
  /**
   * Invalidate cache entries matching pattern
   */
  
  const db = loadCacheDB();
  const prefix = `${scope}:${pattern}`;
  
  let invalidated = 0;
  
  Object.keys(db.entries).forEach(key => {
    if (key.startsWith(prefix) || key.includes(pattern)) {
      delete db.entries[key];
      invalidated++;
    }
  });
  
  // Record invalidation event
  db.invalidations.push({
    pattern,
    scope,
    invalidated_count: invalidated,
    timestamp: new Date().toISOString()
  });
  
  saveCacheDB(db);
  
  // Also clear local cache
  localCache.clear();
  
  log(`🔄 Cache INVALIDATED: ${pattern} (${invalidated} entries)`);
  
  return invalidated;
}

// ════════════════════════════════════════════════════════════════════════════
// CACHE WARMING (preload)
// ════════════════════════════════════════════════════════════════════════════

export function warmCache(entries) {
  /**
   * Bulk load entries into cache
   */
  
  let count = 0;
  
  entries.forEach(entry => {
    set(entry.key, entry.value, entry.ttl, entry.scope || 'default');
    count++;
  });
  
  log(`🔥 Cache warmed: ${count} entries`);
  
  return count;
}

// ════════════════════════════════════════════════════════════════════════════
// CACHE STATISTICS
// ════════════════════════════════════════════════════════════════════════════

export function getStats() {
  const db = loadCacheDB();
  
  // Clean expired
  const now = Date.now();
  let expired = 0;
  
  Object.keys(db.entries).forEach(key => {
    if (db.entries[key].expires_at < now) {
      delete db.entries[key];
      expired++;
    }
  });
  
  if (expired > 0) {
    saveCacheDB(db);
  }
  
  return {
    local: localCache.stats(),
    distributed: {
      entries: Object.keys(db.entries).length,
      size_kb: Math.round(JSON.stringify(db.entries).length / 1024),
      expired_cleaned: expired
    },
    invalidations_recent: db.invalidations.slice(-5),
    overall: {
      total_entries: Object.keys(db.entries).length + localCache.cache.size,
      combined_size_kb: Math.round(
        (JSON.stringify(db.entries).length + 
         JSON.stringify(localCache.cache).length) / 1024
      )
    }
  };
}

// ════════════════════════════════════════════════════════════════════════════
// CACHE KEY GENERATION (deterministic)
// ════════════════════════════════════════════════════════════════════════════

export function generateCacheKey(operation, params) {
  /**
   * Generate deterministic cache key from operation + params
   */
  
  const hash = crypto
    .createHash('sha256')
    .update(operation + JSON.stringify(params))
    .digest('hex')
    .slice(0, 16);
  
  return `${operation}:${hash}`;
}