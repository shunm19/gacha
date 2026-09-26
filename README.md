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

`sui::random` (on-chain randomness), shared objects, owned objects as claim tickets
(`Pull`, `Spot` — tradable), `sui::display` for wallet rendering, `Clock` deadlines,
`Balance<USDC>` escrow for sales and collateral, events, PTBs with `coinWithBalance`,
`package::make_immutable` in the publish PTB, dapp-kit v2 + gRPC.

## Repository

```
move/oripa/            Move package (sources/pool.move, tests/pool_tests.move — 17 tests)
scripts/export_cards.py  builds the demo pool from psa-data (SNKRDUNK prices + images)
scripts/deploy.ts      publish + make_immutable in one tx
scripts/seed.ts        create_pool / create_batch_pool with USDC collateral
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
make dev                  # http://localhost:5173 (Slush wallet on testnet + testnet USDC)
```

Demo economics: on-chain amounts are **testnet USDC at 1/1000 of the market price**
(¥ → USD at 150, then ÷1000), so a ¥32,000 draw costs 0.2133 USDC and the pool's
¥1.22M of prizes is backed by 8.17 USDC of collateral. The redemption window is 2
minutes so the collateral path can be shown live.

## Data and AI disclosure

- Card images and market prices come from SNKRDUNK, collected by the author's
  separate `psa-data` project. They are used only for this hackathon demo; the images
  are copied locally by `make cards` and are **not** committed. PSA cert numbers in
  the demo pool are placeholders.
- AI use: this project was built with **Claude Code**, which wrote the Move package
  and tests, the scripts, the frontend and this README under the author's direction
  (idea, market research framing, design decisions and review by the author). The
  plan that guided the work is in `docs/plan.md`.
