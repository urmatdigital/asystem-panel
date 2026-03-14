# UptimeX: AI-Powered Self-Healing Infrastructure Demo | Autonomous Incident Remediation

URL: https://youtube.com/watch?v=N6avTeZlsxQ
Тема: self healing infrastructure AI
Дата: 2026-03-14

## CORE PROBLEM
On-call инженеры тратят время на firefighting — ручное обнаружение, диагностику и устранение инцидентов, пока пользователи уже страдают от даунтайма. Существующие мониторинговые системы (Prometheus, CloudWatch, Datadog) умеют только алертить, но не действовать. Разрыв между "знаю что сломалось" и "уже починено" — это и есть проблема, которую решает UptimeX.

## KEY INSIGHT
**Tiered autonomy** — ключевая идея: AI действует мгновенно на low-risk инциденты и запрашивает human approval для high-risk изменений. Это решает главный страх автоматизации ("а вдруг AI сломает больше") без потери скорости реакции на типичные инциденты.

## SOLUTION APPROACH
UptimeX реализует замкнутый цикл из пяти шагов: алерт из мониторинга → AI-анализ root cause → автоматическая ремедиация через StackStorm → верификация фикса → уведомление команды в Slack. Ключевое архитектурное решение — AI как reasoning layer поверх существующего стека (Prometheus/CloudWatch/Datadog + StackStorm), а не замена инструментов. Система работает в двух режимах параллельно: реактивном (чинит то, что уже сломалось) и предиктивном (превентивный автоскейлинг до возникновения проблем). Human-in-the-loop не опциональная фича, а архитектурный принцип — высокорисковые операции всегда требуют подтверждения. Full audit trail обеспечивает прозрачность каждого действия AI.

## ACTIONABLE STEPS
1. **Классифицировать инциденты по риску** — составить матрицу: LOW (PM2 restart, cache clear, log rotation → AI действует автономно), MEDIUM (конфиг изменения, масштабирование → AI предлагает, человек подтверждает за 5 мин), HIGH (DB migrations, network changes, secrets rotation → только human)
2. **Интегрировать AI reasoning в alerting pipeline** — между алертом и действием добавить LLM-шаг: "проанализируй метрики последних 10 минут и определи root cause" перед выбором remediation action
3. **Автоматические runbooks через StackStorm/n8n** — каждому классифицированному инциденту сопоставить конкретный воркфлоу в n8n (уже есть в ASYSTEM), который выполняется автоматически или после approve
4. **Verification step обязателен** — после каждой автоматической ремедиации — проверочный запрос (health check, метрика, ping) и только потом закрытие инцидента; если верификация провалилась — эскалация к человеку
5. **Slack/Telegram audit trail** — каждое действие AI логировать с контекстом: что обнаружено → что сделано → результат верификации → время разрешения

## CODE PATTERN

