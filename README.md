# Trustless Oripa — a gacha you don't have to trust (Sui)

ETHGlobal Tokyo 2026 · Sui track (DeFi & Payments)

**Oripa** (オリパ, "original pack") is Japan's online trading-card gacha: an operator
fills a pool with N draws and a fixed list of cards (a few PSA-graded jackpots, many
commons) and sells draws one by one. It is a large market, and a trust disaster:
players cannot check that the jackpots are really in the pool, that hits were not
pulled out or extra draws added before the "last one", that the advertised return
rate is real, or that a won card will ever be shipped. In September 2026, 38
buyers sued five of the largest oripa operators in Tokyo District Court over
misrepresented return rates and odds. Overseas, on-chain gacha (Courtyard,
Collector Crypt, Phygitals) grew to hundreds of millions of dollars a month, but
they still ask users to trust the operator's pool contents and randomness keys.

**Trustless Oripa** puts the whole pool on Sui so that none of that needs trust.

## One contract, every gacha format

Gacha formats differ in **who knows what is left** and **when money moves**. The
trust problem is always the same: someone other than the buyer knows more, or holds
the money. On-chain, "only the operator knows" stops being possible.

| Format | Who knows what is left today | What goes wrong | Trustless Oripa |
|---|---|---|---|
| **Japanese oripa** — only the draw count is shown until sold out | the operator alone | hits never included or pulled, draws added before the last one, fake return rates, insiders buying the hit | **Blind mode**: slots committed + Seal-encrypted, each draw picks a random slot with `sui::random` (no order exists, so nobody knows which draw wins), only the holder decrypts their slot, everything opens publicly at close or in the last *k* draws |
| **Chinese ichiban-kuji** — remaining prizes shown live | everyone, but self-reported | the display lies, top prize removed early, box closed when the rest is +EV | **Open mode**: the display *is* the pool object; there is no function to stop sales or change prizes |
| **US digital packs** (Courtyard, Collector Crypt) — odds + restocking + buyback | the operator (pool contents, restock timing) | displayed EV 110% vs realized 94%, opaque FMV | the same fixed-pool model per pool, odds derived from on-chain inventory (restock = a new, separately verifiable pool) |
| **Group breaks** — spots filled, opened on stream | nobody (sealed product) | rigged randomizers, spots never filled, money paid before the break | **Batch mode**: escrowed spots, one on-chain shuffle at the deadline by anyone, no sell-out needed (unsold prizes return to the operator) |

Across all modes, money moves by code: payments into escrow, collateral that pays a
winner automatically if a card is not shipped, and (blind mode) a hidden result
that is never revealed pays the top prize.

| What the operator could cheat on | How it is closed |
|---|---|
| Know or steer which card comes next (pre-shuffled order, leaked positions) | Every `draw` picks uniformly from what is left using **Sui's native randomness** (`0x8`, validator threshold crypto). No seed, no order exists before the draw. |
| Leave hits out, pull them, add draws, reprice | Prizes, count and price are **fixed at creation**; the package has **no function** to change them and was made **immutable in its publish transaction**. |
| Lie about remaining hits / return rate | Remaining cards, hits left, EV of the next draw and return rate are **computed from the pool object** in the browser. |
| Never ship the card | Winner burns the Pull to request shipping; if it is not marked shipped before the deadline, the winner **claims payment from the operator's locked USDC collateral**, permissionlessly. |
| Swap the card list shown in the UI | The card metadata JSON's **sha256 is committed on-chain**; the Verify tab recomputes it in your browser. |

What remains trusted (and is stated in the app): that the physical cards exist and
match their PSA cert numbers, and that a "shipped" mark matches a real parcel.

## How it works

```
operator ── create_pool(prizes, price, metadata_hash, USDC collateral) ──► Pool (shared)
player   ── draw(pool, USDC, &Random, &Clock) ──► Pull object (the card claim ticket)
player   ── request_redeem(pull) ──► Redemption (shared, deadline)
operator ── mark_shipped(cap, redemption, tracking)      (only before the deadline)
player   ── claim_collateral(redemption)                 (only after it, if not shipped)
```

Two sale modes share one pool type:

- **Instant** (the classic oripa): draw one at a time, instant reveal.
- **Batch Break** (group-break style): sell spots until a deadline, then anyone
  calls `settle`, which shuffles once and assigns every sold spot. It does **not**
  need to sell out: unsold prizes go back to the operator, so every spot has the
  same odds no matter when it was bought (no "last one" timing game).

### Blind mode (Japanese format) with Seal

- The lineup (which cards, how many) is public; the slot → card mapping is not.
  Each slot stores `sha256(slot_id || prize_id || salt)` and a **Seal** ciphertext of
  `(prize_id, salt)` under identity `pool_id || slot_id`.
- `draw` picks a uniformly random *remaining slot*. The event only carries the slot
  number. Unlike "commit to a shuffled order and reveal later", there is no order,
  so the operator cannot sell or leak "the winning draw number".
- `seal_approve_holder` lets the holder of that slot's Pull decrypt it immediately
  (no operator server). `seal_approve_public` lets anyone decrypt every slot once
  the pool is closed or only `reveal_tail` draws are left, which removes the
  operator's end-game information edge.
- `reveal` checks the commitment on-chain and that each lineup prize is used
  exactly once (so "the jackpot was never in" is caught). A drawn slot still hidden
  one window after close pays its holder the **top prize** from collateral.
