#!/usr/bin/env python3
"""
ReMe Memory Integration for ASYSTEM Forge v2
Vector-based memory: personal + procedural + tool memories

Usage:
  python3 reme_memory.py search "query" [--user urmat]
  python3 reme_memory.py add "content" [--user urmat]
  python3 reme_memory.py list [--user urmat]
"""

import asyncio
import sys
import json
import os
from pathlib import Path

WORKING_DIR = str(Path.home() / ".reme" / "asystem")
os.makedirs(WORKING_DIR, exist_ok=True)
DEFAULT_USER = "forge"


def get_reme_config():
    # ReMe's internal reasoning chain требует настоящий OpenAI (не Anthropic proxy)
    openai_key = os.environ.get("OPENAI_API_KEY", "")
    return {
        "working_dir": WORKING_DIR,
        "default_llm_config": {
            "backend": "openai",
            "model_name": "gpt-4o-mini",   # OpenAI напрямую — Anthropic proxy не совместим с ReMe react chain
            "api_key": openai_key,
        },
        "default_embedding_model_config": {
            "backend": "openai",
            "model_name": "text-embedding-3-small",
            "api_key": openai_key,
        },
        "default_vector_store_config": {"backend": "local"},
        "enable_profile": False,  # отключаем profiler — не нужен
    }


async def _make_reme():
    from reme import ReMe
    reme = ReMe(**get_reme_config())
    await reme.start()
    return reme


async def search_memory(query: str, user: str = DEFAULT_USER):
    reme = await _make_reme()
    try:
        result = await reme.retrieve_memory(
            query=query,
            user_name=user,
            return_dict=True,
            enable_thinking_params=False,
        )
        if isinstance(result, dict):
            return {"answer": result.get("answer", ""), "memories": result.get("memories", [])}
        return {"answer": str(result), "memories": []}
    except Exception as e:
        return {"answer": "", "memories": [], "error": str(e)}
    finally:
        await reme.close()


async def add_memory(content: str, user: str = DEFAULT_USER):
    reme = await _make_reme()
    try:
        node = await reme.add_memory(memory_content=content, user_name=user)
        return {"ok": True, "id": str(getattr(node, 'memory_id', 'unknown')), "content": content}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        await reme.close()


async def list_memories(user: str = DEFAULT_USER, limit: int = 20):
    reme = await _make_reme()
    try:
        memories = await reme.list_memory(user_name=user, limit=limit)
        if isinstance(memories, list):
            return [str(m) for m in memories]
        return [str(memories)]
    except Exception as e:
        return [f"Error: {e}"]
    finally:
        await reme.close()


if __name__ == "__main__":
    args = sys.argv[1:]
    cmd = args[0] if args else "search"
    user = DEFAULT_USER

    if "--user" in args:
        idx = args.index("--user")
        user = args[idx + 1]
        args = [a for i, a in enumerate(args) if i != idx and i != idx + 1]

    if cmd == "search":
        query = " ".join(args[1:]) or "ASYSTEM status"
        print(json.dumps(asyncio.run(search_memory(query, user)), ensure_ascii=False, indent=2, default=str))

    elif cmd == "add":
        content = " ".join(args[1:])
        print(json.dumps(asyncio.run(add_memory(content, user)), ensure_ascii=False))

    elif cmd == "list":
        print(json.dumps(asyncio.run(list_memories(user)), ensure_ascii=False, indent=2, default=str))

    else:
        print(json.dumps({"error": f"Unknown command: {cmd}"}))
        sys.exit(1)
