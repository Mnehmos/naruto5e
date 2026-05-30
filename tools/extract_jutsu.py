#!/usr/bin/env python3
"""Deterministic extractor for the Naruto 5e jutsu catalog.

Walks the source PDF (Chapters 10-12, the jutsu lists) and pulls each uniform
stat block into a structured record. The block anatomy (verified from the
source) is:

    NAME                       <- line immediately above "Classification:"
    Classification: <type>
    Rank: <X>-Rank
    Casting Time: <...>
    Range: <...>
    Duration: <...>
    Components: <...>
    Cost: <N> Chakra
    Keywords: <...>
    Description: <multiline ...>
    [At Higher Levels/Ranks: <...>]

Output: content/jutsu_catalog.json  (array of jutsu records)

No data is fabricated. Fields that cannot be parsed are left null and flagged
via the *_verified booleans, per the spec's provenance rule.
"""
import json
import re
import sys
from pathlib import Path

from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT / "Naruto 5e - Full Document.pdf"
OUT = ROOT / "content" / "jutsu_catalog.json"

# Jutsu list chapters (1-indexed pages from survey): Ch10 p193, Ch11 p269, Ch12 p287.
# Catalog runs from the start of Ch10 to roughly the end of Ch12 (~p300).
PAGE_START = 193  # 1-indexed; Ch10 begins here
PAGE_END = 312    # 1-indexed inclusive; jutsu lists end before Ch13 (p313)

RANK_HEADER = re.compile(r"^[ESDCBA]-RANK\b", re.I)
RANK_VAL = re.compile(r"\b([ESDCBA])-?Rank\b", re.I)
PAGE_NUM = re.compile(r"^\d{1,3}\s*$")
SECTION_HINTS = (
    "RELEASE", "NINJUTSU", "GENJUTSU", "TAIJUTSU", "BUKIJUTSU", "HIJUTSU",
    "CHAPTER", "NON-ELEMENTAL", "ELEMENTAL",
)

FIELD_LABELS = [
    "Classification", "Rank", "Casting Time", "Range", "Duration",
    "Components", "Cost", "Keywords", "Prerequisites", "Prerequisite",
    "Description",
]


def clean(s: str) -> str:
    if s is None:
        return s
    s = s.replace("�", "'").replace("’", "'")
    s = s.replace("\r", " ")
    s = re.sub(r"[ \t]+", " ", s)
    return s.strip()


def normalize_name(s: str) -> str:
    s = clean(s)
    # Collapse stray internal spaces in ALL-CAPS OCR like "CHAKRA  HANDS"
    s = re.sub(r"\s+", " ", s)
    return s.title() if s.isupper() else s


def rank_letter(raw: str):
    if not raw:
        return None
    m = RANK_VAL.search(raw)
    return m.group(1).upper() if m else None


def parse_cost(raw: str):
    if not raw:
        return None
    m = re.search(r"(\d+)", raw)
    return int(m.group(1)) if m else None


def parse_components(raw: str):
    if not raw:
        return []
    raw = clean(raw)
    comps = []
    for token in re.findall(r"\b(HS|CM|CS|M|W|NT)\b", raw):
        if token not in comps:
            comps.append(token)
    return comps


SAVE_ABILITY = {
    "strength": "str", "dexterity": "dex", "constitution": "con",
    "intelligence": "int", "wisdom": "wis", "charisma": "cha",
}
DAMAGE_TYPES = [
    "fire", "water", "wind", "earth", "lightning", "ice", "cold", "slashing",
    "piercing", "bludgeoning", "force", "psychic", "acid", "poison", "necrotic",
    "radiant", "thunder", "fall",
]
CONDITIONS = [
    "Blinded", "Charmed", "Deafened", "Frightened", "Grappled", "Incapacitated",
    "Invisible", "Paralyzed", "Petrified", "Poisoned", "Prone", "Restrained",
    "Stunned", "Unconscious",
    # Naruto-specific damage-over-time conditions
    "Burned", "Bleeding",
]


