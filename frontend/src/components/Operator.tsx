import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { useState } from "react";
import { useExec, useOwnsObject, usePool, useRedemptions } from "../lib/chain";
import { countdown, n, short, txUrl, usdc, type CardMeta } from "../lib/format";
import { useNow } from "./MyPulls";

type Props = {
  pkg: string;
  coinType: string;
  poolId: string;
  adminCapId: string;
  byCard: Map<number, CardMeta>;
};

export function Operator({ pkg, coinType, poolId, adminCapId, byCard }: Props) {
  const account = useCurrentAccount();
  const now = useNow();
  const { data: isOperator } = useOwnsObject(adminCapId);
  const { data: pool } = usePool(poolId);
  const { data: redemptions } = useRedemptions(pkg, poolId);
  const { exec, busy, error } = useExec();
  const [tracking, setTracking] = useState<Record<string, string>>({});
  const [lastTx, setLastTx] = useState<string | null>(null);

  const run = async (label: string, build: Parameters<typeof exec>[1]) => {
    const r = await exec(label, build);
    if (r) setLastTx(r.digest);
  };

  if (!account) return <div className="text-muted-foreground">Connect the operator wallet.</div>;
  if (!isOperator)
    return (
      <div className="max-w-xl space-y-2 text-sm text-muted-foreground">
        <p>
          This wallet does not hold the pool's AdminCap (<span className="font-mono">{short(adminCapId)}</span>).
        </p>
        <p>
          The AdminCap can only ship redemptions and withdraw funds. It cannot touch prizes, price or the draw — there
          is no function for that in the (immutable) package.
        </p>
      </div>
    );

  const open = (redemptions ?? []).filter((r) => !r.shipped);
  const canWithdrawCollateral =
    !!pool && pool.closed && n(pool.outstanding) === 0 && now >= n(pool.closed_at_ms) + n(pool.redeem_window_ms);

  return (
    <div className="space-y-8">
      {error && <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs break-all text-red-300">{error}</div>}
      {lastTx && (
        <a className="text-xs text-sky-400 underline" href={txUrl(lastTx)} target="_blank" rel="noreferrer">
          Last transaction {lastTx.slice(0, 12)}…
        </a>
      )}

      <section>
        <h2 className="mb-3 text-xl font-bold">Ship redemptions ({open.length} open)</h2>
        {open.length === 0 && <div className="text-sm text-muted-foreground">Nothing to ship.</div>}
        <div className="space-y-2">
          {open.map((r) => {
            const c = byCard.get(n(r.prize.card_id));
            const left = n(r.deadline_ms) - now;
            return (
              <div key={r.objectId} className="flex flex-wrap items-center gap-3 rounded-xl border bg-white/[0.03] p-3">
                {c && <img src={c.image} alt="" className="aspect-[63/88] h-16 rounded object-cover" />}
                <div className="min-w-0 flex-1 text-sm">
                  <div className="font-medium">
                    {c?.name} <span className="text-xs text-muted-foreground">cert {r.prize.cert}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    to {short(r.owner)} · {left > 0 ? `${countdown(left)} left` : "deadline passed — owner can claim collateral"}
                  </div>
                </div>
                {left > 0 && (
                  <>
                    <input
                      placeholder="Tracking no."
                      value={tracking[r.objectId] ?? ""}
                      onChange={(e) => setTracking({ ...tracking, [r.objectId]: e.target.value })}
                      className="w-36 rounded-lg border bg-transparent px-2 py-1.5 text-xs"
                    />
                    <button
                      disabled={!!busy || !tracking[r.objectId]}
                      onClick={() =>
                        run("ship", (tx) =>
                          tx.moveCall({
                            target: `${pkg}::pool::mark_shipped`,
                            typeArguments: [coinType],
                            arguments: [
                              tx.object(adminCapId),
                              tx.object(poolId),
                              tx.object(r.objectId),
                              tx.pure.string(tracking[r.objectId]),
                              tx.object.clock(),
                            ],
                          }),
                        )
                      }
                      className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-black disabled:opacity-40"
                    >
                      Mark shipped
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border bg-white/[0.03] p-4">
          <div className="text-sm text-muted-foreground">Sales</div>
          <div className="text-2xl font-semibold">{usdc(pool?.sales ?? 0)} USDC</div>
          <button
            disabled={!!busy || !pool || n(pool.sales) === 0}
            onClick={() =>
              run("withdraw", (tx) => {
                const coin = tx.moveCall({
                  target: `${pkg}::pool::withdraw_sales`,
                  typeArguments: [coinType],
                  arguments: [tx.object(adminCapId), tx.object(poolId)],
                });
                tx.transferObjects([coin], account.address);
              })
            }
            className="mt-2 rounded-lg border px-3 py-1.5 text-xs font-semibold hover:bg-white/10 disabled:opacity-40"
          >
            Withdraw sales
          </button>
        </div>
        <div className="rounded-xl border bg-white/[0.03] p-4">
          <div className="text-sm text-muted-foreground">Collateral</div>
          <div className="text-2xl font-semibold">{usdc(pool?.collateral ?? 0)} USDC</div>
          <div className="text-xs text-muted-foreground">
            Unlocks after the pool closes, one redemption window passes and nothing is left unshipped.
          </div>
          <button
            disabled={!!busy || !canWithdrawCollateral}
            onClick={() =>
              run("withdraw collateral", (tx) => {
                const coin = tx.moveCall({
                  target: `${pkg}::pool::withdraw_collateral`,
                  typeArguments: [coinType],
                  arguments: [tx.object(adminCapId), tx.object(poolId), tx.object.clock()],
                });
                tx.transferObjects([coin], account.address);
              })
            }
            className="mt-2 rounded-lg border px-3 py-1.5 text-xs font-semibold hover:bg-white/10 disabled:opacity-40"
          >
            Withdraw collateral
          </button>
        </div>
      </section>
    </div>
  );
}
