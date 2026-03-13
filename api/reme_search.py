#!/usr/bin/env python3
"""
Fast ReMe vector search — cosine similarity без LLM reasoning chain.
Читает .json файлы из ~/.reme/asystem/vector_store/reme/ напрямую.
Embedding запроса через OpenAI text-embedding-3-small.

Usage:
  python3 reme_search.py search "query" [--top 5]
  python3 reme_search.py add "content"
  python3 reme_search.py list
"""
import sys, json, os, math
from pathlib import Path

STORE_DIR = Path.home() / ".reme" / "asystem" / "vector_store" / "reme"
STORE_DIR.mkdir(parents=True, exist_ok=True)


def cosine_similarity(a: list, b: list) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def get_embedding(text: str) -> list:
    import urllib.request
    api_key = os.environ.get("OPENAI_API_KEY", "")
    payload = json.dumps({"input": text, "model": "text-embedding-3-small"}).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/embeddings",
        data=payload,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read())
    return data["data"][0]["embedding"]


def load_all() -> list:
    items = []
    for f in STORE_DIR.glob("*.json"):
        try:
            items.append(json.loads(f.read_text()))
        except Exception:
            pass
    return items


def search(query: str, top_k: int = 5) -> list:
    items = load_all()
    if not items:
        return []
    q_vec = get_embedding(query)
    scored = []
    for item in items:
        vec = item.get("vector", [])
        if vec:
            score = cosine_similarity(q_vec, vec)
            scored.append({"score": round(score, 4), "content": item.get("content", ""), "id": item.get("vector_id", "")})
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:top_k]


def add(content: str) -> dict:
    import uuid, datetime
    vec = get_embedding(content)
    vid = uuid.uuid4().hex[:16]
    entry = {
        "vector_id": vid,
        "content": content,
        "vector": vec,
        "metadata": {
            "memory_type": "personal",
            "memory_target": "forge",
            "time_created": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
    }
    (STORE_DIR / f"{vid}.json").write_text(json.dumps(entry, ensure_ascii=False))
    return {"ok": True, "id": vid, "content": content}


def list_all(limit: int = 20) -> list:
    items = load_all()
    items.sort(key=lambda x: x.get("metadata", {}).get("time_created", ""), reverse=True)
    return [{"id": i.get("vector_id"), "content": i.get("content", ""), "created": i.get("metadata", {}).get("time_created", "")} for i in items[:limit]]


if __name__ == "__main__":
    args = sys.argv[1:]
    cmd = args[0] if args else "search"

    top_k = 5
    if "--top" in args:
        idx = args.index("--top")
        top_k = int(args[idx + 1])
        args = [a for i, a in enumerate(args) if i != idx and i != idx + 1]

    if cmd == "search":
        query = " ".join(args[1:]) or "ASYSTEM"
        results = search(query, top_k)
        print(json.dumps({"ok": True, "results": results, "query": query}, ensure_ascii=False, indent=2))

    elif cmd == "add":
        content = " ".join(args[1:])
        print(json.dumps(add(content), ensure_ascii=False))

    elif cmd == "list":
        print(json.dumps(list_all(), ensure_ascii=False, indent=2))

    else:
        print(json.dumps({"error": f"Unknown: {cmd}"}))
        sys.exit(1)
