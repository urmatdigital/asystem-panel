#!/usr/bin/env python3
"""
ASYSTEM Agent Email Setup
Creates inboxes for each agent, then sends test ORCH → MESA message chain
"""

import os, time
from agentmail import AgentMail
from agentmail.inboxes.types import CreateInboxRequest

API_KEY = "am_us_b598717c387b09321cc1482df6faacdf5ce61646223da10e94cb662f20726458"
client = AgentMail(api_key=API_KEY)

AGENTS = [
    {"id": "orch",     "username": "asystem-orch",     "display": "ОРКЕСТРАТОР", "dept": "orchestrator"},
    {"id": "arch",     "username": "asystem-arch",     "display": "ARCH",         "dept": "it_corp"},
    {"id": "coder",    "username": "asystem-coder",    "display": "CODER",        "dept": "it_corp"},
    {"id": "analyst",  "username": "asystem-analyst",  "display": "ANALYST",      "dept": "analytics"},
    {"id": "mesa",     "username": "asystem-mesa",     "display": "MESA",         "dept": "analytics"},
    {"id": "devops",   "username": "asystem-devops",   "display": "DEVOPS",       "dept": "ops"},
    {"id": "sentinel", "username": "asystem-sentinel", "display": "SENTINEL",     "dept": "security"},
]

def create_or_get_inbox(agent):
    username = agent["username"]
    email = f"{username}@agentmail.to"
    try:
        req = CreateInboxRequest(
            username=username,
            display_name=f"ASYSTEM {agent['display']}",
            client_id=f"asystem-{agent['id']}-v1"
        )
        inbox = client.inboxes.create(request=req)
        print(f"  ✅ Created: {inbox.inbox_id}")
        return inbox.inbox_id
    except Exception as e:
        err = str(e).lower()
        if "already" in err or "conflict" in err or "409" in err or "exist" in err:
            print(f"  ♻️  Exists:  {email}")
            return email
        else:
            print(f"  ❌ Error: {e}")
            return email  # return expected email anyway

print("=== ASYSTEM Agent Mail Setup ===\n")
print("Creating/verifying inboxes...")

inboxes = {}
for agent in AGENTS:
    print(f"  [{agent['display']:15s}] ", end="")
    inbox_id = create_or_get_inbox(agent)
    if inbox_id:
        inboxes[agent["id"]] = inbox_id

print(f"\n✅ Inboxes ready: {len(inboxes)}/{len(AGENTS)}")
for aid, email in inboxes.items():
    print(f"   {aid:12s} → {email}")

# Save config
config = "# ASYSTEM Agent Email Map\n# Auto-generated\n\nAGENT_EMAILS = {\n"
for aid, email in inboxes.items():
    config += f'    "{aid}": "{email}",\n'
config += "}\n\nAPI_KEY = \"am_us_b598717c387b09321cc1482df6faacdf5ce61646223da10e94cb662f20726458\"\n"

with open(os.path.join(os.path.dirname(__file__), "agent_emails.py"), "w") as f:
    f.write(config)
print("\n✅ Config saved → agent_emails.py")
