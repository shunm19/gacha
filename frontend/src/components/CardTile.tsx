import { TIERS, yen, type CardMeta } from "../lib/format";
import { cn } from "../lib/utils";

export function TierBadge({ tier, className }: { tier: number; className?: string }) {
  const t = TIERS[tier] ?? TIERS[3];
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded px-1 text-[11px] font-bold ring-1",
        t.ring,
        t.text,
        className,
      )}
    >
      {t.name}
    </span>
  );
}

export function CardTile({
  card,
  drawn,
  label,
  onClick,
  className,
}: {
  card: CardMeta;
  drawn?: boolean;
  label?: string;
  onClick?: () => void;
  className?: string;
}) {
  const t = TIERS[card.tier] ?? TIERS[3];
  return (
    <div
      onClick={onClick}
      className={cn(
        "group relative flex flex-col rounded-xl bg-gradient-to-b p-2 ring-1 transition",
        t.bg,
        t.ring,
        drawn && "opacity-35 grayscale",
        onClick && "cursor-pointer hover:scale-[1.02]",
        className,
      )}
    >
      <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg bg-white/5">
        <img src={card.image} alt={card.name} loading="lazy" className="h-full w-full scale-125 object-contain" />
      </div>
      <div className="mt-2 flex items-start gap-1.5">
        <TierBadge tier={card.tier} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium" title={card.title}>
            {card.name}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {card.rarity ? `${card.rarity} · ` : ""}
            {card.grade}
          </div>
        </div>
      </div>
      <div className={cn("mt-1 text-right text-sm font-semibold tabular-nums", t.text)}>{yen(card.value_jpy)}</div>
      {(drawn || label) && (
        <span className="absolute left-3 top-3 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-white">
          {label ?? "DRAWN"}
        </span>
      )}
    </div>
  );
}
