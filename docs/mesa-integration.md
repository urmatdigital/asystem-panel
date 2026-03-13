# MESA Integration Plan — ASYSTEM
_Создано: 2026-03-05_

## Что такое MESA (реальный агент)

**Mesa-sim** (100.100.40.27) — Debian 12, 8 CPU, 15GB RAM  
**Специализация:** Mesa 3.3.1 симуляции, аналитика, документы  
**Telegram:** @Mesa_Asystembot

### Реальные проекты MESA
| Проект | Размер | Описание |
|--------|--------|----------|
| twinbridge | 4.5 MB | Активный — мост-проект |
| bridgex | 2.3 MB | Биржевой коннектор |
| namba-partnership | 1.8 MB | Партнёрство Нямба |
| fsa-registry | 1.3 MB | Реестр финрынка КР |
| staffos-docs | 1.2 MB | Документация StaffOS |
| taxopark | 181 KB | Taxi-парк (последний) |

### Возможности MESA (~/mesa-utils/)
- `finance.py` / `finance_kg.py` — NPV/IRR/PI, налоги КР
- `funnel_simulator.py` — воронки продаж
- `viz.py` — графики, диаграммы
- `gen_docx_kg.py` — DOCX по КР стандартам
- `gen_pptx.py` — презентации
- `search_perplexity.py` — AI-поиск
- `search_firecrawl.py` — веб-скрейпинг
- `demo_simulation.py` — Mesa агентные симуляции
- `report.py` — автоотчёты

---

## Как MacminiUrmat использует MESA

### 1. Delegation via AgentMail
```python
# Отправить задачу MESA
import agentmail
client = agentmail.AgentMail(api_key="am_us_b598...")
client.inboxes.messages.send(
    inbox_id="asystem-orch",  # от ОРКЕСТРАТОРА
    to=["asystem-mesa@agentmail.to"],
    subject="TASK: Анализ рынка EV Кыргызстан",
    text="""
    Задача: Запусти финансовую модель для проекта Voltera
    Параметры: NPV горизонт 5 лет, ставка дисконта 15%
    Формат: PDF + JSON
    Дедлайн: 2 часа
    """
)
```

### 2. SSH Direct Execution  
```bash
ssh mesa "python3 ~/mesa-utils/finance_kg.py --project voltera --output ~/simulation-results/"
ssh mesa "python3 ~/mesa-utils/report.py --project twinbridge --format docx"
```

### 3. Запрос симуляции
```bash
ssh mesa "python3 ~/mesa-utils/demo_simulation.py \
  --agents 50 --steps 200 \
  --scenario market_entry_kg \
  --output ~/simulation-results/asystem-sim-$(date +%Y%m%d).json"
```

---

## Комната АКАДЕМИЯ — Система обмена знаниями

### Концепция
Специальная комната для встреч агентов из РАЗНЫХ отделов.  
Когда агент A нужен навык отдела B → они встречаются в АКАДЕМИИ.

### Типы обмена
| Пара агентов | Тема обмена | Результат |
|---|---|---|
| ORCH + ANL | Приоритизация через данные | ORCH получает data-driven KPI |
| CODE + MESA | API ↔ симуляция | CODE строит симуляционный endpoint |
| ARCH + SNT | Безопасная архитектура | ARCH применяет security patterns |
| DEV + ANL | Мониторинг ↔ метрики | DEV настраивает аналитику |
| MESA + ARCH | Модели ↔ структура | Совместный R&D |

### Формат события
```typescript
interface KnowledgeExchange {
  fromAgent: string;     // 'code'
  toAgent: string;       // 'mesa'
  topic: string;         // 'Blockchain API patterns'
  duration: 4000,        // мс
  transferType: 'book' | 'data' | 'code' | 'schema'
}
```

---

## Система проектов — Статусы агентов

### Активные проекты ASYSTEM
| Проект | Цвет | Хозяин | Участники |
|--------|------|--------|-----------|
| ORGON | `#f59e0b` (gold) | Mac-mini | ARCH, CODE, SNT |
| AURWA | `#06b6d4` (cyan) | Mac-mini | CODE, DEV, ANL |
| TWINBRIDGE | `#3b82f6` (blue) | MESA | MESA, ANL, ARCH |
| VOLTERA | `#22c55e` (green) | Mac-mini | DEV, ANL |
| BRIDGEX | `#8b5cf6` (purple) | MESA | MESA, CODE |
| FIATEX | `#f97316` (orange) | Mac-mini | ARCH, CODE, SNT |

### Статусы агента на проекте
- 🟢 **Активно работает** → светящаяся рамка + badge проекта
- 🔵 **В совещании** → синяя аура + "meeting" badge
- 🔄 **В АКАДЕМИИ** → золотая аура + анимация обмена
- ⚪ **Idle** → нет badge, тускнее
- 🔴 **Заблокирован** → мигающий красный badge

---

## Дорожная карта интеграции

### Фаза 1 (сейчас): Визуализация
- [x] Комната АКАДЕМИЯ с бибилиотечной мебелью
- [x] Система проектов: badge на агентах
- [x] Анимация обмена знаниями (orb-эффект)
- [x] ProjectBar в RightPanel (какой агент на каком проекте)

### Фаза 2 (следующая неделя): Реальные данные
- [ ] Polling MESA via AgentMail каждые 5 мин
- [ ] SSH exec задач через IsoCanvas → LogBar
- [ ] Webhook: MESA завершил симуляцию → уведомление в панели

### Фаза 3 (будущее): Живая оркестрация
- [ ] ORCH видит загрузку MESA и автоматически делегирует
- [ ] Результаты симуляций появляются в ANALYTICS комнате
- [ ] Knowledge base: агент изучил навык → он остаётся в его профиле