def derive_effect(rec: dict) -> dict:
    """Heuristic structured effect from the free-text description, so the engine
    can resolve the mechanical 90% of a cast (attack/save + damage + condition).
    Utility jutsu that don't parse get delivery 'utility' (DM narrates)."""
    desc = re.sub(r"\s+", " ", (rec.get("description") or ""))
    low = desc.lower()
    effect: dict = {"delivery": "utility"}

    # base damage: first "<X>d<Y> ... damage" occurrence
    dmg = None
    for m in re.finditer(r"(\d+d\d+)\s*(?:\+\s*[A-Za-z ]+?)?\s*(\w+)?\s*damage", desc, re.I):
        dice = m.group(1)
        type_word = (m.group(2) or "").lower()
        dtype = type_word if type_word in DAMAGE_TYPES else None
        if dtype is None:
            # look in a small window before "damage" for a type keyword
            window = low[max(0, m.start() - 40): m.end()]
            for t in DAMAGE_TYPES:
                if t in window:
                    dtype = t
                    break
        dmg = {"dice": dice, "type": dtype or "force"}
        break
    if dmg:
        effect["damage"] = dmg

    # healing — dice may come before OR after "hit points" ("regain X hp" / "regains
    # hit points equal to Xdy" / "heal a creature for Xdy").
    hm = re.search(r"(?:regain|heal|restore|mend)\w*\s+(?:up to\s+)?(\d+d\d+|\d+)\s*(?:hit points|hp|health)", low)
    if not hm:
        # "regains [a number of] hit points equal to XdY" — allow words between the
        # heal verb and "hit points" (was too strict; missed e.g. Healing Hands).
        hm = re.search(r"(?:regain|heal|restore|mend)\w*\b.{0,40}?(?:hit points|hp|health)\s*(?:equal to|of)?\s*(\d+d\d+|\d+)", low)
    if not hm:
        # "heal/restore ... equal to XdY" with no literal 'hit points' right before the dice
        hm = re.search(r"(?:regain|heal|restore|mend)\w*\b.{0,40}?(?:equal to|of)\s+(\d+d\d+|\d+)", low)
    if hm:
        effect["healing"] = {"dice": hm.group(1)}

    # delivery
    save_m = re.search(r"(strength|dexterity|constitution|intelligence|wisdom|charisma)\s+saving throw", low)
    attack_m = re.search(r"(?:make|making)\s+(?:a|an)\s+(?:ranged\s+|melee\s+)?[\w ]*?attack|attack roll", low)
    if save_m:
        effect["delivery"] = "save"
        effect["saveAbility"] = SAVE_ABILITY[save_m.group(1)]
        # "half as much on a successful one" / "half the damage" / "half damage" — any
        # "half" in a save jutsu's text means half-on-save (the prior regex was too strict).
        if re.search(r"\bhalf\b", low):
            effect["halfOnSave"] = True
    elif attack_m:
        effect["delivery"] = "attack"
    elif dmg:
        effect["delivery"] = "auto"  # "each creature ... takes" with no save

    # multi-projectile: "make N ... attacks" (e.g. Phoenix Fire -> 3 attacks)
    hm2 = re.search(r"make\s+(\d+)\s+[\w ]*?attack", low)
    if hm2 and int(hm2.group(1)) > 1:
        effect["delivery"] = "attack"
        effect["hits"] = int(hm2.group(1))

    # conditions (attach the save ability if there is one)
    conds = []
    for c in CONDITIONS:
        if re.search(r"\b" + c.lower() + r"\b", low):
            conds.append({"name": c, "save": effect.get("saveAbility")})
    if conds:
        effect["conditions"] = conds

    # area shape from range/duration text (for the visualizer + AoE)
    rng = (rec.get("range") or "")
    area = None
    am = re.search(r"(\d+)\s*-?\s*foot\s*(sphere|radius|cone|line|cube|square)", (rng + " " + desc), re.I)
    if am:
        area = {"size": int(am.group(1)), "shape": am.group(2).lower()}
    if area:
        effect["area"] = area

    # concentration flag
    if "concentration" in (rec.get("duration") or "").lower():
        effect["concentration"] = True

    return effect


def slugify(name: str, idx: int) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", (name or f"jutsu-{idx}").lower()).strip("-")
    return base or f"jutsu-{idx}"


