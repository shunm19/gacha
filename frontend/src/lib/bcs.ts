// BCS layouts mirroring move/oripa/sources/pool.move. We decode raw object
// and event bytes instead of relying on API-specific JSON shapes.
import { bcs } from "@mysten/sui/bcs";

export const Prize = bcs.struct("Prize", {
  prize_id: bcs.u64(),
  card_id: bcs.u64(),
  cert: bcs.u64(),
  value: bcs.u64(),
  tier: bcs.u8(),
});

export const Pool = bcs.struct("Pool", {
  id: bcs.Address,
  name: bcs.string(),
  operator: bcs.Address,
  mode: bcs.u8(),
  price: bcs.u64(),
  total_count: bcs.u64(),
  total_value: bcs.u64(),
  remaining: bcs.vector(Prize),
  remaining_value: bcs.u64(),
  metadata_hash: bcs.vector(bcs.u8()),
  sales: bcs.u64(),
  collateral: bcs.u64(),
  collateral_bps: bcs.u64(),
  redeem_window_ms: bcs.u64(),
  outstanding: bcs.u64(),
  closed: bcs.bool(),
  closed_at_ms: bcs.u64(),
  sale_end_ms: bcs.u64(),
  spots_sold: bcs.u64(),
  settled: bcs.bool(),
  assignments: bcs.vector(Prize),
});

export const Pull = bcs.struct("Pull", {
  id: bcs.Address,
  pool_id: bcs.Address,
  prize: Prize,
  drawn_at_ms: bcs.u64(),
});

export const Spot = bcs.struct("Spot", {
  id: bcs.Address,
  pool_id: bcs.Address,
  spot_no: bcs.u64(),
});

export const Redemption = bcs.struct("Redemption", {
  id: bcs.Address,
  pool_id: bcs.Address,
  owner: bcs.Address,
  prize: Prize,
  requested_at_ms: bcs.u64(),
  deadline_ms: bcs.u64(),
  shipped: bcs.bool(),
  tracking: bcs.string(),
});

export const DrawnEvent = bcs.struct("Drawn", {
  pool_id: bcs.Address,
  pull_id: bcs.Address,
  drawer: bcs.Address,
  prize: Prize,
  remaining: bcs.u64(),
  remaining_value: bcs.u64(),
});

export const RedeemRequestedEvent = bcs.struct("RedeemRequested", {
  pool_id: bcs.Address,
  redemption_id: bcs.Address,
  owner: bcs.Address,
  prize: Prize,
  deadline_ms: bcs.u64(),
});

export type PrizeT = ReturnType<typeof Prize.parse>;
export type PoolT = ReturnType<typeof Pool.parse>;
export type PullT = ReturnType<typeof Pull.parse> & { objectId: string };
export type SpotT = ReturnType<typeof Spot.parse> & { objectId: string };
export type RedemptionT = ReturnType<typeof Redemption.parse> & { objectId: string };
export type DrawnT = ReturnType<typeof DrawnEvent.parse> & { digest: string };
