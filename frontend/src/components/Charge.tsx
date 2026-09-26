import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { useState } from "react";
import type { Deployed } from "../config";
import { useExec, useUsdcBalance } from "../lib/chain";
import { amt, n, txUrl, yen } from "../lib/format";

const AMOUNTS = [10_000, 50_000, 100_000, 1_000_000];

/** Header balance + "Charge" dialog that mints Gacha Points from the PointBank. */
export function Charge({ deployed }: { deployed: Deployed }) {
  const account = useCurrentAccount();
  const { data } = useUsdcBalance(deployed.coinType);
  const { exec, busy, error } = useExec();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(100_000);
  const [done, setDone] = useState<{ amount: number; digest: string } | null>(null);

  if (!account || !data) return null;
  const noGas = data.sui === 0n;

  async function charge() {
    setDone(null);
    const res = await exec("charge", (tx) => {
      const coin = tx.moveCall({
        target: `${deployed.packageId}::gacha_point::charge`,
        arguments: [tx.object(deployed.bankId!), tx.pure.u64(amount)],
      });
      tx.transferObjects([coin], account!.address);
    });
    if (res) setDone({ amount, digest: res.digest });
  }

  return (
    <div className="relative flex items-center gap-3 text-xs">
      <span className="hidden text-muted-foreground md:inline">{(Number(data.sui) / 1e9).toFixed(3)} SUI</span>
      <span className="font-semibold tabular-nums">{amt(data.usdc)}</span>
      {deployed.bankId && (
        <button
          onClick={() => setOpen(!open)}
          className="rounded-lg bg-amber-400 px-3 py-1.5 font-bold text-black hover:brightness-110"
        >
          Charge
        </button>
      )}
      {open && (
        <div className="absolute right-0 top-10 z-50 w-80 space-y-3 rounded-xl border bg-background p-4 shadow-2xl">
          <div className="text-sm font-semibold">Charge Gacha Points</div>
          <p className="text-muted-foreground">
            1 GP = ¥1. On testnet charging is free (up to 1,000,000 GP per charge); in production this is where yen /
            JPYC / USDC would be paid in.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {AMOUNTS.map((a) => (
              <button
                key={a}
                onClick={() => setAmount(a)}
                className={`rounded-lg border px-2 py-2 font-semibold ${a === amount ? "border-amber-400 bg-amber-400/15 text-amber-200" : "hover:bg-white/5"}`}
              >
                {n(a).toLocaleString("en-US")} GP
                <div className="text-[10px] font-normal text-muted-foreground">{yen(a)}</div>
              </button>
            ))}
          </div>
          <button
            disabled={!!busy}
            onClick={charge}
            className="w-full rounded-lg bg-amber-400 py-2 text-sm font-black text-black disabled:opacity-40"
          >
            {busy ? "Charging…" : `Charge ${n(amount).toLocaleString("en-US")} GP`}
          </button>
          {noGas && (
            <p className="text-amber-300">
              This wallet has no SUI for gas.{" "}
              <a className="underline" href={`https://faucet.sui.io/?address=${account.address}`} target="_blank" rel="noreferrer">
                Get testnet SUI
              </a>{" "}
              first.
            </p>
          )}
          {error && <p className="break-all text-red-300">{error}</p>}
          {done && (
            <p className="text-emerald-300">
              +{n(done.amount).toLocaleString("en-US")} GP ·{" "}
              <a className="underline" href={txUrl(done.digest)} target="_blank" rel="noreferrer">
                tx
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
