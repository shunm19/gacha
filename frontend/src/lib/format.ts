export type CardMeta = {
  card_id: number;
  prize_id: number;
  name: string;
  title: string;
  set: string | null;
  number: string | null;
  rarity: string | null;
  grade: string;
  tier: number;
  tier_name: string;
  value_jpy: number;
  price_date: string;
  image: string;
  source: string;
  cert: number;
  value_usdc_units: number;
};

export type Metadata = {
  name: string;
  description: string;
  currency: string;
  usdjpy: number;
  scale: number;
  price_jpy: number;
  price_usdc_units: number;
  total_value_jpy: number;
  prices_from: string;
  cards: CardMeta[];
};

export const TIERS = [
  { name: "S", label: "Jackpot", ring: "ring-amber-400", text: "text-amber-300", bg: "from-amber-500/40 to-yellow-200/10" },
  { name: "A", label: "Big hit", ring: "ring-fuchsia-400", text: "text-fuchsia-300", bg: "from-fuchsia-500/40 to-fuchsia-200/10" },
  { name: "B", label: "Win", ring: "ring-sky-400", text: "text-sky-300", bg: "from-sky-500/30 to-sky-200/10" },
  { name: "C", label: "Common", ring: "ring-zinc-500", text: "text-zinc-300", bg: "from-zinc-500/20 to-zinc-200/5" },
] as const;

export const n = (x: string | number | bigint) => Number(x);

/** USDC base units (6 decimals) -> "0.2133". */
export const usdc = (units: string | number | bigint, digits = 4) =>
  (n(units) / 1e6).toLocaleString("en-US", { maximumFractionDigits: digits });

/** On-chain USDC units -> market yen (undo the demo scale). */
export const unitsToYen = (units: string | number | bigint, meta: Metadata) =>
  (n(units) / 1e6) * meta.usdjpy * meta.scale;

export const yen = (x: number) => `¥${Math.round(x).toLocaleString("en-US")}`;

export const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;

export const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

export const txUrl = (digest: string) => `https://suiscan.xyz/testnet/tx/${digest}`;
export const objUrl = (id: string) => `https://suiscan.xyz/testnet/object/${id}`;
export const accountUrl = (id: string) => `https://suiscan.xyz/testnet/account/${id}`;

export const toHex = (bytes: ArrayLike<number>) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function countdown(ms: number) {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}
