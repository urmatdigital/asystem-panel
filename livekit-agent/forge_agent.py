"""
Forge Voice Agent — LiveKit 1.x AI agent для ASYSTEM
Версия 2.0 — с RAG контекстом (live tasks + agent status)
"""
import asyncio, os, json
from urllib.request import urlopen, Request
from datetime import datetime

from livekit.agents import (
    Agent, AgentSession, AutoSubscribe, JobContext,
    WorkerOptions, cli, llm,
)
from livekit.plugins import openai, silero

FORGE_API = os.getenv("FORGE_API", "http://100.87.107.50:5190")

# ── API helper ────────────────────────────────────────────────────────────────
def call_api(path: str, method="GET", body=None, timeout=8) -> dict:
    try:
        data = json.dumps(body).encode() if body else None
        req = Request(f"{FORGE_API}{path}", data=data,
                      headers={"Content-Type": "application/json"}, method=method)
        with urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"error": str(e)}

# ── Context fetcher ───────────────────────────────────────────────────────────
def fetch_live_context() -> str:
    """Получить живой контекст ASYSTEM для инжекции в промпт."""
    ctx_data = call_api("/api/livekit/context", timeout=6)
    if "context" in ctx_data:
        return ctx_data["context"]
    # Fallback: build basic context
    now = datetime.now().strftime("%d.%m.%Y %H:%M")
    return f"=== ASYSTEM Context ({now}) ===\nКонтекст недоступен."

# ── Base instructions ─────────────────────────────────────────────────────────
BASE_INSTRUCTIONS = """Ты Forge — AI инженер ASYSTEM Command Center.
Правила:
- Отвечай по-русски, кратко (2-3 предложения максимум)
- Можешь смотреть задачи, статус системы, добавлять задачи
- Обращайся к Урмату по имени если он говорит с тобой
- Если спрашивают про конкретного агента — используй контекст ниже

{context}"""

# ── ForgeAgent ────────────────────────────────────────────────────────────────
class ForgeAgent(Agent):
    def __init__(self, live_context: str = ""):
        instructions = BASE_INSTRUCTIONS.format(context=live_context)
        super().__init__(instructions=instructions)
        self._context = live_context
        self._context_ts = asyncio.get_event_loop().time()

    async def on_enter(self):
        await self.session.say("Forge онлайн. Чем могу помочь?", allow_interruptions=True)

    @llm.function_tool(description="Получить список активных и свежих задач из ASYSTEM")
    async def get_tasks(self, status: str = "all") -> str:
        """status: 'todo' | 'in_progress' | 'done' | 'blocked' | 'all'"""
        if status == "in_progress":
            d = call_api("/api/tasks/pending?limit=8")
        else:
            d = call_api("/api/tasks/pending?limit=8")
        tasks = d.get("tasks", [])
        if not tasks:
            return "Нет активных задач."
        lines = []
        for t in tasks[:5]:
            agent = t.get('agent', '?')
            title = t.get('title', '?')[:50]
            st = t.get('status', '?')
            lines.append(f"[{agent}] {title} ({st})")
        return f"{len(tasks)} задач:\n" + "\n".join(lines)

    @llm.function_tool(description="Получить статус системы — агенты, PM2, Tailscale")
    async def get_status(self) -> str:
        d = call_api("/api/dashboard/snapshot")
        ts = d.get("tailscale", {})
        pm2 = d.get("pm2", {})
        # Also get fresh agent status
        agents_d = call_api("/api/agents")
        agents = agents_d.get("agents", [])
        online = [a.get("name", a.get("id")) for a in agents if a.get("online")]
        offline = [a.get("name", a.get("id")) for a in agents if not a.get("online")]
        result = (
            f"Tailscale: {ts.get('online', 0)}/{ts.get('total', 0)} нод. "
            f"PM2: {pm2.get('online', 0)}/{pm2.get('total', 0)} процессов.\n"
            f"Онлайн: {', '.join(online) or 'нет'}.\n"
            f"Офлайн: {', '.join(offline) or 'нет'}."
        )
        return result

    @llm.function_tool(description="Добавить задачу в ASYSTEM через brain dump")
    async def add_task(self, text: str) -> str:
        """text: описание задачи на русском языке"""
        d = call_api("/api/braindump", "POST", {"text": text})
        cnt = d.get("created", 0)
        if cnt:
            return f"Создано {cnt} задач."
        return "Задача записана."

    @llm.function_tool(description="Обновить живой контекст системы (задачи + статус агентов)")
    async def refresh_context(self) -> str:
        """Перезагружает live контекст из ASYSTEM API"""
        new_ctx = fetch_live_context()
        self._context = new_ctx
        self._context_ts = asyncio.get_event_loop().time()
        return f"Контекст обновлён.\n{new_ctx[:500]}"

    @llm.function_tool(description="Получить стоимость AI за сегодня")
    async def get_costs(self) -> str:
        d = call_api("/api/costs/today")
        total = d.get("totalUsd", d.get("total", 0))
        breakdown = d.get("byAgent", {})
        result = f"Расходы сегодня: ${total:.2f}"
        if breakdown:
            top = sorted(breakdown.items(), key=lambda x: -x[1])[:3]
            result += "\nТоп расходов: " + ", ".join(f"{k}: ${v:.2f}" for k, v in top)
        return result

# ── Entry point ───────────────────────────────────────────────────────────────
async def entrypoint(ctx: JobContext):
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    # Fetch live context BEFORE starting agent
    print("[forge-agent] Fetching live context...")
    live_context = fetch_live_context()
    print(f"[forge-agent] Context loaded ({len(live_context)} chars)")

    session = AgentSession(
        vad=silero.VAD.load(),
        stt=openai.STT(language="ru"),
        llm=openai.LLM(model="gpt-4o-mini"),
        tts=openai.TTS(voice="alloy"),
    )

    agent = ForgeAgent(live_context=live_context)

    await session.start(
        room=ctx.room,
        agent=agent,
    )

    # Auto-refresh context every 3 minutes in background
    async def context_refresher():
        while True:
            await asyncio.sleep(180)
            try:
                agent._context = fetch_live_context()
                print("[forge-agent] Context refreshed")
            except Exception as e:
                print(f"[forge-agent] Context refresh error: {e}")

    asyncio.create_task(context_refresher())
    await asyncio.sleep(3600)  # Max 1 hour session

if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
