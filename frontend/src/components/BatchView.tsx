import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { coinWithBalance } from "@mysten/sui/transactions";
import { useState } from "react";
import { DrawnEvent } from "../lib/bcs";
import { useExec, useMySpots, usePool } from "../lib/chain";
import { countdown, n, txUrl, yen, type CardMeta, type Metadata, amt, unitsToYen } from "../lib/format";
import { CardTile } from "./CardTile";
import { useNow } from "./MyPulls";
import { Stat } from "./PoolView";
import { RevealModal, type Reveal } from "./RevealModal";

type Props = {
  pkg: string;
  coinType: string;
  poolId: string;
  meta: Metadata;
  byCard: Map<number, CardMeta>;
};

export function BatchView({ pkg, coinType, poolId, meta, byCard }: Props) {
  const account = useCurrentAccount();
  const now = useNow();
  const { data: pool } = usePool(poolId);
  const { data: spots } = useMySpots(pkg);
  const { exec, busy, error } = useExec();
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  if (!pool) return <div className="text-muted-foreground">Loading batch pool…</div>;
  const sold = n(pool.spots_sold);
  const total = n(pool.total_count);
  const left = n(pool.sale_end_ms) - now;
  const selling = !pool.settled && left > 0 && sold < total;
  const canSettle = !pool.settled && (left <= 0 || sold === total);
  const mine = (spots ?? []).filter((s) => s.pool_id === poolId);

  const prizes = pool.settled ? pool.assignments : pool.remaining;
  const returned = pool.settled ? pool.remaining : [];

  async function openSpot(spotId: string) {
    setReveal({ phase: "pending", label: "Opening your spot…" });
    const res = await exec("open", (tx) =>
      tx.moveCall({
        target: `${pkg}::pool::open_spot`,
        typeArguments: [coinType],
        arguments: [tx.object(poolId), tx.object(spotId), tx.object.clock()],
      }),
    );
    const ev = res?.events.find((e) => e.eventType.endsWith("::pool::Drawn"));
    const d = ev && DrawnEvent.parse(ev.bcs);
    const card = d && byCard.get(n(d.prize.card_id));
    if (!res || !d || !card) return setReveal(null);
    setReveal({ phase: "done", card, digest: res.digest, valueUnits: d.prize.value });
  }

  const run = async (label: string, build: Parameters<typeof exec>[1]) => {
    const r = await exec(label, build);
    if (r) setLastTx(r.digest);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">{pool.name}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Group-break style: buy spots until the timer ends. Then anyone presses Settle: one on-chain shuffle assigns a
            prize to every sold spot at once. It does not need to sell out — unsold prizes simply go back to the
            operator, so every spot has the same odds no matter when it was bought.
          </p>
        </div>
        <div className="flex gap-2">
          {selling && (
            <button
              disabled={!account || !!busy}
              onClick={() =>
                run("buy", (tx) =>
                  tx.moveCall({
                    target: `${pkg}::pool::buy_spot`,
                    typeArguments: [coinType],
                    arguments: [
                      tx.object(poolId),
                      coinWithBalance({ type: coinType, balance: BigInt(pool.price) }),
                      tx.object.clock(),
                    ],
                  }),
                )
              }
              className="rounded-xl bg-gradient-to-r from-sky-400 to-indigo-500 px-6 py-3 font-black text-black disabled:opacity-40"
            >
              BUY SPOT · {amt(pool.price)}
            </button>
          )}
          {canSettle && (
            <button
              disabled={!account || !!busy}
              onClick={() =>
                run("settle", (tx) =>
                  tx.moveCall({
                    target: `${pkg}::pool::settle`,
                    typeArguments: [coinType],
                    arguments: [tx.object(poolId), tx.object.random(), tx.object.clock()],
                  }),
                )
              }
              className="rounded-xl bg-gradient-to-r from-amber-400 to-pink-500 px-6 py-3 font-black text-black disabled:opacity-40"
            >
              SETTLE (anyone)
            </button>
          )}
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs break-all text-red-300">{error}</div>}
      {lastTx && (
        <a className="text-xs text-sky-400 underline" href={txUrl(lastTx)} target="_blank" rel="noreferrer">
          Last transaction {lastTx.slice(0, 12)}…
        </a>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Spots sold" value={`${sold} / ${total}`} />
        <Stat
          label={pool.settled ? "Status" : "Sale ends in"}
          value={pool.settled ? "Settled" : left > 0 ? countdown(left) : "Ended"}
        />
        <Stat label="Price per spot" value={amt(pool.price)} sub={yen(unitsToYen(pool.price, meta))} />
        <Stat label="Your spots" value={String(mine.length)} />
      </div>

      {mine.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {mine.map((s) => (
            <button
              key={s.objectId}
              disabled={!pool.settled || !!busy}
              onClick={() => openSpot(s.objectId)}
              className="rounded-lg border px-3 py-2 text-sm font-semibold hover:bg-white/10 disabled:opacity-40"
            >
              {pool.settled ? `Open spot #${s.spot_no}` : `Spot #${s.spot_no} (waiting for settle)`}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
        {prizes.map((p, i) => {
          const c = byCard.get(n(p.card_id));
          return c ? <CardTile key={`a${p.prize_id}`} card={c} label={pool.settled ? `SPOT #${i}` : undefined} /> : null;
        })}
        {returned.map((p) => {
          const c = byCard.get(n(p.card_id));
          return c ? <CardTile key={`r${p.prize_id}`} card={c} drawn label="UNSOLD → OPERATOR" /> : null;
        })}
      </div>

      <RevealModal reveal={reveal} meta={meta} onClose={() => setReveal(null)} />
    </div>
  );
}
