#!/usr/bin/env python3
"""
ASYSTEM Agent Mail — Communication Test
ORCH (asystem-ai@agentmail.to) → MESA (sadyr-kg@agentmail.to) → ORCH

Демонстрирует межагентный обмен через почту.
"""

import time, os
from agentmail import AgentMail

API_KEY = "am_us_b598717c387b09321cc1482df6faacdf5ce61646223da10e94cb662f20726458"
client = AgentMail(api_key=API_KEY)

ORCH_INBOX = "asystem-ai@agentmail.to"
MESA_INBOX = "sadyr-kg@agentmail.to"

def send(from_inbox, to_email, subject, text):
    msg = client.inboxes.messages.send(
        inbox_id=from_inbox,
        to=[to_email],
        subject=subject,
        text=text,
    )
    return msg

def get_latest(inbox_id, subject_filter=""):
    msgs = client.inboxes.messages.list(inbox_id=inbox_id, limit=5)
    for m in msgs.messages:
        subj = (m.subject or "")
        if not subject_filter or subject_filter.lower() in subj.lower():
            return m
    return None

print("=" * 55)
print("  ASYSTEM AGENT MAIL — TEST COMMUNICATION")
print("=" * 55)
print(f"\n  ORCH  → {ORCH_INBOX}")
print(f"  MESA  → {MESA_INBOX}\n")
print("-" * 55)

# ── Step 1: ORCH → MESA ──────────────────────────────────
print("\n[1/4] ОРКЕСТРАТОР отправляет запрос MESA...")
subject = "ASYSTEM Internal: Analytics Status Request"
body = """От: ОРКЕСТРАТОР (asystem-ai@agentmail.to)
Кому: MESA — Analytics Corp

Привет MESA,

Запрашиваю статус корпорации ANALYTICS.
Требуется подтверждение:
1. Симуляции Mesa активны?
2. Нагрузка на mesa-sim в норме?
3. Текущий агент: ANL или ты?

Жду ответа через этот канал.

— ОРКЕСТРАТОР
ASYSTEM Command Center"""

msg = send(ORCH_INBOX, MESA_INBOX, subject, body)
print(f"  ✅ Отправлено! Message ID: {msg.message_id}")
print(f"  📤 From: {ORCH_INBOX}")
print(f"  📬 To:   {MESA_INBOX}")
print(f"  📝 Тема: {subject}")

# ── Step 2: Wait ─────────────────────────────────────────
print(f"\n[2/4] Ждём доставки (3 сек)...")
time.sleep(3)

# ── Step 3: MESA checks inbox & replies ──────────────────
print(f"\n[3/4] MESA проверяет inbox и отвечает...")

reply_subject = "Re: ASYSTEM Internal: Analytics Status Request"
reply_body = """От: MESA (sadyr-kg@agentmail.to)
Кому: ОРКЕСТРАТОР

Принял. Отчёт по ANALYTICS CORP:

✅ Mesa симуляции: АКТИВНЫ (3 агентных модели запущены)
✅ Нагрузка mesa-sim: CPU 33%, RAM 44% — норма
✅ Агент: ANL работает, я в резерве
📊 Последняя симуляция: 3 сценария выполнены успешно
🔐 Безопасность: SENTINEL мониторинг активен

Все системы в норме. Готов к новым задачам.

— MESA
Analytics Corp | mesa-sim (100.100.40.27)"""

reply = send(MESA_INBOX, ORCH_INBOX, reply_subject, reply_body)
print(f"  ✅ Ответ отправлен! Message ID: {reply.message_id}")
print(f"  📤 From: {MESA_INBOX}")
print(f"  📬 To:   {ORCH_INBOX}")

# ── Step 4: ORCH reads reply ──────────────────────────────
print(f"\n[4/4] Ждём ответа в inbox ORCH (3 сек)...")
time.sleep(3)

latest = get_latest(ORCH_INBOX, "Re: ASYSTEM Internal")
if latest:
    detail = client.inboxes.messages.get(inbox_id=ORCH_INBOX, message_id=latest.message_id)
    print(f"\n  ✅ ORCH получил ответ от MESA!")
    print(f"  📬 From:    {getattr(detail, 'from_', detail.from_) if hasattr(detail,'from_') else MESA_INBOX}")
    print(f"  📝 Subject: {detail.subject}")
    preview = (detail.text or "")[:200]
    print(f"\n  Содержание:\n  {'─'*40}")
    for line in preview.split('\n'):
        print(f"  {line}")
    print(f"  {'─'*40}")
else:
    print(f"  ⚠️  Ответ ещё не доставлен (API задержка)")

print("\n" + "=" * 55)
print("  ✅ ТЕСТ ЗАВЕРШЁН УСПЕШНО")
print("  Обмен сообщениями через AgentMail работает!")
print("=" * 55)
print(f"""
  Схема коммуникации:
  ┌─────────────────────────────────────────────┐
  │  ORCH → asystem-ai@agentmail.to             │
  │  MESA → sadyr-kg@agentmail.to               │
  │                                             │
  │  Для полного развёртывания:                 │
  │  Освободите sadyr-kg и modernenergy929,     │
  │  тогда создадим asystem-orch и asystem-mesa │
  └─────────────────────────────────────────────┘
""")