```python
# Tiered Autonomy Engine — core pattern from UptimeX architecture
from enum import Enum
from dataclasses import dataclass
from typing import Callable, Awaitable
import asyncio

class RiskLevel(Enum):
    LOW = "low"        # Act immediately, no approval needed
    MEDIUM = "medium"  # Notify + wait for approval (timeout → escalate)
    HIGH = "high"      # Always require explicit human approval

@dataclass
class RemediationAction:
    name: str
    risk: RiskLevel
    execute: Callable[[], Awaitable[bool]]
    verify: Callable[[], Awaitable[bool]]
    description: str

class TieredAutonomyEngine:
    def __init__(self, notifier, approver, audit_log):
        self.notifier = notifier    # Telegram/Slack
        self.approver = approver    # Human approval gateway
        self.audit = audit_log      # Qdrant / DB

    async def handle_incident(self, alert: dict):
        # Step 1: AI reasoning — determine root cause
        root_cause = await self.analyze(alert)

        # Step 2: Select remediation action
        action = self.select_action(root_cause)

        # Step 3: Tiered decision
        match action.risk:
            case RiskLevel.LOW:
                await self._act_autonomously(action, alert)

            case RiskLevel.MEDIUM:
                await self.notifier.send(
                    f"⚠️ AI wants to: {action.description}\
"
                    f"Auto-executing in 5 min unless denied..."
                )
                approved = await self.approver.wait(timeout=300, default=True)
                if approved:
                    await self._act_autonomously(action, alert)
                else:
                    await self.audit.log("action_denied", action, alert)

            case RiskLevel.HIGH:
                await self.notifier.send(
                    f"🔴 HIGH RISK: {action.description}\
"
                    f"Manual approval required. /approve or /deny"
                )
                approved = await self.approver.wait(timeout=None, default=False)
                if approved:
                    await self._act_autonomously(action, alert)

    async def _act_autonomously(self, action: RemediationAction, alert: dict):
        # Execute
        await self.audit.log("action_started", action, alert)
        success = await action.execute()

        # Verify fix worked
        verified = await action.verify()

        if verified:
            await self.notifier.send(
                f"✅ [{action.risk.value.upper()}] {action.name} — RESOLVED\
"
                f"Verified: healthy"
            )
            await self.audit.log("action_success", action, alert)
        else:
            await self.notifier.send(
                f"❌ {action.name} executed but verification FAILED\
"
                f"Escalating to human..."
            )
            await self.audit.log("action_failed_verify", action, alert)
            await self.escalate(alert)

# Example action registry for ASYSTEM:
ACTIONS = {
    "pm2_crash": RemediationAction(
        name="PM2 Process Restart",
        risk=RiskLevel.LOW,
        execute=lambda: restart_pm2("asystem-api"),
        verify=lambda: check_health("http://localhost:5190/health"),
        description="Restart crashed PM2 process"
    ),
    "disk_overflow": RemediationAction(
        name="Log Cleanup",
        risk=RiskLevel.LOW,
        execute=lambda: cleanup_logs("/var/log", keep_days=7),
        verify=lambda: check_disk_usage(threshold=80),
        description="Clean old logs to free disk space"
    ),
    "tunnel_drop": RemediationAction(
        name="CF Tunnel Restart",
        risk=RiskLevel.MEDIUM,
        execute=lambda: restart_pm2("cf-tunnel-panel"),
        verify=lambda: check_url("https://os.te.kg"),
        description="Restart Cloudflare tunnel (os.te.kg)"
    ),
}
```

## METRICS & RESULTS
| Метрика | Заявлено |
|---------|----------|
| **Время реакции** | Секунды (remediation executes in seconds) |
| **On-call опыт** | Трансформация с firefighting → oversight |
| **Прозрачность** | 100% audit trail каждого AI-действия |
| **Предиктивный скейлинг** | Предотвращение проблем до их возникновения |

*Конкретные числовые метрики (%, $, MTTR) в описании не представлены — видео является demo, количественные данные в транскрипте отсутствуют.*

## APPLY TO ASYSTEM
Tiered autonomy — именно то, чего не хватает текущему ASYSTEM watchdog: `pm2-watchdog.sh` и `auto-restart-autonomous.sh` действуют по принципу "всё или ничего", без учёта риска действия. Нужно добавить классификацию: LOW (restart PM2, clear cache) → автономно, MEDIUM (restart CF tunnel, Tailscale reconnect) → notify Урмата в Telegram + авто через 5 мин, HIGH (DB changes, deploy новой версии Panel) → только manual approve. Verification step критичен для ASYSTEM: после каждого автоматического действия делать HTTP health check (`/health` эндпоинт) или Tailscale ping — если верификация провалилась, не закрывать инцидент, а немедленно будить Урмата с полным контекстом в Telegram.

## TAGS
`tiered-autonomy`, `AI-ops`, `incident-remediation`, `human-in-the-loop`, `StackStorm`, `self-healing`, `on-call-automation`, `audit-trail`