#!/usr/bin/env ~/.zvec-env/bin/python3
"""
reme_search_zvec.py — ZVec-powered semantic search (replaces reme_search.py)
Usage:
  Search:  python3 reme_search_zvec.py --query "atlas agent" --top 5
  Add:     python3 reme_search_zvec.py --add "content text" --type fact --target forge
  Stats:   python3 reme_search_zvec.py --stats
"""
import sys, os, json, argparse, time
sys.path.insert(0, os.path.dirname(__file__))

ZVEC_PATH   = os.path.expanduser("~/.zvec/asystem")
COLLECTION  = "forge_memory"
DIM         = 1536
OPENAI_KEY  = os.environ.get("OPENAI_API_KEY", "")

import zvec

def get_collection():
    import zvec
    db_path = os.path.join(ZVEC_PATH, COLLECTION)
    schema = zvec.CollectionSchema(
        name=COLLECTION,
        fields=[
            zvec.FieldSchema("content",       zvec.DataType.STRING),
            zvec.FieldSchema("memory_type",   zvec.DataType.STRING),
            zvec.FieldSchema("memory_target", zvec.DataType.STRING),
            zvec.FieldSchema("time_created",  zvec.DataType.STRING),
            zvec.FieldSchema("author",        zvec.DataType.STRING),
        ],
        vectors=zvec.VectorSchema("embedding", zvec.DataType.VECTOR_FP32, DIM),
    )
    if os.path.exists(db_path):
        return zvec.open(db_path)
    return zvec.create_and_open(path=db_path, schema=schema)

def embed(text: str) -> list[float]:
    """Get OpenAI embedding for text."""
    import urllib.request
    payload = json.dumps({"input": text[:8000], "model": "text-embedding-3-small"}).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/embeddings",
        data=payload,
        headers={"Authorization": f"Bearer {OPENAI_KEY}", "Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())["data"][0]["embedding"]

def _adaptive_fetch_k(query: str, top: int, has_filters: bool) -> int:
    """
    SimpleMem pattern: Adaptive Query-Aware Retrieval.
    Adjust fetch scope based on query complexity + filters.
    Simple query (≤4 words)  → tight scope (top * 2)
    Medium query (5-10 words) → normal scope (top * 4)
    Complex query (>10 words) → wide scope (top * 6)
    + extra multiplier if filters active (need to over-fetch to find matches)
    """
    word_count = len(query.split())
    if word_count <= 4:
        base = 2
    elif word_count <= 10:
        base = 4
    else:
        base = 6
    multiplier = base * (2 if has_filters else 1)
    return max(top, top * multiplier)


def search(query: str, top: int = 5, target: str = None, memory_type: str = None) -> list[dict]:
    """
    Semantic search with SimpleMem Adaptive Query-Aware Retrieval.

    Filters:
      target      — agent (forge/atlas/iron/mesa/...)
      memory_type — semantic | episodic | personal | system

    Adaptive fetch_k: scales with query complexity and active filters.
    Simple queries → tight scope; complex multi-word → wide scope.
    """
    t0 = time.time()
    col = get_collection()
    vec = embed(query)

    has_filters = bool(target or memory_type)
    fetch_k = _adaptive_fetch_k(query, top, has_filters)

    results = col.query(
        zvec.VectorQuery("embedding", vector=vec),
        topk=fetch_k
    )

    out = []
    for r in results:
        fields = r.fields if hasattr(r, 'fields') else {}
        mem_target = fields.get("memory_target", "")
        mem_type   = fields.get("memory_type", "")

        if target and mem_target and mem_target != target:
            continue
        if memory_type and mem_type and mem_type != memory_type:
            continue

        out.append({
            "id":      r.id,
            "score":   round(r.score, 4),
            "content": fields.get("content", "")[:500],
            "type":    mem_type,
            "target":  mem_target,
            "created": fields.get("time_created", ""),
        })
        if len(out) >= top:
            break

    elapsed = round((time.time() - t0) * 1000, 1)
    return out, elapsed

def semantic_compress(content: str) -> str:
    """
    SimpleMem pattern: Semantic Structured Compression.
    Convert long text → compact atomic fact (entropy-aware).
    Only applies to content > 200 chars — short facts pass through.
    Uses gpt-4o-mini for speed/cost.
    """
    if len(content) <= 200:
        return content  # already atomic

    import urllib.request
    prompt = (
        "Extract the single most important atomic fact from this text. "
        "Remove filler, context, and redundancy. "
        "Output ONLY the compressed fact in one sentence (max 150 chars):\n\n"
        + content[:1500]
    )
    payload = json.dumps({
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": 100,
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=payload,
        headers={"Authorization": f"Bearer {OPENAI_KEY}", "Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            compressed = json.loads(r.read())["choices"][0]["message"]["content"].strip()
        return compressed if len(compressed) > 10 else content[:300]
    except Exception:
        return content[:300]  # fallback: truncate


def add_memory(content: str, memory_type: str = "fact", target: str = "forge") -> dict:
    import hashlib, datetime
    # SimpleMem: Semantic compression for long semantic/fact memories
    original_len = len(content)
    if memory_type in ("semantic", "fact") and original_len > 200:
        content = semantic_compress(content)
    vec = embed(content)
    doc_id = hashlib.sha256(content.encode()).hexdigest()[:16]
    col = get_collection()
    col.insert([zvec.Doc(
        id=doc_id,
        vectors={"embedding": vec},
        fields={
            "content":       content[:2000],
            "memory_type":   memory_type,
            "memory_target": target,
            "time_created":  datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "author":        "",
        }
    )])
    return {"ok": True, "id": doc_id, "original_len": original_len, "stored_len": len(content)}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--query",  "-q", help="Search query")
    parser.add_argument("--top",    "-t", type=int, default=5)
    parser.add_argument("--target",       help="Filter by agent target (forge/atlas/...)")
    parser.add_argument("--mtype",        help="Filter by memory type: semantic|episodic|personal|system")
    parser.add_argument("--add",          help="Add memory content")
    parser.add_argument("--type",         default="semantic", help="Memory type when adding (semantic/episodic/personal/system)")
    parser.add_argument("--stats",        action="store_true")
    args = parser.parse_args()

    if args.stats:
        col = get_collection()
        print(json.dumps({"engine": "zvec", "collection": COLLECTION, "dim": DIM, "path": ZVEC_PATH}))
        return

    if args.add:
        result = add_memory(args.add, args.type, args.target or "forge")
        print(json.dumps(result))
        return

    if args.query:
        results, elapsed_ms = search(args.query, args.top, args.target, args.mtype)
        print(json.dumps({
            "query":      args.query,
            "results":    results,
            "count":      len(results),
            "elapsed_ms": elapsed_ms,
            "engine":     "zvec"
        }, ensure_ascii=False, indent=2))
        return

    parser.print_help()

if __name__ == "__main__":
    main()
