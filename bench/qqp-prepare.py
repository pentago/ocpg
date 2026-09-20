#!/usr/bin/env python3
"""One-off data prep for bench/qqp-consolidate.ts - NOT part of the Bun/TS
toolchain, not run by CI, not a project dependency. Downloads the public
GLUE QQP train split (Hugging Face, no auth, no Kaggle login required) and
writes a seeded, stratified sample of question pairs to
bench/data/qqp-sample.ndjson (gitignored - regenerate rather than commit,
same "throwaway data" discipline as every other bench in this project).

License note: Quora's Kaggle page for this data states "This data is subject
to Quora's Terms of Service, allowing for non-commercial use" - fine for this
local, non-commercial retrieval-quality benchmark; the sample is never
redistributed (gitignored) and the questions are only ever embedded and
compared locally.

Requires the `duckdb` Python package (not a Node/Bun dependency - this
script's only job is parquet -> ndjson, and duckdb reads Hugging Face's
public parquet export without any other tooling):

    python3 -m venv .venv && .venv/bin/pip install duckdb
    .venv/bin/python bench/qqp-prepare.py

Then run the actual bench: bun bench/qqp-consolidate.ts
"""

import argparse
import os
import urllib.request

import duckdb

QQP_URL = "https://huggingface.co/datasets/nyu-mll/glue/resolve/refs%2Fconvert%2Fparquet/qqp/train/0000.parquet"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-dup", type=int, default=2500, help="duplicate pairs to sample")
    ap.add_argument(
        "--n-nondup", type=int, default=2500, help="distinct pairs to sample"
    )
    ap.add_argument(
        "--seed", type=float, default=0.42, help="duckdb setseed() value, [-1, 1]"
    )
    ap.add_argument(
        "--cache-dir",
        default="/tmp/opencode/qqp",
        help="where the raw parquet is cached",
    )
    ap.add_argument(
        "--out",
        default=os.path.join(os.path.dirname(__file__), "data", "qqp-sample.ndjson"),
    )
    args = ap.parse_args()

    os.makedirs(args.cache_dir, exist_ok=True)
    parquet_path = os.path.join(args.cache_dir, "qqp-train.parquet")
    if not os.path.exists(parquet_path):
        print(f"Downloading QQP train split to {parquet_path} ...")
        urllib.request.urlretrieve(QQP_URL, parquet_path)
    else:
        print(f"Using cached {parquet_path}")

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    con = duckdb.connect()
    con.execute(f"SELECT setseed({args.seed})")
    con.execute(
        f"""
        COPY (
          WITH dup AS (
            SELECT question1, question2, label
            FROM '{parquet_path}'
            WHERE label = 1 AND question1 IS NOT NULL AND question2 IS NOT NULL
              AND length(question1) > 0 AND length(question2) > 0
            ORDER BY random()
            LIMIT {args.n_dup}
          ),
          nondup AS (
            SELECT question1, question2, label
            FROM '{parquet_path}'
            WHERE label = 0 AND question1 IS NOT NULL AND question2 IS NOT NULL
              AND length(question1) > 0 AND length(question2) > 0
            ORDER BY random()
            LIMIT {args.n_nondup}
          )
          SELECT * FROM dup UNION ALL SELECT * FROM nondup
        ) TO '{args.out}' (FORMAT JSON)
        """
    )
    print(
        f"Wrote {args.n_dup + args.n_nondup} pairs ({args.n_dup} dup / {args.n_nondup} nondup) to {args.out}"
    )


if __name__ == "__main__":
    main()