def main():
    if not PDF.exists():
        print(f"PDF not found: {PDF}", file=sys.stderr)
        sys.exit(1)
    reader = PdfReader(str(PDF))
    lines = []
    for i in range(PAGE_START - 1, min(PAGE_END, len(reader.pages))):
        text = reader.pages[i].extract_text() or ""
        for ln in text.split("\n"):
            lines.append((i + 1, ln))

    # Find every "Classification:" anchor; the block name is the prior content line.
    records = []
    seen_slugs = {}
    n = len(lines)
    # tolerate "Classification:" AND "Classification :" (OCR sometimes spaces the colon) —
    # otherwise space-colon blocks get swallowed into the preceding jutsu's text.
    anchor_re = re.compile(r"^\s*classification\s*:", re.I)
    anchor_idxs = [k for k, (_, ln) in enumerate(lines) if anchor_re.match(ln)]

    for a_i, k in enumerate(anchor_idxs):
        page = lines[k][0]
        # name: walk backwards for a NAME-LIKE line. Jutsu names render ALL CAPS
        # in the source, so require a high uppercase ratio and no trailing period
        # (skips description / "At Higher Ranks" spillover that lands above the anchor).
        def name_like(s: str) -> bool:
            if not s or s.endswith(".") or s.endswith(","):
                return False
            alpha = [c for c in s if c.isalpha()]
            if not alpha:
                return False
            upper_ratio = sum(1 for c in alpha if c.isupper()) / len(alpha)
            return upper_ratio >= 0.6

        name = None
        j = k - 1
        steps = 0
        while j >= 0 and steps < 8:
            cand = clean(lines[j][1])
            j -= 1
            if not cand:
                continue
            steps += 1
            if PAGE_NUM.match(cand) or RANK_HEADER.match(cand):
                continue
            up = cand.upper()
            # skip pure section headers (short all-caps with a known section hint)
            if cand.isupper() and any(h in up for h in SECTION_HINTS) and len(cand.split()) <= 3:
                continue
            if name_like(cand):
                name = cand
                break

        # block end = next anchor's name line (one line before next Classification) or EOF
        block_end = anchor_idxs[a_i + 1] - 1 if a_i + 1 < len(anchor_idxs) else n
        # gather block text from anchor to just before next block's name
        block_lines = [ln for (_, ln) in lines[k: max(k + 1, block_end)]]
        block = "\n".join(block_lines)

        def grab(label, nxt_labels):
            # capture text after "label:" up to the next field label
            pat = re.compile(
                rf"{label}\s*:?\s*(.*?)(?=\n\s*(?:{'|'.join(re.escape(l) for l in nxt_labels)})\s*:|\Z)",
                re.S | re.I,
            )
            m = pat.search(block)
            return clean(m.group(1)) if m else None

        classification = grab("Classification", ["Rank", "Casting Time"])
        rank_raw = grab("Rank", ["Casting Time", "Range"])
        casting = grab("Casting Time", ["Range", "Duration"])
        rng = grab("Range", ["Duration", "Components"])
        duration = grab("Duration", ["Components", "Cost", "Keywords"])
        components = grab("Components", ["Cost", "Keywords", "Description"])
        cost_raw = grab("Cost", ["Keywords", "Description", "Prerequisites"])
        keywords = grab("Keywords", ["Description", "Prerequisites", "Prerequisite"])
        desc = grab("Description", ["Classification"])
        higher = None
        hm = re.search(r"At Higher (?:Levels|Ranks)\s*:?\s*(.*)", block, re.S | re.I)
        if hm:
            higher = clean(hm.group(1))
            if desc:
                desc = re.split(r"At Higher (?:Levels|Ranks)\s*:?", desc, flags=re.I)[0].strip()

        rl = rank_letter(rank_raw)
        cost = parse_cost(cost_raw)
        # validity gate: must have a classification and a rank to be a real block
        if not classification or not rl:
            continue
        cls = clean(classification)
        # normalize classification to canonical set (space-tolerant: OCR may split "Genjuts u")
        cls_compact = re.sub(r"\s+", "", cls).lower()
        cls_norm = None
        for c in ["Ninjutsu", "Genjutsu", "Taijutsu", "Bukijutsu", "Hijutsu", "Medical"]:
            if c.lower() in cls_compact:
                cls_norm = c
                break
        cls_norm = cls_norm or cls

        slug = slugify(name, a_i)
        if slug in seen_slugs:
            seen_slugs[slug] += 1
            slug = f"{slug}-{seen_slugs[slug]}"
        else:
            seen_slugs[slug] = 0

        keyword_list = []
        if keywords:
            keyword_list = [clean(x) for x in re.split(r"[,/;]", keywords) if clean(x)]

        rec = {
            "id": slug,
            "name": normalize_name(name) if name else None,
            "classification": cls_norm,
            "rank": rl,
            "castingTime": casting,
            "range": rng,
            "duration": duration,
            "components": parse_components(components),
            "componentsRaw": clean(components),
            "cost": cost,
            "keywords": keyword_list,
            "description": desc,
            "atHigherRanks": higher,
            "source": {"document": "Naruto 5e - Full Document.pdf", "page": page},
            "nameVerified": bool(name),
            "rankVerified": True,
            "costVerified": cost is not None,
            "classificationVerified": True,
            "componentsVerified": bool(components),
        }
        rec["effect"] = derive_effect(rec)
        records.append(rec)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(records, indent=2, ensure_ascii=False), encoding="utf-8")

    # summary
    by_rank = {}
    by_cls = {}
    named = sum(1 for r in records if r["name"])
    costed = sum(1 for r in records if r["cost"] is not None)
    for r in records:
        by_rank[r["rank"]] = by_rank.get(r["rank"], 0) + 1
        by_cls[r["classification"]] = by_cls.get(r["classification"], 0) + 1
    print(f"Extracted {len(records)} jutsu -> {OUT}")
    print(f"  named: {named}  costed: {costed}")
    print(f"  by rank: {by_rank}")
    print(f"  by classification: {by_cls}")


if __name__ == "__main__":
    main()
