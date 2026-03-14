# Memory in AI agents

URL: https://youtube.com/watch?v=UF230UuclZM
Тема: agent memory systems vector database 2025
Дата: 2026-03-14

## CORE PROBLEM
AI-агенты по умолчанию stateless — каждый запуск начинается с чистого листа, что делает невозможным накопление знаний, исправление повторяющихся ошибок и персонализацию поведения. Без правильной архитектуры памяти агент не может использовать результаты предыдущих шагов, помнить контекст сессии или накапливать долгосрочные знания о пользователе и задачах. Разные типы задач требуют разных типов памяти — универсального решения нет.

## KEY INSIGHT
Память агента — это не одна система, а три слоя с разным временем жизни и назначением: **working** (scratch pad для текущего вычисления) → **short-term** (контекст сессии) → **long-term** (суммаризованные атрибуты для будущих сессий). Ключевое: long-term память формируется через суммаризацию working + short-term, а не через сырое хранение всей истории.

## SOLUTION APPROACH
Спикер предлагает трёхуровневую архитектуру памяти, аналогичную state management в обычных приложениях. Working memory — простые переменные или in-memory хранилище для промежуточных результатов текущей задачи (как scratch paper при решении уравнения). Short-term memory — session store с быстрым доступом: RAG-результаты, история диалога, промежуточные состояния; критично — возможность **удаления** неверных данных, чтобы агент не переоценивал ошибочный контекст. Long-term memory формируется через суммаризацию по завершении сессии — сохраняются только ключевые атрибуты (паттерны ошибок, предпочтения пользователя, постоянные коррекции), а не весь сырой лог. В multi-agent системах агенты разделяют общую сессию для координации, но могут иметь приватное состояние (например, credit card → передаётся деидентифицированно).

## ACTIONABLE STEPS
1. **Определить тип памяти для каждого агента** — для forge/atlas/iron/mesa явно прописать: что хранится в working (текущая задача), что в short-term (сессия), что промотируется в long-term (паттерны, коррекции)
2. **Реализовать суммаризацию по завершении сессии** — после каждой значимой задачи запускать LLM-суммаризацию: "что нового узнали, какие коррекции были сделаны, что повторялось" → писать в `memory/YYYY-MM-DD.md`
3. **Добавить механизм удаления из short-term** — если RAG-результат или контекст оказался неверным (агент был исправлен), явно помечать его как невалидный, а не просто игнорировать
4. **Long-term атрибуты → системный промпт** — наиболее стабильные паттерны из long-term выносить в начало сессии агента (SOUL.md / MEMORY.md), чтобы не пересчитывать их каждый раз
5. **Privacy boundaries в multi-agent** — чувствительные данные (токены, API keys) не передавать между агентами в raw виде; передавать только деидентифицированные ссылки (task_id, reference_key)

## CODE PATTERN

