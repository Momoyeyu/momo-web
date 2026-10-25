#!/usr/bin/env python3
"""Fixed local recall/latency evaluation without opening any database.

Run from backend with uv run python scripts/benchmark_embedding.py.
Small fixture is a product smoke benchmark, not an academic quality claim.
"""
from pathlib import Path
import json
import platform
import resource
import statistics
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
from app.core import embed
from app.core.text import bigrams, jaccard
from app.services.memory import W_SEMANTIC, W_RECENCY


def main():
    fixture = json.loads((Path(__file__).resolve().parents[1] / 'tests/fixtures/embedding_recall.json').read_text())
    memories = fixture['memories']
    start = time.perf_counter()
    first = embed.embed(memories[0], {'role': 'passage'})
    cold = time.perf_counter() - start
    if first is None:
        raise SystemExit(embed.status())
    matrix = np.array([first] + [embed.embed(m, {'role':'passage'}) for m in memories[1:]])
    stats = {'semantic_top1':0,'semantic_top3':0,'lexical_top1':0,'lexical_top3':0,'final_top5':0}
    latency, cases = [], []
    for case in fixture['queries']:
        start = time.perf_counter()
        vector = embed.embed(case['query'])
        latency.append((time.perf_counter()-start)*1000)
        scores = matrix @ np.array(vector)
        semantic = np.argsort(-scores).tolist()
        lexical = sorted(range(len(memories)), key=lambda i: (jaccard(bigrams(case['query']), bigrams(memories[i])),i), reverse=True)
        lexical = [i for i in lexical if jaccard(bigrams(case['query']),bigrams(memories[i])) > 0]
        coarse = semantic[:15]
        final = sorted(coarse,key=lambda i:W_SEMANTIC*scores[i]+W_RECENCY*((i+1)/len(memories)),reverse=True)[:5]
        expected = case['expected']
        for label, ranking in [('semantic',semantic),('lexical',lexical)]:
            stats[label+'_top1'] += expected in ranking[:1]
            stats[label+'_top3'] += expected in ranking[:3]
        stats['final_top5'] += expected in final
        cases.append({**case,'semantic_rank':semantic.index(expected)+1,'lexical_rank':lexical.index(expected)+1 if expected in lexical else None,'final_top5_hit':expected in final})
    print(json.dumps({'platform':platform.platform(),'model':embed.MODEL_ID,'fixtures':len(cases),
          'hits':stats,'cold_seconds':cold,'warm_median_ms':statistics.median(latency),
          'warm_p95_ms':sorted(latency)[int(len(latency)*.95)],
          'peak_rss_bytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
          'cases':cases},indent=2,ensure_ascii=False))


if __name__ == '__main__': main()
