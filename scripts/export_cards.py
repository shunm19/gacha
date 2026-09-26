#!/usr/bin/env python3
"""Build the demo prize pool from psa-data's SNKRDUNK prices and images.

Reads (read-only) ~/Code/claude/psa-data:
  data/snkrdunk/psa10_prices_<latest>.json   PSA10 / raw prices (JPY)
  data/images/snkrdunk/{snkrdunk_id}.webp    card images

Writes:
  frontend/public/cards/{id}.webp            image copies (gitignored)
  frontend/public/pool-metadata.json         card metadata; its sha256 is committed on-chain
  scripts/pool_spec.json                     arguments for create_pool (seed.ts)

On-chain amounts are testnet USDC at 1/1000 of the market price:
  yen -> USD at a fixed USDJPY, then / 1000, in USDC base units (6 decimals).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from glob import glob
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PSA_DATA = ROOT.parent / "psa-data"
sys.path.insert(0, str(PSA_DATA / "scripts"))
from build_cards_api import (  # noqa: E402  (psa-data's title parsers)
    extract_card_name,
    extract_card_number_full,
    extract_rarity,
    extract_set_name_ja,
)

USDJPY = 150
SCALE = 1000  # on-chain amount = market price / SCALE
USDC_DECIMALS = 6
MIN_DATE = "2026-08-15"
TIER_NAMES = ["S", "A", "B", "C"]


def yen_to_usdc_units(yen: int) -> int:
    return round(yen * 10**USDC_DECIMALS / (USDJPY * SCALE))


def latest(pattern: str) -> Path:
    files = sorted(glob(str(PSA_DATA / pattern)))
    if not files:
        sys.exit(f"not found: {pattern}")
    return Path(files[-1])


def image_path(card_id: int) -> Path:
    return PSA_DATA / "data" / "images" / "snkrdunk" / f"{card_id}.webp"


def is_english(title: str) -> bool:
    return "英語" in title or "海外" in title


def pick(products, lo, hi, n, key, exclude):
    """Top `n` by favorites with `key` price in [lo, hi)."""
    rows = [
        p for p in products
        if p["snkrdunk_id"] not in exclude and lo <= (p.get(key) or 0) < hi
    ]
    rows.sort(key=lambda p: -(p.get("favorite_count") or 0))
    out = rows[:n]
    if len(out) < n:
        sys.exit(f"only {len(out)} cards for {key} in [{lo}, {hi})")
    exclude.update(p["snkrdunk_id"] for p in out)
    return out


def card_meta(p: dict, tier: int, graded: bool) -> dict:
    title = p["title"]
    rarity = extract_rarity(title)
    name = extract_card_name(title) or title
    if rarity and name.endswith(" " + rarity):
        name = name[: -len(rarity) - 1]
    # "_のピカチュウ: プロモ (お誕生日ピカチュウ) [...]" -> "お誕生日ピカチュウ"
    alias = re.search(r"\(([^()]+)\)\s*\[", title)
    if name.startswith("_") and alias:
        name = alias.group(1)
    if not rarity and ("プロモ" in title or " P [" in title):
        rarity = "Promo"
        name = re.sub(r" P$", "", name)
    value_jpy = p["psa10_cleaned_price"] if graded else p["cond_a_cleaned_price"]
    return {
        "card_id": p["snkrdunk_id"],
        "name": name,
        "title": title,
        "set": extract_set_name_ja(title),
        "number": extract_card_number_full(title),
        "rarity": rarity,
        "grade": "PSA 10" if graded else "Raw (A)",
        "tier": tier,
        "tier_name": TIER_NAMES[tier],
        "value_jpy": value_jpy,
        "price_date": p["psa10_cleaned_date"] if graded else p["cond_a_cleaned_date"],
        "image": f"/cards/{p['snkrdunk_id']}.webp",
        "source": f"https://snkrdunk.com/apparels/{p['snkrdunk_id']}",
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--return-rate", type=float, default=0.95)
    ap.add_argument("--redeem-window-ms", type=int, default=120_000)
    ap.add_argument("--collateral-bps", type=int, default=10_000)
    args = ap.parse_args()

    src = latest("data/snkrdunk/psa10_prices_*.json")
    products = json.loads(src.read_text())["products"]
    usable = [
        p for p in products
        if image_path(p["snkrdunk_id"]).exists() and not is_english(p["title"])
    ]
    graded = [
        p for p in usable
        if p.get("psa10_cleaned_price")
        and (p.get("psa10_cleaned_date") or "") >= MIN_DATE
        and (p.get("psa10_points_count") or 0) >= 20
    ]
    raw = [
        p for p in usable
        if p.get("cond_a_cleaned_price")
        and (p.get("cond_a_cleaned_date") or "") >= MIN_DATE
        and (p.get("cond_a_points_count") or 0) >= 10
    ]

    used: set[int] = set()
    tiers = [
        # S: one jackpot, two big hits
        [(p, 0, True) for p in pick(graded, 300_000, 10**9, 1, "psa10_cleaned_price", used)],
        [(p, 0, True) for p in pick(graded, 100_000, 300_000, 2, "psa10_cleaned_price", used)],
        # A: mid hits
        [(p, 1, True) for p in pick(graded, 30_000, 100_000, 5, "psa10_cleaned_price", used)],
        # B: small wins
        [(p, 2, True) for p in pick(graded, 3_000, 10_000, 8, "psa10_cleaned_price", used)],
        # C: raw commons (SNKRDUNK's floor is ~1,000 JPY)
        [(p, 3, False) for p in pick(raw, 1_000, 2_000, 24, "cond_a_cleaned_price", used)],
    ]
    cards = [card_meta(p, tier, graded_) for group in tiers for (p, tier, graded_) in group]

    total_jpy = sum(c["value_jpy"] for c in cards)
    price_jpy = round(total_jpy / (len(cards) * args.return_rate) / 1000) * 1000

    for i, c in enumerate(cards):
        c["prize_id"] = i
        # Placeholder PSA cert numbers for the demo (real pools use the slab's cert).
        c["cert"] = 90_000_000 + c["card_id"] % 10_000_000 if c["grade"] == "PSA 10" else 0
        c["value_usdc_units"] = yen_to_usdc_units(c["value_jpy"])

    metadata = {
        "name": "Trustless Oripa #1",
        "description": "40-draw Pokémon card oripa. Contents fixed on-chain, drawn with Sui randomness.",
        "currency": "USDC (Sui testnet)",
        "usdjpy": USDJPY,
        "scale": SCALE,
        "price_jpy": price_jpy,
        "price_usdc_units": yen_to_usdc_units(price_jpy),
        "total_value_jpy": total_jpy,
        "prices_from": f"SNKRDUNK via psa-data ({src.name})",
        "cards": cards,
    }
    meta_bytes = (json.dumps(metadata, ensure_ascii=False, indent=2) + "\n").encode()
    meta_hash = hashlib.sha256(meta_bytes).hexdigest()

    public = ROOT / "frontend" / "public"
    (public / "cards").mkdir(parents=True, exist_ok=True)
    for c in cards:
        shutil.copyfile(image_path(c["card_id"]), public / "cards" / f"{c['card_id']}.webp")
    (public / "pool-metadata.json").write_bytes(meta_bytes)

    spec = {
        "name": metadata["name"],
        "price": metadata["price_usdc_units"],
        "card_ids": [c["card_id"] for c in cards],
        "certs": [c["cert"] for c in cards],
        "values": [c["value_usdc_units"] for c in cards],
        "tiers": [c["tier"] for c in cards],
        "metadata_hash": meta_hash,
        "collateral_bps": args.collateral_bps,
        "redeem_window_ms": args.redeem_window_ms,
        "total_value": sum(c["value_usdc_units"] for c in cards),
        # Gacha Point pools: 1 GP = 1 JPY, so values are the market prices themselves.
        "values_jpy": [c["value_jpy"] for c in cards],
        "price_jpy": price_jpy,
    }
    (ROOT / "scripts" / "pool_spec.json").write_text(json.dumps(spec, indent=2) + "\n")

    print(f"source: {src.name}  cards: {len(cards)}  sha256: {meta_hash[:16]}…")
    for c in cards:
        print(f"  {c['tier_name']} {c['value_jpy']:>9,}  {c['grade']:8}  {c['card_id']:>7}  {c['name']} {c['rarity'] or ''}")
    total_usdc = spec["total_value"] / 10**USDC_DECIMALS
    print(f"total ¥{total_jpy:,}  price ¥{price_jpy:,} x {len(cards)}  "
          f"return {total_jpy / (price_jpy * len(cards)):.1%}")
    print(f"on-chain: price {spec['price'] / 1e6:.6f} USDC, prizes {total_usdc:.6f} USDC, "
          f"collateral needed {total_usdc * args.collateral_bps / 10_000:.6f} USDC")


if __name__ == "__main__":
    main()
