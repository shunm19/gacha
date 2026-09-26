import { useEffect, useState } from "react";
import { TIERS, txUrl, unitsToYen, yen, type CardMeta, type Metadata, amt, IS_POINTS } from "../lib/format";
import { cn } from "../lib/utils";

export type Reveal =
  | { phase: "pending"; label: string }
  | { phase: "done"; card: CardMeta; digest: string; valueUnits: string; remaining?: number; note?: string };

export function RevealModal({
  reveal,
  meta,
  onClose,
}: {
  reveal: Reveal | null;
  meta: Metadata;
  onClose: () => void;
}) {
  const [flipped, setFlipped] = useState(false);
  useEffect(() => {
    setFlipped(false);
    if (reveal?.phase === "done") {
      const t = setTimeout(() => setFlipped(true), 350);
      return () => clearTimeout(t);
    }
  }, [reveal]);

  if (!reveal) return null;
  const card = reveal.phase === "done" ? reveal.card : null;
  const tier = card ? TIERS[card.tier] : TIERS[3];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur" onClick={reveal.phase === "done" ? onClose : undefined}>
      <div className="flex w-full max-w-sm flex-col items-center gap-5" onClick={(e) => e.stopPropagation()}>
        <div className="h-[420px] w-[300px]" style={{ perspective: "1200px" }}>
          <div
            className="relative h-full w-full transition-transform duration-700"
            style={{ transformStyle: "preserve-3d", transform: flipped ? "rotateY(180deg)" : "none" }}
          >
            {/* back */}
            <div
              className={cn(
                "absolute inset-0 flex flex-col items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-600 via-sky-500 to-cyan-300 ring-2 ring-white/30",
                reveal.phase === "pending" && "animate-pulse",
              )}
              style={{ backfaceVisibility: "hidden" }}
            >
              <div className="text-6xl font-black text-white/90 drop-shadow">?</div>
              <div className="mt-4 px-6 text-center text-sm font-medium text-white/90">
                {reveal.phase === "pending" ? reveal.label : "Revealing…"}
              </div>
              <div className="mt-2 text-[11px] text-white/70">randomness: Sui 0x8</div>
            </div>
            {/* front */}
            <div
              className={cn(
                "absolute inset-0 flex flex-col rounded-2xl bg-gradient-to-b p-4 ring-2",
                tier.bg,
                tier.ring,
                card?.tier === 0 && "shadow-[0_0_80px_rgba(251,191,36,0.6)]",
                card?.tier === 1 && "shadow-[0_0_60px_rgba(217,70,239,0.5)]",
              )}
              style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)", backgroundColor: "#111" }}
            >
              {card && (
                <>
                  <div className={cn("text-center text-lg font-black tracking-widest", tier.text)}>
                    {tier.name} · {tier.label.toUpperCase()}
                  </div>
                  <div className="mx-auto my-2 aspect-[63/88] h-[250px] overflow-hidden rounded-xl bg-white/5">
                    <img src={card.image} alt={card.name} className="h-full w-full object-cover" />
                  </div>
                  <div className="text-center text-base font-semibold">{card.name}</div>
                  <div className="text-center text-xs text-muted-foreground">
                    {card.rarity ?? ""} {card.number ?? ""} · {card.grade}
                  </div>
                  <div className={cn("mt-1 text-center text-2xl font-bold tabular-nums", tier.text)}>
                    {yen(card.value_jpy)}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
        {reveal.phase === "done" && (
          <div className="w-full space-y-2 text-center text-sm">
            <div className="text-muted-foreground">
              On-chain value {amt(reveal.valueUnits)}{IS_POINTS ? "" : ` (${yen(unitsToYen(reveal.valueUnits, meta))} at demo scale)`}
              {reveal.remaining !== undefined && ` · ${reveal.remaining} draws left`}
            </div>
            {reveal.note && <div className="font-medium text-violet-300">{reveal.note}</div>}
            <a className="text-sky-400 underline" href={txUrl(reveal.digest)} target="_blank" rel="noreferrer">
              View the draw on Suiscan
            </a>
            <div>
              <button onClick={onClose} className="mt-2 rounded-lg bg-white px-6 py-2 font-semibold text-black">
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
