import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import { useState } from "react";
import { BatchView } from "./components/BatchView";
import { BlindView } from "./components/BlindView";
import { Charge } from "./components/Charge";
import { MyPulls } from "./components/MyPulls";
import { Operator } from "./components/Operator";
import { PoolView } from "./components/PoolView";
import { Verify } from "./components/Verify";
import { LOCAL, deployed } from "./config";
import { useMetadata } from "./lib/chain";
import { cn } from "./lib/utils";

type Tab = "pool" | "blind" | "pulls" | "batch" | "verify" | "operator";

function App() {
  const [tab, setTab] = useState<Tab>("pool");
  const { data: md } = useMetadata();
  const main = deployed?.pools.main;
  const batch = deployed?.pools.batch;

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "pool", label: "Open Pool", show: true },
    { id: "blind", label: "Blind (JP)", show: !!deployed?.blind?.poolId },
    { id: "batch", label: "Batch Break", show: !!batch },
    { id: "pulls", label: "My Pulls", show: true },
    { id: "verify", label: "Verify", show: true },
    { id: "operator", label: "Operator", show: true },
  ];

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
        <div className="container mx-auto flex h-16 items-center gap-6 px-4">
          <div className="flex items-baseline gap-2">
            <h1 className="text-lg font-black tracking-tight">
              Trustless <span className="text-amber-300">Oripa</span>
            </h1>
            <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300">{LOCAL ? "LOCALNET" : "SUI TESTNET"}</span>
          </div>
          <nav className="flex gap-1">
            {tabs
              .filter((t) => t.show)
              .map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-sm",
                    tab === t.id ? "bg-white/10 font-semibold" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.label}
                </button>
              ))}
          </nav>
          <div className="ml-auto flex items-center gap-4">
            {deployed && <Charge deployed={deployed} />}
            <ConnectButton />
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        {!deployed || !main ? (
          <div className="text-muted-foreground">
            Not deployed yet: run <code>make deploy &amp;&amp; make seed</code>.
          </div>
        ) : !md ? (
          <div className="text-muted-foreground">Loading…</div>
        ) : (
          <>
            {tab === "pool" && (
              <PoolView pkg={deployed.packageId} coinType={deployed.coinType} poolId={main.poolId} meta={md.meta} byCard={md.byCard} />
            )}
            {tab === "pulls" && (
              <MyPulls pkg={deployed.packageId} coinType={deployed.coinType} poolId={main.poolId} meta={md.meta} byCard={md.byCard} />
            )}
            {tab === "blind" && deployed.blind?.poolId && <BlindView deployed={deployed} meta={md.meta} byCard={md.byCard} />}
            {tab === "batch" && batch && (
              <BatchView pkg={deployed.packageId} coinType={deployed.coinType} poolId={batch.poolId} meta={md.meta} byCard={md.byCard} />
            )}
            {tab === "verify" && <Verify deployed={deployed} poolId={main.poolId} meta={md.meta} metaHash={md.hash} />}
            {tab === "operator" && (
              <Operator
                pkg={deployed.packageId}
                coinType={deployed.coinType}
                poolId={main.poolId}
                adminCapId={main.adminCapId}
                byCard={md.byCard}
              />
            )}
          </>
        )}
      </main>
      <footer className="container mx-auto px-4 pb-8 text-xs text-muted-foreground">
        ETHGlobal Tokyo 2026 hackathon demo. Card images and prices from SNKRDUNK, used for demonstration only. Draws are
        paid in Gacha Points (GP, 1 GP = ¥1), a coin issued by this package and free to charge on Sui testnet.
      </footer>
    </div>
  );
}

export default App;
