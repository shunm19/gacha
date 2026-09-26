// Create a pool from scripts/pool_spec.json (written by export_cards.py),
// locking the USDC collateral in the same transaction.
//   npx tsx scripts/seed.ts                    instant pool, key "main"
//   npx tsx scripts/seed.ts --batch --minutes 20 --count 12   batch pool, key "batch"
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Transaction } from "@mysten/sui/transactions";
import { fromHex } from "@mysten/sui/utils";
import { ROOT, client, createdObjects, keypair, payCoin, readDeployed, writeDeployed } from "./lib.ts";

const { values: args } = parseArgs({
  options: {
    batch: { type: "boolean", default: false },
    minutes: { type: "string", default: "20" },
    count: { type: "string", default: "12" },
    key: { type: "string" },
  },
});

type Spec = {
  name: string;
  price: number;
  card_ids: number[];
  certs: number[];
  values: number[];
  tiers: number[];
  metadata_hash: string;
  collateral_bps: number;
  redeem_window_ms: number;
  values_jpy: number[];
  price_jpy: number;
};

const spec = JSON.parse(readFileSync(resolve(ROOT, "scripts/pool_spec.json"), "utf8")) as Spec;
const deployed = readDeployed();
const kp = keypair();

// A batch pool uses a smaller slice of the same cards (one of each tier first).
let idx = spec.card_ids.map((_, i) => i);
if (args.batch) {
  const n = Number(args.count);
  const byTier = [0, 1, 2, 3].map((t) => idx.filter((i) => spec.tiers[i] === t));
  idx = [byTier[0][0], ...byTier[1].slice(0, 2), ...byTier[2].slice(0, 3), ...byTier[3]].slice(0, n);
}
const pick = <T,>(xs: T[]) => idx.map((i) => xs[i]);
// Gacha Point pools (bank present) use yen values directly: 1 GP = 1 JPY.
const gp = !!deployed.bankId;
const values = pick(gp ? spec.values_jpy : spec.values);
const totalValue = values.reduce((a, b) => a + b, 0);
const collateral = Math.ceil((totalValue * spec.collateral_bps) / 10_000);
// A subset keeps the same ~95% return; the full pool uses the exported price.
const price =
  idx.length === spec.card_ids.length
    ? gp ? spec.price_jpy : spec.price
    : gp ? Math.round(totalValue / (idx.length * 0.95) / 100) * 100 : Math.round(totalValue / (idx.length * 0.95));

const tx = new Transaction();
const common = [
  tx.pure.string(args.batch ? `${spec.name} — Batch Break` : spec.name),
  tx.pure.u64(price),
  tx.pure.vector("u64", pick(spec.card_ids)),
  tx.pure.vector("u64", pick(spec.certs)),
  tx.pure.vector("u64", values),
  tx.pure.vector("u8", pick(spec.tiers)),
  tx.pure.vector("u8", Array.from(fromHex(spec.metadata_hash))),
  payCoin(tx, deployed, collateral),
  tx.pure.u64(spec.collateral_bps),
  tx.pure.u64(spec.redeem_window_ms),
];
if (args.batch) {
  const saleEnd = Date.now() + Number(args.minutes) * 60_000;
  tx.moveCall({
    target: `${deployed.packageId}::pool::create_batch_pool`,
    typeArguments: [deployed.coinType],
    arguments: [...common, tx.pure.u64(saleEnd)],
  });
} else {
  tx.moveCall({
    target: `${deployed.packageId}::pool::create_pool`,
    typeArguments: [deployed.coinType],
    arguments: common,
  });
}

console.log(
  `creating ${args.batch ? "batch" : "instant"} pool: ${idx.length} prizes, ` +
    `price ${price} ${gp ? "GP" : "units"}, collateral ${collateral} ${gp ? "GP" : "units"}`,
);
const res = await client.signAndExecuteTransaction({
  transaction: tx,
  signer: kp,
  include: { effects: true, objectTypes: true },
});
if (res.$kind !== "Transaction") throw new Error(`create failed: ${JSON.stringify(res.FailedTransaction?.status)}`);
const t = res.Transaction;
await client.waitForTransaction({ digest: t.digest });

const created = createdObjects(t.effects, t.objectTypes);
const pool = created.find((o) => o.type.includes("::pool::Pool<"));
const cap = created.find((o) => o.type.endsWith("::pool::AdminCap"));
if (!pool || !cap) throw new Error(`pool/cap not found in ${JSON.stringify(created)}`);
console.log(`pool ${pool.id}\ncap  ${cap.id}\ntx   ${t.digest}`);

const key = args.key ?? (args.batch ? "batch" : "main");
deployed.pools[key] = {
  poolId: pool.id,
  adminCapId: cap.id,
  mode: args.batch ? "batch" : "instant",
  createDigest: t.digest,
};
writeDeployed(deployed);