- Remaining trust: the Seal key servers (Mysten's testnet committee, threshold) must
  not collude with the operator to decrypt early; the operator knows the mapping it
  encrypted, which the public tail limits (a TEE via Nautilus could remove it).

### Security details

- `draw` / `settle` are **private `entry`** functions taking `&Random`: they cannot
  be wrapped by another module, and Sui rejects PTB commands after them other than
  transfers, so a caller cannot inspect the result and abort.
- **Constant gas across outcomes**: `Prize` and `Pull` hold fixed-size fields only
  (names/images live off-chain behind `metadata_hash`), and removal is `swap_remove`,
  so no prize is cheaper to draw than another (defeats "set gas budget so only the
  jackpot path succeeds").
- The operator cannot front-run a collateral claim: `mark_shipped` aborts after the
  deadline. Collateral unlocks only after the pool closes, a full redemption
  window passes, and nothing is left unshipped.

### Sui features used


`sui::random` (on-chain randomness), **Seal** (decentralized access-controlled
decryption with Move policies), shared objects, owned objects as claim tickets
(`Pull`, `Spot` — tradable), `sui::display` for wallet rendering, `Clock` deadlines,
`Balance<T>` escrow for sales and collateral, a `Coin` issued with `coin_registry`
(Gacha Point), events, PTBs with `coinWithBalance`,
`package::make_immutable` in the publish PTB, dapp-kit v2 + gRPC.

## Repository

```
move/oripa/            Move package: sources/pool.move (open + batch), sources/blind.move (Seal), sources/gacha_point.move (GP coin), 37 tests
scripts/export_cards.py  builds the demo pool from psa-data (SNKRDUNK prices + images)
scripts/deploy.ts      publish + make_immutable in one tx
scripts/seed.ts        create_pool / create_batch_pool with USDC collateral
scripts/seed-blind.ts  blind pool: commit + Seal-encrypt every slot, then seal
scripts/*-smoke.ts     end-to-end checks against testnet / localnet
frontend/              Vite + React + @mysten/dapp-kit-react (English UI)
docs/plan.md           the implementation plan used to build this
```

## Run it

```bash
make test                 # Move unit tests
make cards                # needs ../psa-data (card images are not committed)
make wallet               # throwaway testnet key in .sui/ (fund it: faucet.sui.io + faucet.circle.com)
make deploy && make seed  # publish (immutable) and create the 40-draw pool
make seed-batch           # optional: a 12-spot batch break, sale ends in 20 min
npx tsx scripts/deploy.ts --blind && npx tsx scripts/seed-blind.ts   # blind pool (Seal)
make dev                  # http://localhost:5173 (Slush wallet on testnet + testnet USDC)
```

Payments use **Gacha Point (GP)**, a coin issued by this package (`gacha_point.move`,
registered via `coin_registry`, 0 decimals, **1 GP = ¥1**), so prices and prize values
are the real market prices: a draw is 32,000 GP and the open pool's ¥1.22M of prizes
is backed by 1,224,815 GP of collateral. On testnet anyone can charge GP for free
from the shared `PointBank` (the **Charge** button); in production the bank would sell
GP for yen / JPYC / USDC — the pools are generic over the coin. Only SUI for gas is
needed from a faucet. The redemption window is 2 minutes so the collateral path can
be shown live.

## Deployed (Sui testnet)

| | ID |
|---|---|
| Package (pool + blind + gacha_point), immutable | `0xb086a10503300345c5192fcffcf72226661c9afed7fe199383f4dc0be166698a` |
| Gacha Point coin type | `0xb086a10503300345c5192fcffcf72226661c9afed7fe199383f4dc0be166698a::gacha_point::GACHA_POINT` |
| PointBank (charge GP) | `0x600366fa26e69cb1351765130f5758739ee9c24fdbda3bbee419644e62c6cce0` |
| Open pool (40 draws, 32,000 GP) | `0x0c287a9067911a0cdca92f0b92040e061a4e4b40dabefbe3d2de33d6eb54cd9c` |
| Batch break (12 spots) | `0xf6aacebbdc4c34154b83f0fab71dafcdbe7f855857e01bf7b617292b514e0c0b` |
| Blind pool (20 slots) | `0x6a294eeb6b2d16030e74e948c88e934b8cd0af629cd61524a4a2d2ce508c9d73` |
| Blind demo pool (6 slots) | `0xc8335abf4d4791db9ee914114c6d9f49c14b2b4db3df7b4fe4a54e5073937167` |
| Seal key server | Mysten testnet committee `0xb012378c…1e98` (threshold 1, via aggregator) |

An earlier deployment paid in Circle testnet USDC (1/1000 price scale); its IDs are in `docs/deployments/testnet-usdc-v1v2.json`.

## Data and AI disclosure

- Card images and market prices come from SNKRDUNK, collected by the author's
  separate `psa-data` project. They are used only for this hackathon demo; the images
  are copied locally by `make cards` and are **not** committed. PSA cert numbers in
  the demo pool are placeholders.
- AI use: this project was built with **Claude Code**, which wrote the Move package
  and tests, the scripts, the frontend and this README under the author's direction
  (idea, market research framing, design decisions and review by the author). The
  plan that guided the work is in `docs/plan.md`.
