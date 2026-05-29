#!/usr/bin/env python3
"""Deterministic extractor for the Ch.13 feat catalog.

Block anatomy (verified):
    FEAT NAME              <- line above "Category :"
    Category : General|Clan|...
    [Prerequisite: ...]
    <description + bullet (•) benefits>

Output: content/feats.json (array of {name, category, prerequisite, description,
benefits[], abilityIncrease}). No fabrication; unparsed fields are null/empty.
"""
import json
import re
from pathlib import Path
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT / "Naruto 5e - Full Document.pdf"
OUT = ROOT / "content" / "feats.json"
PAGE_START = 313
PAGE_END = 333

ABILITY = {"strength": "str", "dexterity": "dex", "constitution": "con", "intelligence": "int", "wisdom": "wis", "charisma": "cha"}


def clean(s: str) -> str:
    if s is None:
        return s
    s = s.replace("’", "'").replace("�", "'").replace("\r", " ")
    s = re.sub(r"[ \t]+", " ", s)
    return s.strip()


def name_like(s: str) -> bool:
    if not s or s.endswith(".") or s.endswith(","):
        return False
    alpha = [c for c in s if c.isalpha()]
    if not alpha:
        return False
    return sum(1 for c in alpha if c.isupper()) / len(alpha) >= 0.6 and len(s) <= 40


def slug(name, i):
    b = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return b or f"feat-{i}"


def parse_ability_increase(text: str):
    m = re.search(r"increase your ([A-Za-z]+)(?:\s+or\s+([A-Za-z]+))? score by (\d+)", text, re.I)
    if not m:
        return None
    a = ABILITY.get(m.group(1).lower())
    b = ABILITY.get(m.group(2).lower()) if m.group(2) else None
    amt = int(m.group(3))
    opts = [x for x in [a, b] if x]
    if not opts:
        return None
    return {"amount": amt, "options": opts}


def parse_prereq(text: str):
    if not text:
        return None
    out = {}
    for ab_name, ab in ABILITY.items():
        m = re.search(ab_name + r"\s+(\d+)", text, re.I)
        if m:
            out.setdefault("abilities", {})[ab] = int(m.group(1))
    lv = re.search(r"level\s+(\d+)", text, re.I)
    if lv:
        out["level"] = int(lv.group(1))
    cl = re.search(r"([A-Z][a-z]+)\s+Clan", text)
    if cl:
        out["clan"] = cl.group(1)
    out["text"] = clean(text)
    return out


def main():
    reader = PdfReader(str(PDF))
    lines = []
    for i in range(PAGE_START - 1, min(PAGE_END, len(reader.pages))):
        for ln in (reader.pages[i].extract_text() or "").split("\n"):
            lines.append((i + 1, ln))

    anchors = [k for k, (_, ln) in enumerate(lines) if ln.strip().lower().startswith("category")]
    feats = []
    seen = {}
    for ai, k in enumerate(anchors):
        page = lines[k][0]
        # name: walk back to a name-like line
        name = None
        j = k - 1
        steps = 0
        while j >= 0 and steps < 6:
            cand = clean(lines[j][1])
            j -= 1
            if not cand:
                continue
            steps += 1
            if name_like(cand):
                name = cand
                break
        if not name:
            continue
        end = anchors[ai + 1] - 1 if ai + 1 < len(anchors) else len(lines)
        block = "\n".join(ln for (_, ln) in lines[k:max(k + 1, end)])
        cat_m = re.search(r"Category\s*:?\s*([A-Za-z]+)", block)
        category = clean(cat_m.group(1)) if cat_m else "General"
        prereq_m = re.search(r"Prerequisite\s*:?\s*(.+)", block)
        prereq_text = clean(prereq_m.group(1).split("\n")[0]) if prereq_m else None
        # description = everything after the prereq/category header lines
        body = re.split(r"Prerequisite\s*:[^\n]*\n", block)
        body = body[-1] if len(body) > 1 else re.split(r"Category\s*:[^\n]*\n", block)[-1]
        desc = clean(re.sub(r"\s+", " ", body))
        bullets = [clean(b) for b in re.split(r"[•�▪]\s*|\n•", body) if clean(b)][1:]

        s = slug(name, ai)
        if s in seen:
            seen[s] += 1
            s = f"{s}-{seen[s]}"
        else:
            seen[s] = 0

        feats.append({
            "id": s,
            "name": name.title() if name.isupper() else name,
            "category": category,
            "prerequisite": parse_prereq(prereq_text) if prereq_text else None,
            "abilityIncrease": parse_ability_increase(desc),
            "benefits": bullets,
            "description": desc[:600],
            "source": {"document": "Naruto 5e - Full Document.pdf", "page": page},
        })

    OUT.write_text(json.dumps(feats, indent=2, ensure_ascii=False), encoding="utf-8")
    with_asi = sum(1 for f in feats if f["abilityIncrease"])
    with_pre = sum(1 for f in feats if f["prerequisite"])
    print(f"Extracted {len(feats)} feats -> {OUT}  (with ASI {with_asi}, with prereq {with_pre})")
    print("sample:", ", ".join(f["name"] for f in feats[:12]))


if __name__ == "__main__":
    main()
