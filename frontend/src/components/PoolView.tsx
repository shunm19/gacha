import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { coinWithBalance } from "@mysten/sui/transactions";
import { useMemo, useState } from "react";
import { DrawnEvent } from "../lib/bcs";
import { useDrawFeed, useExec, usePool } from "../lib/chain";
import {
  TIERS,
  n,
  pct,
  short,
  txUrl,
  unitsToYen,
  yen,
  type CardMeta,
  type Metadata,
  amt,
} from "../lib/format";
import { cn } from "../lib/utils";
import { CardTile, TierBadge } from "./CardTile";
import { RevealModal, type Reveal } from "./RevealModal";

type Props = {
  pkg: string;
  coinType: string;
  poolId: string;
  meta: Metadata;
  byCard: Map<number, CardMeta>;
};

export function Stat({ label, value, sub, className }: { label: string; value: string; sub?: string; className?: string }) {
  return (
    <div className={cn("rounded-xl border bg-white/[0.03] p-3", className)}>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function PoolView({ pkg, coinType, poolId, meta, byCard }: Props) {
  const account = useCurrentAccount();
  const { data: pool } = usePool(poolId);
  const { data: feed } = useDrawFeed(pkg, poolId);
  const { exec, busy, error, clearError } = useExec();
  const [reveal, setReveal] = useState<Reveal | null>(null);

  const stats = useMemo(() => {
    if (!pool) return null;
    const left = pool.remaining.length;
    const price = n(pool.price);
    const remValue = n(pool.remaining_value);
    const ev = left ? remValue / left : 0;
    const byTier = [0, 1, 2, 3].map((t) => pool.remaining.filter((p) => p.tier === t).length);
    return {
      left,
      total: n(pool.total_count),
      price,
      remValue,
      ev,
      evRatio: price ? ev / price : 0,
      byTier,
      pS: left ? byTier[0] / left : 0,
    };
  }, [pool]);

  const remainingCards = useMemo(() => new Set(pool?.remaining.map((p) => n(p.card_id)) ?? []), [pool]);
  // The main pool holds every card in the metadata; smaller pools are a subset,
  // reconstructed from what is left plus the draws we have seen.
  const poolCards = useMemo(() => {
    if (!pool) return [];
    const all = n(pool.total_count) === meta.cards.length;
    const ids = new Set([...pool.remaining, ...(feed ?? []).map((d) => d.prize)].map((p) => n(p.card_id)));
    return meta.cards
      .filter((c) => all || ids.has(c.card_id))
      .sort((a, b) => a.tier - b.tier || b.value_jpy - a.value_jpy);
  }, [meta, pool, feed]);

  async function draw() {
    if (!pool) return;
    setReveal({ phase: "pending", label: "Drawing with Sui on-chain randomness…" });
    const res = await exec("draw", (tx) => {
      tx.moveCall({
        target: `${pkg}::pool::draw`,
        typeArguments: [coinType],
        arguments: [
          tx.object(poolId),
          coinWithBalance({ type: coinType, balance: BigInt(pool.price) }),
          tx.object.random(),
          tx.object.clock(),
        ],
      });
    });
    const ev = res?.events.find((e) => e.eventType.endsWith("::pool::Drawn"));
    if (!res || !ev) {
      setReveal(null);
      return;
    }
    const d = DrawnEvent.parse(ev.bcs);
    const card = byCard.get(n(d.prize.card_id));
    if (!card) {
      setReveal(null);
      return;
    }
    setReveal({ phase: "done", card, digest: res.digest, valueUnits: d.prize.value, remaining: n(d.remaining) });
  }

  if (!pool || !stats) return <div className="text-muted-foreground">Loading pool…</div>;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">{pool.name}</h2>
            <p className="text-sm text-muted-foreground">
              {stats.total} draws · prizes fixed at creation · market prices from SNKRDUNK ({meta.cards[0]?.price_date})
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <button
              onClick={draw}
              disabled={!account || stats.left === 0 || !!busy}
              className="rounded-xl bg-gradient-to-r from-amber-400 to-pink-500 px-8 py-3 text-lg font-black text-black shadow-lg transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {stats.left === 0 ? "SOLD OUT" : busy ? "Drawing…" : "DRAW ×1"}
            </button>
            <div className="text-xs text-muted-foreground">
              {amt(stats.price)} (= {yen(unitsToYen(stats.price, meta))}) per draw
              {!account && " · connect a wallet"}
            </div>
          </div>
        </div>

        {error && (
          <div className="flex items-start justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
            <span className="break-all">{error}</span>
            <button onClick={clearError}>✕</button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Draws left" value={`${stats.left} / ${stats.total}`} sub={`${stats.total - stats.left} drawn so far`} />
          <Stat
            label="Hits left"
            value={`S ${stats.byTier[0]} · A ${stats.byTier[1]}`}
            sub={`B ${stats.byTier[2]} · C ${stats.byTier[3]} · P(S next) ${pct(stats.pS)}`}
          />
          <Stat
            label="Next draw EV"
            value={yen(unitsToYen(stats.ev, meta))}
            sub={`${pct(stats.evRatio)} of price · computed from chain`}
            className={stats.evRatio >= 1 ? "border-emerald-500/50" : undefined}
          />
          <Stat
            label="Collateral locked"
            value={amt(pool.collateral, 2)}
            sub={`${pct(n(pool.collateral_bps) / 10000, 0)} of each prize if not shipped`}
          />
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
          {poolCards.map((c) => (
            <CardTile key={c.card_id} card={c} drawn={!remainingCards.has(c.card_id)} />
          ))}
        </div>
      </div>

      <aside className="space-y-3">
        <div className="rounded-xl border bg-white/[0.03] p-4 text-sm">
          <div className="mb-2 font-semibold">Why you don't have to trust us</div>
          <ul className="space-y-2 text-muted-foreground">
            <li>
              <span className="text-foreground">Fixed pool.</span> Prizes and draw count are written at creation; the
              package is immutable and has no function to change them.
            </li>
            <li>
              <span className="text-foreground">Fair draw.</span> Each draw picks uniformly from what is left using
              Sui's validator randomness (object 0x8). No seed, no pre-shuffled order, nobody knows the next card.
            </li>
            <li>
              <span className="text-foreground">Honest odds.</span> Remaining hits, EV and return rate above are read
              from the pool object, not from our server.
            </li>
            <li>
              <span className="text-foreground">Guaranteed delivery.</span> If a won card is not shipped in time, the
              winner is paid from the operator's locked collateral, automatically.
            </li>
          </ul>
        </div>
        <div className="rounded-xl border bg-white/[0.03] p-4">
          <div className="mb-2 text-sm font-semibold">Live draws</div>
          {(feed ?? []).length === 0 && <div className="text-xs text-muted-foreground">No draws yet.</div>}
          <ul className="space-y-2">
            {(feed ?? []).slice(0, 15).map((d) => {
              const c = byCard.get(n(d.prize.card_id));
              return (
                <li key={d.pull_id} className="flex items-center gap-2 text-xs">
                  <TierBadge tier={d.prize.tier} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{c?.name ?? `card ${d.prize.card_id}`}</div>
                    <div className="text-muted-foreground">
                      {short(d.drawer)} · {yen(c?.value_jpy ?? 0)}
                    </div>
                  </div>
                  <a className="text-sky-400" href={txUrl(d.digest)} target="_blank" rel="noreferrer">
                    tx
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="rounded-xl border bg-white/[0.03] p-4 text-xs text-muted-foreground">
          <div className="mb-1 font-semibold text-foreground">Tiers</div>
          {TIERS.map((t, i) => (
            <div key={t.name} className="flex items-center gap-2 py-0.5">
              <TierBadge tier={i} /> {t.label}
            </div>
          ))}
        </div>
      </aside>

      <RevealModal reveal={reveal} meta={meta} onClose={() => setReveal(null)} />
    </div>
  );
}
