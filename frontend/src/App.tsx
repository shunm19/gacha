import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import { BlindView } from "./components/BlindView";
import { Charge } from "./components/Charge";
import { LOCAL, deployed } from "./config";
import { useMetadata } from "./lib/chain";

// The demo ships one mode: the Blind (Japan-style) oripa. The open and batch
// modes still exist in the Move package (pool.move) and their components.
function App() {
  const { data: md } = useMetadata();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
        <div className="container mx-auto flex h-16 items-center gap-6 px-4">
          <div className="flex items-baseline gap-2">
            <h1 className="text-lg font-black tracking-tight">
              Trustless <span className="text-amber-300">Oripa</span>
            </h1>
            <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300">
              {LOCAL ? "LOCALNET" : "SUI TESTNET"}
            </span>
          </div>
          <nav className="flex gap-1 text-sm">
            <span className="rounded-lg bg-white/10 px-3 py-1.5 font-semibold">Blind Oripa</span>
            <a className="rounded-lg px-3 py-1.5 text-muted-foreground hover:text-foreground" href="/docs/" target="_blank" rel="noreferrer">
              How it works
            </a>
            <a
              className="rounded-lg px-3 py-1.5 text-muted-foreground hover:text-foreground"
              href="https://github.com/shunm19/gacha"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-4">
            {deployed && <Charge deployed={deployed} />}
            <ConnectButton />
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        {!deployed?.blind?.poolId ? (
          <div className="text-muted-foreground">
            Not deployed yet: run <code>make deploy</code> and <code>scripts/seed-blind.ts</code>.
          </div>
        ) : !md ? (
          <div className="text-muted-foreground">Loading…</div>
        ) : (
          <BlindView deployed={deployed} meta={md.meta} byCard={md.byCard} />
        )}
      </main>
      <footer className="container mx-auto space-y-1 px-4 pb-8 text-xs text-muted-foreground">
        <p>
          To try it: connect a wallet (Slush, or the in-page burner wallet), get testnet SUI for gas from the faucet, then
          press <b>Charge</b> for free Gacha Points (GP, 1 GP = ¥1) and draw.
        </p>
        <p>
          ETHGlobal Tokyo 2026 hackathon demo on Sui testnet. Card images and prices from SNKRDUNK, used for demonstration
          only.
        </p>
      </footer>
    </div>
  );
}

export default App;
