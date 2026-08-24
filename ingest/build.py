"""
ParcelPilot offline ingestion pipeline.

Reads the supplied data pack and emits two artifacts consumed by the Next.js app:

  src/data/corpus.json  - document chunks, each tagged with the *authority metadata*
                          parsed out of the document itself (status, effective date,
                          supersession, account scope).
  src/data/db.json      - typed account / order / ticket records + dataset snapshot.

Design note: authority is PARSED, not hardcoded. A new agreement dropped into
data/raw/ is picked up, scoped to its account, and ranked above general policy
without touching application code. The only declarative input is KIND_PATTERNS,
which maps a document's self-declared identity to a precedence tier.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, asdict

import pandas as pd
import pdfplumber

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "data", "raw")
OUT = os.path.join(HERE, "..", "src", "data")

# --- Precedence tiers -------------------------------------------------------
# Support Policy v3 section 1 defines the order explicitly:
#   signed customer agreement > current support policy > current product docs
#   > historical tickets (context only).
TIER_CONTRACT = 1
TIER_POLICY = 2
TIER_PRODUCT = 3
TIER_HISTORICAL = 4

# Matched against the document TITLE only. Matching the body is unsafe: every
# policy document mentions the word "agreement" while describing precedence.
KIND_PATTERNS = [
    (r"support policy", TIER_POLICY, "support_policy"),
    (r"\bsop\b|standard operating|service credit|cancellation", TIER_POLICY, "sop"),
    (r"operations guide|known issues|product", TIER_PRODUCT, "product_doc"),
    (r"agreement|contract", TIER_CONTRACT, "customer_agreement"),
]

HEADER_LABELS = ("Account", "Customer", "Status", "Plan", "Term", "Effective",
                 "Updated", "Supersedes", "Superseded by")


@dataclass
class Chunk:
    chunk_id: str
    doc_id: str
    doc_title: str
    source_file: str
    kind: str
    authority_tier: int
    status: str                      # CURRENT | DEPRECATED | UNKNOWN
    effective: str
    supersedes: str
    superseded_by: str
    account_scope: str               # non-empty => only visible for that account
    section: str
    text: str
    page: int


def header_value(text, label):
    m = re.search(r"^\s*" + label + r"\s*:\s*(.+)$", text, re.I | re.M)
    return m.group(1).strip() if m else ""


def classify(title, account_scope):
    """Decide a document's precedence tier from its own identity.

    A document carrying an `Account:` header is, by definition, a signed
    agreement scoped to one customer, so it outranks general policy. Everything
    else is classified from its title.
    """
    if account_scope:
        return TIER_CONTRACT, "customer_agreement"
    hay = title.lower()
    for pat, tier, kind in KIND_PATTERNS:
        if re.search(pat, hay):
            return tier, kind
    return TIER_PRODUCT, "document"


def split_sections(text):
    """Split on numbered headings such as '1. Scope and source precedence'.

    Documents without numbered structure collapse to a single section.
    """
    sections = []
    current_head = "Preamble"
    current_body = []
    heading = re.compile(r"^\s*(\d+)\.\s+([A-Z][^\n]{2,80})\s*$")
    for ln in text.split("\n"):
        m = heading.match(ln)
        if m:
            if current_body:
                sections.append((current_head, current_body))
            current_head = m.group(1) + ". " + m.group(2).strip()
            current_body = []
        else:
            current_body.append(ln)
    if current_body:
        sections.append((current_head, current_body))
    out = []
    for head, body in sections:
        joined = "\n".join(body).strip()
        if joined:
            out.append((head, joined))
    return out


def derive_title(lines, fallback):
    if not lines:
        return fallback
    title = lines[0]
    # Some titles wrap onto a second line (the Northstar agreement does).
    if len(lines) > 1 and len(lines[0]) < 60:
        second = lines[1]
        is_header = any(re.match(r"^" + lab + r"\s*:", second, re.I) for lab in HEADER_LABELS)
        if not is_header:
            title = lines[0] + " " + second
    return title


def load_documents():
    chunks = []
    for fn in sorted(f for f in os.listdir(RAW) if f.lower().endswith(".pdf")):
        path = os.path.join(RAW, fn)
        with pdfplumber.open(path) as pdf:
            pages = [(i + 1, p.extract_text() or "") for i, p in enumerate(pdf.pages)]
        full = "\n".join(t for _, t in pages)
        lines = [l.strip() for l in full.split("\n") if l.strip()]

        title = derive_title(lines, fn)

        raw_status = header_value(full, "Status").upper()
        if "DEPRECAT" in raw_status:
            status = "DEPRECATED"
        elif "CURRENT" in raw_status or "ACTIVE" in raw_status:
            status = "CURRENT"
        else:
            status = raw_status or "UNKNOWN"

        effective = (header_value(full, "Effective")
                     or header_value(full, "Updated")
                     or header_value(full, "Term"))

        account_scope = ""
        acct_header = header_value(full, "Account")
        if acct_header:
            m = re.search(r"ACCT-\d+", acct_header)
            account_scope = m.group(0) if m else ""

        tier, kind = classify(title, account_scope)
        doc_id = os.path.splitext(fn)[0]

        # Map a line's opening text back to the page it appeared on, for citations.
        page_of = {}
        for pno, ptext in pages:
            for ln in ptext.split("\n"):
                page_of.setdefault(ln.strip()[:40], pno)

        for idx, (heading, body) in enumerate(split_sections(full)):
            first = body.split("\n")[0].strip()[:40]
            chunks.append(Chunk(
                chunk_id=doc_id + "#" + str(idx),
                doc_id=doc_id,
                doc_title=title,
                source_file=fn,
                kind=kind,
                authority_tier=tier,
                status=status,
                effective=effective,
                supersedes=header_value(full, "Supersedes"),
                superseded_by=header_value(full, "Superseded by"),
                account_scope=account_scope,
                section=heading,
                text=body,
                page=page_of.get(first, 1),
            ))
    return chunks


def load_workbook():
    xl = pd.ExcelFile(os.path.join(RAW, "ParcelPilot_Assessment_Data.xlsx"))
    readme = xl.parse("README")
    meta = {}
    for _, row in readme.iterrows():
        k = str(row.iloc[0]).strip()
        v = row.iloc[1]
        if k and k.lower() != "nan":
            meta[k] = "" if pd.isna(v) else str(v).strip()

    snapshot_raw = meta.get("Dataset snapshot", "")
    m = re.match(r"([\d\-]+\s[\d:]+)\s*(.*)", snapshot_raw)
    if m:
        snapshot_local, snapshot_tz = m.group(1), (m.group(2) or "Asia/Kolkata")
    else:
        snapshot_local, snapshot_tz = snapshot_raw, "Asia/Kolkata"

    def clean(df):
        recs = json.loads(df.to_json(orient="records", date_format="iso"))
        for r in recs:
            for k, v in list(r.items()):
                if isinstance(v, float) and pd.isna(v):
                    r[k] = None
        return recs

    return {
        "snapshot_local": snapshot_local,
        "snapshot_tz": snapshot_tz,
        "currency": meta.get("Currency", "INR"),
        "meta": meta,
        "accounts": clean(xl.parse("accounts")),
        "orders": clean(xl.parse("orders")),
        "tickets": clean(xl.parse("tickets")),
    }


def main():
    os.makedirs(OUT, exist_ok=True)
    chunks = load_documents()
    db = load_workbook()

    with open(os.path.join(OUT, "corpus.json"), "w", encoding="utf-8") as f:
        json.dump([asdict(c) for c in chunks], f, indent=2, ensure_ascii=False)
    with open(os.path.join(OUT, "db.json"), "w", encoding="utf-8") as f:
        json.dump(db, f, indent=2, ensure_ascii=False)

    docs = sorted({c.doc_id for c in chunks})
    print("corpus.json  " + str(len(chunks)) + " chunks from " + str(len(docs)) + " documents")
    for tier in (1, 2, 3, 4):
        got = [c for c in chunks if c.authority_tier == tier]
        if not got:
            continue
        labels = sorted({
            c.doc_id + "[" + c.status + "]" + ("@" + c.account_scope if c.account_scope else "")
            for c in got
        })
        print("  tier " + str(tier) + ": " + str(len(got)).rjust(2) + " chunks  " + ", ".join(labels))
    print("db.json      snapshot=" + db["snapshot_local"] + " " + db["snapshot_tz"] + "  "
          + str(len(db["accounts"])) + " accounts / " + str(len(db["orders"])) + " orders / "
          + str(len(db["tickets"])) + " tickets")


if __name__ == "__main__":
    main()