```python
# Three-layer agent memory system
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional
import json

# ─── Layer 1: Working Memory (scratch pad, task-scoped) ──────────────────────
class WorkingMemory:
    """In-process, lives only for current task execution"""
    def __init__(self):
        self._store: dict[str, Any] = {}

    def set(self, key: str, value: Any): self._store[key] = value
    def get(self, key: str) -> Any: return self._store.get(key)
    def clear(self): self._store.clear()

    # Use for: intermediate LLM outputs, step results, computed values
    # Example: store RAG chunks, tool outputs, partial answers


# ─── Layer 2: Short-Term Memory (session-scoped, fast access) ────────────────
class ShortTermMemory:
    """Session store — persists across steps within one conversation"""
    def __init__(self, session_id: str, backend):  # Redis / SQLite / dict
        self.session_id = session_id
        self.backend = backend

    def store(self, key: str, value: Any, valid: bool = True):
        self.backend.set(f"{self.session_id}:{key}", {
            "value": value,
            "valid": valid,       # ← CRITICAL: can be invalidated
            "ts": datetime.utcnow().isoformat()
        })

    def recall(self, key: str) -> Optional[Any]:
        record = self.backend.get(f"{self.session_id}:{key}")
        if record and record["valid"]:
            return record["value"]
        return None  # Invalid entries are silently ignored

    def invalidate(self, key: str):
        """When agent was corrected — remove bad context immediately"""
        record = self.backend.get(f"{self.session_id}:{key}")
        if record:
            record["valid"] = False
            self.backend.set(f"{self.session_id}:{key}", record)


# ─── Layer 3: Long-Term Memory (cross-session, summarized) ───────────────────
class LongTermMemory:
    """Persistent attributes — survives session end, grows over time"""
    def __init__(self, agent_id: str, vector_db):  # Qdrant
        self.agent_id = agent_id
        self.db = vector_db

    async def consolidate(self, working: WorkingMemory,
                          short_term: ShortTermMemory,
                          summarizer_llm) -> None:
        """End-of-session: summarize → extract key attributes → store"""
        raw_context = {
            "working": working._store,
            "session": short_term.dump_valid()
        }
        # LLM extracts only what matters long-term
        summary = await summarizer_llm.extract(
            raw_context,
            prompt="What corrections were made? What patterns emerged? "
                   "What should this agent always remember? Be concise."
        )
        await self.db.upsert(self.agent_id, summary)

    async def inject_at_session_start(self) -> dict:
        """Load relevant long-term attrs to prime the agent"""
        return await self.db.query(self.agent_id, top_k=10)


# ─── Multi-Agent Privacy Boundary ────────────────────────────────────────────
class SecureHandoff:
    """Pass deidentified references between agents"""
    def __init__(self, vault):
        self.vault = vault  # Local secrets store

    def package(self, sensitive_data: dict) -> dict:
        ref_id = self.vault.store(sensitive_data)
        return {"ref_id": ref_id, "type": "vault_reference"}
        # Only ref_id travels between agents — raw data stays local

    def resolve(self, package: dict) -> dict:
        return self.vault.retrieve(package["ref_id"])


# ─── Usage in agent task ─────────────────────────────────────────────────────
async def agent_task(session_id: str, task: str):
    wm = WorkingMemory()
    stm = ShortTermMemory(session_id, backend=redis_client)
    ltm = LongTermMemory("forge", vector_db=qdrant_client)

    # Inject long-term context at start
    context = await ltm.inject_at_session_start()

    # Working: store intermediate result
    rag_result = await rag_search(task)
    wm.set("rag_result", rag_result)

    # Short-term: share across steps
    stm.store("rag_result", rag_result)

    # If result was wrong → invalidate immediately
    if user_corrected:
        stm.invalidate("rag_result")

    # End of session: consolidate to long-term
    await ltm.consolidate(wm, stm, summarizer_llm)
```

## METRICS & RESULTS
Конкретных числовых метрик в видео нет — материал образовательный, а не кейс-стади. Качественные результаты:
- **Снижение повторяющихся ошибок** — long-term атрибуты позволяют агенту помнить прошлые коррекции и не повторять их
- **Снижение стоимости** — не пересчитывать одни и те же коррекции каждую сессию ("gets expensive" без long-term памяти)
- **Точность ответов** — удаление невалидных RAG-результатов из short-term предотвращает overweighting неверного контекста

## APPLY TO ASYSTEM
ASYSTEM уже имеет зачатки этой архитектуры: `MEMORY.md` ≈ long-term, `memory/YYYY-MM-DD.md` ≈ short-term лог, Qdrant ≈ vector store. Следующий шаг — замкнуть цикл суммаризации: после каждой значимой задачи запускать `python3 scripts/memory_write.py` с extracted-атрибутами сессии (не raw лог, а ключевые паттерны и коррекции), чтобы MEMORY.md оставался сжатым (~150 строк), а детали уходили в Qdrant. Критически важно для multi-agent сети (forge/atlas/iron/mesa): токены и sensitive данные из MEMORY.md передавать между агентами только через vault-reference паттерн — `ref_id` вместо raw значений, особенно при делегировании задач через `/api/dispatch`.

## TAGS
`agent-memory`, `working-memory`, `long-term-memory`, `RAG`, `state-management`, `multi-agent`, `session-context`, `memory-consolidation`