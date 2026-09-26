import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { useEffect, useState } from "react";
import { useExec, useMyPulls, usePool, useRedemptions } from "../lib/chain";
import { countdown, n, txUrl, unitsToYen, usdc, yen, type CardMeta, type Metadata } from "../lib/format";
import { CardTile } from "./CardTile";

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

type Props = {
  pkg: string;
  coinType: string;
  poolId: string;
  meta: Metadata;
  byCard: Map<number, CardMeta>;
};

export function MyPulls({ pkg, coinType, poolId, meta, byCard }: Props) {
  const account = useCurrentAccount();
  const now = useNow();
  const { data: pool } = usePool(poolId);
  const { data: pulls } = useMyPulls(pkg);
  const { data: redemptions } = useRedemptions(pkg, poolId, account?.address);
  const { exec, busy, error } = useExec();
  const [lastTx, setLastTx] = useState<string | null>(null);

  if (!account) return <div className="text-muted-foreground">Connect a wallet to see your pulls.</div>;
  const mine = (pulls ?? []).filter((p) => p.pool_id === poolId);
  const bps = n(pool?.collateral_bps ?? 0);
  const windowMin = n(pool?.redeem_window_ms ?? 0) / 60000;

  const run = async (label: string, build: Parameters<typeof exec>[1]) => {
    const r = await exec(label, build);
    if (r) setLastTx(r.digest);
  };

  return (
    <div className="space-y-8">
      {error && <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs break-all text-red-300">{error}</div>}
      {lastTx && (
        <div className="text-xs text-muted-foreground">
          Last transaction:{" "}
          <a className="text-sky-400 underline" href={txUrl(lastTx)} target="_blank" rel="noreferrer">
            {lastTx.slice(0, 12)}…
          </a>
        </div>
      )}

      <section>
        <h2 className="text-xl font-bold">Your pulls ({mine.length})</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Each pull is an object you own: keep it, trade it, or burn it to request the physical card. The operator then
          has {windowMin} min (demo setting) to ship, or you are paid {bps / 100}% of its value from collateral.
        </p>
        {mine.length === 0 && <div className="text-sm text-muted-foreground">Nothing yet — draw from the pool.</div>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
          {mine.map((p) => {
            const c = byCard.get(n(p.prize.card_id));
            if (!c) return null;
            return (
              <div key={p.objectId} className="space-y-2">
                <CardTile card={c} />
                <button
                  disabled={!!busy}
                  onClick={() =>
                    run("redeem", (tx) =>
                      tx.moveCall({
                        target: `${pkg}::pool::request_redeem`,
                        typeArguments: [coinType],
                        arguments: [tx.object(poolId), tx.object(p.objectId), tx.object.clock()],
                      }),
                    )
                  }
                  className="w-full rounded-lg border px-2 py-1.5 text-xs font-semibold hover:bg-white/10 disabled:opacity-40"
                >
                  Request shipping
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xl font-bold">Shipping requests</h2>
        {(redemptions ?? []).length === 0 && <div className="text-sm text-muted-foreground">No open requests.</div>}
        <div className="space-y-2">
          {(redemptions ?? []).map((r) => {
            const c = byCard.get(n(r.prize.card_id));
            const left = n(r.deadline_ms) - now;
            const due = (n(r.prize.value) * bps) / 10000;
            return (
              <div key={r.objectId} className="flex flex-wrap items-center gap-3 rounded-xl border bg-white/[0.03] p-3">
                {c && <img src={c.image} alt="" className="aspect-[63/88] h-16 rounded object-cover" />}
                <div className="min-w-0 flex-1 text-sm">
                  <div className="font-medium">{c?.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.shipped
                      ? `Shipped · tracking ${r.tracking}`
                      : left > 0
                        ? `Waiting for the operator · ${countdown(left)} left to ship`
                        : `Deadline passed · not shipped`}
                  </div>
                </div>
                {r.shipped ? (
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      run("confirm", (tx) =>
                        tx.moveCall({ target: `${pkg}::pool::confirm_received`, arguments: [tx.object(r.objectId)] }),
                      )
                    }
                    className="rounded-lg border px-3 py-1.5 text-xs font-semibold hover:bg-white/10"
                  >
                    Confirm received
                  </button>
                ) : left > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    Guaranteed: {usdc(due)} USDC ({yen(unitsToYen(due, meta))})
                  </span>
                ) : (
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      run("claim", (tx) =>
                        tx.moveCall({
                          target: `${pkg}::pool::claim_collateral`,
                          typeArguments: [coinType],
                          arguments: [tx.object(poolId), tx.object(r.objectId), tx.object.clock()],
                        }),
                      )
                    }
                    className="rounded-lg bg-emerald-400 px-3 py-1.5 text-xs font-bold text-black"
                  >
                    Claim {usdc(due)} USDC from collateral
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
