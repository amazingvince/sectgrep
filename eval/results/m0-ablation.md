# Milestone 0 ablation: chunk text, stemming, and mean-centering

Generated 2026-09-03T01:17:52. Recall@5 on the fixture question set, current Expressions only; cross-ref counts all 18 author-written questions before the adversarial filter. Model `minishlab/potion-retrieval-32M` (static, mean-of-token embeddings).

| Leg | Chunk text | Treatment | locate | definition | cross-ref |
|---|---|---|---|---|---|
| vector | body | raw | 1.00 | 0.90 | 1.00 |
| vector | body | mean-centered | 0.95 | 0.95 | 0.89 |
| bm25 | body | raw | 0.87 | 0.95 | 1.00 |
| bm25 | body | stemmed | 0.92 | 0.95 | 1.00 |
| hybrid RRF | body | bm25 raw + vector raw | 1.00 | 1.00 | 1.00 |
| hybrid RRF | body | bm25 stemmed + vector mean-centered | 0.98 | 1.00 | 1.00 |
| vector | context+body | raw | 1.00 | 0.90 | 0.94 |
| vector | context+body | mean-centered | 0.97 | 0.95 | 0.89 |
| bm25 | context+body | raw | 0.87 | 0.90 | 0.94 |
| bm25 | context+body | stemmed | 0.90 | 0.80 | 1.00 |
| hybrid RRF | context+body | bm25 raw + vector raw | 1.00 | 1.00 | 1.00 |
| hybrid RRF | context+body | bm25 stemmed + vector mean-centered | 0.98 | 1.00 | 1.00 |
| vector | title+context+body | raw | 1.00 | 0.90 | 0.94 |
| vector | title+context+body | mean-centered | 0.97 | 1.00 | 0.89 |
| bm25 | title+context+body | raw | 0.87 | 0.90 | 0.94 |
| bm25 | title+context+body | stemmed | 0.90 | 0.80 | 1.00 |
| hybrid RRF | title+context+body | bm25 raw + vector raw | 0.98 | 1.00 | 1.00 |
| hybrid RRF | title+context+body | bm25 stemmed + vector mean-centered | 0.98 | 1.00 | 1.00 |
| vector | breadcrumb+context+body | raw | 1.00 | 0.85 | 0.94 |
| vector | breadcrumb+context+body | mean-centered | 0.97 | 1.00 | 0.89 |
| bm25 | breadcrumb+context+body | raw | 0.87 | 0.90 | 0.94 |
| bm25 | breadcrumb+context+body | stemmed | 0.90 | 0.80 | 1.00 |
| hybrid RRF | breadcrumb+context+body | bm25 raw + vector raw | 0.98 | 0.95 | 1.00 |
| hybrid RRF | breadcrumb+context+body | bm25 stemmed + vector mean-centered | 0.97 | 1.00 | 0.94 |

Reading: a static embedder averages token vectors, so a prefix shared by every chunk (the breadcrumb) moves every vector toward one common direction and cosine stops discriminating; subtracting the corpus mean removes that direction. BM25 without stemming misses `exits` vs `exit`, `firefighters` vs `firefighting`, `hazard` vs `hazardous`.

