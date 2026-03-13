# AGENTS.md — ASYSTEM Command Center
> Stripe Blueprint pattern: scoped rule file для AI агентов на проекте ASYSTEM Panel.
> Прочитать ПЕРЕД любой задачей в этом проекте.

---

## Project Overview
**ASYSTEM Command Center** — панель управления всей AI-экосистемой ASYSTEM
- **URL:** https://os.te.kg (Forge → Cloudflare Tunnel → 5190)
- **Sprint:** sprint-3-ops (текущий), branch `sprint-3-ops`
- **Назначение:** Kanban, C-Suite, Org Chart, Agent Chat, Network, Proxmox, Analytics

---

## Stack

### Backend (`api/`)
```
Node.js v25 + ES Modules (server.mjs)
Convex — real-time DB (tasks, sprints, agents, chat, dispatches, audit)
Cloudflare Tunnel → порт 5190
PM2 id:22 (asystem-api)
```

**Ключевые файлы:**
```
api/server.mjs            — главный сервер (~5000+ строк), ВСЕ API маршруты
api/security-utils.mjs    — 7-chain dispatch gate (checkDispatch)
api/quality-judge.mjs     — Karpathy Loop (LLM-as-judge, score 0-10)
api/task-decomposer.mjs   — Fractals (composite task → subtasks)
api/optimization-architect.mjs — complexity scoring + model routing
api/reme_search_zvec.py   — ZVec semantic memory (Python, venv)
api/agent-manifests/      — YAML манифесты всех 10 агентов
```

**КРИТИЧЕСКИЕ правила backend:**
- ⛔ `cat >>` для вставки в server.mjs ЗАПРЕЩЁН — только Edit tool или python3 line injection
- ⛔ Не трогать строки 391 (handler 1) и 3116 (handler 2) без понимания архитектуры
- ✅ Новые маршруты ТОЛЬКО в handler 2 (строка ~3116) + PUBLIC_PREFIXES (~3204)
- ✅ CORS headers ДО writeHead во всех новых маршрутах
- ✅ `Array.isArray()` guard перед `.map()` везде
- ✅ После изменений: `node --check api/server.mjs` перед pm2 reload
- Перезапуск: если EADDRINUSE → `kill $(ps aux | grep server.mjs | grep -v grep | awk '{print $2}')` затем `pm2 start -f`

### Frontend (`panel/`)
```
React 19 + Vite 6 + TypeScript
React Router v7 (SPA)
TailwindCSS + кастомные компоненты
Three.js / React Three Fiber (изометрика)
Reagraph (3D Network граф)
```

**Ключевые файлы:**
```
panel/src/App.tsx           — все страницы lazy-imported, маршруты
panel/src/pages/            — 20+ страниц (HQ, Kanban, AgentChat, Network...)
panel/src/components/       — переиспользуемые компоненты
panel/src/lib/              — API клиенты, утилиты
panel/src/components/building/ — изометрический 3D вид (R3F)
```

**КРИТИЧЕСКИЕ правила frontend:**
- ✅ Canvas stale closure → stateRef pattern (не state в RAF/requestAnimationFrame)
- ✅ ResizeObserver → onSizeRef + empty deps (не inline arrow)
- ✅ Добавление страницы: lazy import → route в App.tsx → OsNav → PUBLIC_PREFIXES в server.mjs
- ✅ TypeScript strict (0 errors — не ломать): priority='critical'|'high'|'medium'|'low' (нет 'urgent')
- ✅ sprint.name (не sprint.label)
- Lint: `cd panel && npm run lint`
- Build: `cd panel && npm run build`
- Dev: `cd panel && npm run dev`   (порт 5173)
- Deploy: `cd panel && npm run build && rsync -avz --delete dist/ root@135.181.112.60:/var/www/os.asystem.kg/`

---

## Конфигурация сети
```
os.te.kg → CF Tunnel macmini-tunnel (id:19) → localhost:5190
API: http://localhost:5190/api/*
Convex: https://expert-dachshund-299.convex.cloud
```

---

## Agent Assignments

| Agent | Зона ответственности | Не трогать |
|-------|---------------------|------------|
| **Nurlan** 🔧 (DIR-DEVOPS) | `api/server.mjs` — новые маршруты, PM2, CI/CD, deploy | `panel/` React код |
| **Ainura** 🎨 (LEAD-FE) | `panel/src/` — страницы, компоненты, стили, роутинг | `api/` Node.js |
| **Forge** 🛠️ (COO) | Всё: архитектура, security-utils, ZVec, агент-манифесты | — |

---

## Текущие задачи (Sprint 3-OPS)
- Blueprint CI post-steps (bekzat/ainura → lint автоматически) ✅
- Atomic task checkout (/api/tasks/:id/claim) ✅
- MISSION.md goal alignment ✅
- ORGONASYSTEM/AGENTS.md scoped rules ✅
- ZVec + SimpleMem adaptive retrieval ✅

## Следующие задачи
- Per-agent cost tracking (расход в реальном времени)
- Network page — live Tailscale topology
- Agent Chat — streaming улучшения

---

## Do NOT
- ⛔ Менять EADDRINUSE обработчик (`server.on('error')`)
- ⛔ Писать в Convex напрямую без `tasks:updateStatus` mutation
- ⛔ Удалять из PUBLIC_PREFIXES без проверки авторизации
- ⛔ Импортировать CommonJS в server.mjs (ES Modules only)
- ⛔ Пушить в main напрямую — всегда через PR

_Последнее обновление: 2026-03-13 by Forge_
