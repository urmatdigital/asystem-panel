#!/usr/bin/env python3
"""
ZVec Migration — импорт ReMe JSON файлов в ZVec коллекцию.
Запуск: ~/.zvec-env/bin/python3 zvec_migrate.py
"""
import json, os, sys, time
from pathlib import Path

import zvec

REME_DIR   = Path.home() / ".reme/asystem/vector_store/reme"
ZVEC_PATH  = Path.home() / ".zvec/asystem"
DIM        = 1536   # OpenAI text-embedding-3-small / ada-002
COLLECTION = "forge_memory"

def main():
    if not REME_DIR.exists():
        print(f"❌ ReMe dir not found: {REME_DIR}")
        sys.exit(1)

    files = list(REME_DIR.glob("*.json"))
    print(f"📂 Found {len(files)} ReMe entries → migrating to ZVec")

    ZVEC_PATH.mkdir(parents=True, exist_ok=True)

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

    db_path = str(ZVEC_PATH / COLLECTION)
    try:
        col = zvec.open(path=db_path, schema=schema)
        print(f"♻️  Opened existing ZVec collection at {db_path}")
    except Exception:
        col = zvec.create_and_open(path=db_path, schema=schema)
        print(f"✨ Created new ZVec collection at {db_path}")

    ok, skip, err = 0, 0, 0
    batch = []

    for f in files:
        try:
            d = json.loads(f.read_text())
            vec = d.get("vector")
            if not vec or len(vec) != DIM:
                skip += 1
                continue

            doc_id = d.get("vector_id") or f.stem
            content = d.get("content", "")
            meta    = d.get("metadata", {})

            batch.append(zvec.Doc(
                id=doc_id,
                vectors={"embedding": [float(x) for x in vec]},
                fields={
                    "content":       content[:2000],
                    "memory_type":   str(meta.get("memory_type", "")),
                    "memory_target": str(meta.get("memory_target", "")),
                    "time_created":  str(meta.get("time_created", "")),
                    "author":        str(meta.get("author", "")),
                }
            ))

            if len(batch) >= 50:
                col.insert(batch)
                ok += len(batch)
                print(f"  ✅ Inserted {ok}/{len(files)} docs...")
                batch = []

        except Exception as e:
            err += 1
            print(f"  ⚠️  Skip {f.name}: {e}")

    if batch:
        col.insert(batch)
        ok += len(batch)

    print(f"\n🎉 Migration complete: {ok} inserted, {skip} skipped (bad dim), {err} errors")
    print(f"📍 ZVec DB: {db_path}")

    # Quick test search
    print("\n🔍 Test search: 'atlas agent status'")
    import numpy as np
    test_vec = [0.0] * DIM  # zero vector = test only
    results = col.query(
        zvec.VectorQuery("embedding", vector=test_vec),
        topk=3
    )
    print(f"   Top {len(results)} results returned ✅")

if __name__ == "__main__":
    t0 = time.time()
    main()
    print(f"⏱️  Total time: {time.time()-t0:.2f}s")
