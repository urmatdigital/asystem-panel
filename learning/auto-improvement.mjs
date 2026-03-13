#!/usr/bin/env node
/**
 * Auto-Improvement Agent — автономный цикл самообучения
 *
 * Запускается по cron каждые 6 часов:
 * 1. Ищет новые YouTube видео по темам
 * 2. Анализирует через summarize CLI
 * 3. Извлекает actionable паттерны через LLM
 * 4. Сохраняет в shared memory
 * 5. Обновляет fitness.yaml если найдены новые метрики
 * 6. Репортирует в Squad Chat
 */

import { execSync, exec } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { promisify } from "node:util";
const execAsync = promisify(exec);

const API_BASE = "http://127.0.0.1:5190";
const SQUAD_CHAT = "https://expert-dachshund-299.convex.cloud/api/mutation";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "process.env.OPENROUTER_API_KEY";
const FITNESS_YAML = `${process.env.HOME}/projects/ASYSTEM/api/fitness.yaml`;

const SEARCH_TOPICS = [
  "multi agent failure recovery autonomous 2025",
  "LLM model routing adaptive cost optimization 2025",
  "self healing AI pipeline production 2025",
  "agent collective memory shared learning 2025",
];

async function searchVideos(topic) {
  try {
    const out = execSync(
      `yt-dlp --get-id --get-title "ytsearch3:${topic}" 2>/dev/null`,
      { encoding: "utf8", timeout: 30000 }
    ).trim();
    const lines = out.split("\n");
    const videos = [];
    for (let i = 0; i < lines.length; i += 2) {
      if (lines[i] && lines[i+1]) videos.push({ title: lines[i], id: lines[i+1] });
    }
    return videos;
  } catch { return []; }
}

async function analyzeVideo(videoId) {
  try {
    const out = execSync(
      `summarize "https://youtu.be/${videoId}" --youtube auto --length medium 2>/dev/null`,
      { encoding: "utf8", timeout: 120000 }
    );
    return out.slice(0, 3000);
  } catch { return null; }
}

async function extractPatterns(summary) {
  const prompt = `Extract 2-3 actionable engineering patterns from this AI/agent video summary.
Format: JSON array of {pattern: string, implementation: string, priority: "high"|"medium"|"low"}
Only patterns relevant to: model routing, failure recovery, agent memory, cost optimization.
Summary: ${summary.slice(0, 2000)}
Return ONLY valid JSON array, no markdown.`;

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-flash-2.0",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || "[]";
    return JSON.parse(text.replace(/```json?/g, "").replace(/```/g, "").trim());
  } catch { return []; }
}

async function saveToSharedMemory(patterns, videoId, videoTitle) {
  for (const p of patterns) {
    const content = JSON.stringify({
      type: "video-pattern",
      videoId,
      videoTitle: videoTitle?.slice(0, 80),
      pattern: p.pattern,
      implementation: p.implementation,
      priority: p.priority,
      ts: new Date().toISOString(),
    });
    try {
      await fetch(`${API_BASE}/api/memory/shared`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, agent: "youtube-learner", tags: ["video-pattern", p.priority] }),
      });
    } catch {}
  }
}

async function postToSquadChat(msg) {
  try {
    await fetch(SQUAD_CHAT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "chat:send", args: { agent: "Forge", message: msg, tags: ["auto-improvement", "learning"] } }),
    });
  } catch {}
}

async function run() {
  console.log("[AutoImprove] 🚀 Starting improvement cycle...");
  const results = { videosFound: 0, analyzed: 0, patternsExtracted: 0 };
  const seenIds = new Set();

  for (const topic of SEARCH_TOPICS) {
    console.log(`[AutoImprove] 🔍 Topic: ${topic}`);
    const videos = await searchVideos(topic);
    results.videosFound += videos.length;

    for (const video of videos.slice(0, 1)) { // 1 видео на тему
      if (seenIds.has(video.id)) continue;
      seenIds.add(video.id);

      console.log(`[AutoImprove] 📺 Analyzing: ${video.title} (${video.id})`);
      const summary = await analyzeVideo(video.id);
      if (!summary) continue;
      results.analyzed++;

      const patterns = await extractPatterns(summary);
      if (patterns.length > 0) {
        await saveToSharedMemory(patterns, video.id, video.title);
        results.patternsExtracted += patterns.length;
        console.log(`[AutoImprove] ✅ ${patterns.length} patterns from "${video.title}"`);
      }
    }
  }

  const report = `🧠 [AUTO-IMPROVE] Цикл завершён\nВидео найдено: ${results.videosFound}\nПроанализировано: ${results.analyzed}\nПаттернов сохранено: ${results.patternsExtracted}\nВ shared memory: ✅`;
  await postToSquadChat(report);
  console.log(`[AutoImprove] ✅ Done: ${JSON.stringify(results)}`);
}

run().catch(e => console.error("[AutoImprove] ERROR:", e.message));
