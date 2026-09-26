// Create a blind (Japanese-format) pool on the v2 package:
//   1. create_blind_pool with the public lineup and USDC collateral
//   2. shuffle lineup -> slots locally, commit sha256(slot, prize, salt) and
//      Seal-encrypt (prize, salt) to identity pool_id || slot for each slot
//   3. add_slots (chunked) + seal_slots in one tx
// Secrets are kept in .sui/blind-<pool>.json (gitignored) so the operator can
// reveal after close; anyone can also recover them via Seal once public.
//   npx tsx scripts/seed-blind.ts [--count 20] [--tail 3] [--hours 12]
import { randomBytes, randomInt } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { bcs } from "@mysten/sui/bcs";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { fromHex, toHex } from "@mysten/sui/utils";
import { SealClient } from "@mysten/seal";
import { sha256 } from "@noble/hashes/sha2.js";
import { ROOT, client, createdObjects, keypair, readDeployed, writeDeployed } from "./lib.ts";

export const SEAL = {
  // Mysten's decentralized (committee) key server on testnet, via its aggregator.
  serverObjectIds: ["0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98"],
  aggregatorUrl: "https://seal-aggregator-testnet.mystenlabs.com",
  threshold: 1,
};

const { values: args } = parseArgs({
  options: {
    count: { type: "string", default: "20" },
    tail: { type: "string", default: "3" },
    hours: { type: "string", default: "12" },
    "return-rate": { type: "string", default: "0.95" },
    // "mini": a cheap 6-slot lineup (1 A, 2 B, 3 C) to show the full lifecycle in a demo.
    lineup: { type: "string", default: "full" },
    key: { type: "string", default: "main" },
    minutes: { type: "string" },
  },
});

type Spec = {
  name: string;
  card_ids: number[];
  certs: number[];
  values: number[];
  tiers: number[];
  metadata_hash: string;
  collateral_bps: number;
  redeem_window_ms: number;
};
const spec = JSON.parse(readFileSync(resolve(ROOT, "scripts/pool_spec.json"), "utf8")) as Spec;
const d = readDeployed();
if (!d.blind) throw new Error("run `npx tsx scripts/deploy.ts --blind` first");
const pkg = d.blind.packageId;
const kp = keypair();

// Lineup: the jackpot and the next S, then A/B/C to fill `count`.
const n = Number(args.count);
const all = spec.card_ids.map((_, i) => i);
const byTier = [0, 1, 2, 3].map((t) => all.filter((i) => spec.tiers[i] === t));
const idx =
  args.lineup === "mini"
    ? [byTier[1][4], ...byTier[2].slice(0, 2), ...byTier[3].slice(0, 3)].slice(0, n)
    : [...byTier[0].slice(0, 2), ...byTier[1].slice(0, 3), ...byTier[2].slice(0, 4), ...byTier[3]].slice(0, n);
const pick = <T,>(xs: T[]) => idx.map((i) => xs[i]);
const values = pick(spec.values);
const total = values.reduce((a, b) => a + b, 0);
const price = Math.round(total / (n * Number(args["return-rate"])));
const collateral = Math.ceil((total * spec.collateral_bps) / 10_000);
const saleEnd = Date.now() + (args.minutes ? Number(args.minutes) * 60_000 : Number(args.hours) * 3600_000);

// --- 1. create ---
const tx1 = new Transaction();
tx1.moveCall({
  target: `${pkg}::blind::create_blind_pool`,
  typeArguments: [d.coinType],
  arguments: [
    tx1.pure.string(`${spec.name.replace("#1", "")}Blind${args.lineup === "mini" ? " Mini" : ""} (JP format)`),
    tx1.pure.u64(price),
    tx1.pure.vector("u64", pick(spec.card_ids)),
    tx1.pure.vector("u64", pick(spec.certs)),
    tx1.pure.vector("u64", values),
    tx1.pure.vector("u8", pick(spec.tiers)),
    tx1.pure.vector("u8", Array.from(fromHex(spec.metadata_hash))),
    tx1.pure.u64(Number(args.tail)),
    tx1.pure.u64(saleEnd),
    coinWithBalance({ type: d.coinType, balance: collateral }),
    tx1.pure.u64(spec.collateral_bps),
    tx1.pure.u64(spec.redeem_window_ms),
  ],
});
console.log(`creating blind pool: ${n} slots, price ${price / 1e6} USDC, collateral ${collateral / 1e6} USDC, tail ${args.tail}`);
const r1 = await client.signAndExecuteTransaction({ transaction: tx1, signer: kp, include: { effects: true, objectTypes: true } });
if (r1.$kind !== "Transaction") throw new Error(JSON.stringify(r1.FailedTransaction?.status));
await client.waitForTransaction({ digest: r1.Transaction.digest });
const created = createdObjects(r1.Transaction.effects, r1.Transaction.objectTypes);
const poolId = created.find((o) => o.type.includes("::blind::BlindPool<"))!.id;
const capId = created.find((o) => o.type.endsWith("::blind::BlindCap"))!.id;
console.log(`pool ${poolId}\ncap  ${capId}`);

// --- 2. hide: random slot -> prize mapping, commitments, Seal ciphertexts ---
const mapping = [...Array(n).keys()];
for (let i = n - 1; i > 0; i--) {
  const j = randomInt(i + 1);
  [mapping[i], mapping[j]] = [mapping[j], mapping[i]];
}
const u64 = (x: number) => bcs.u64().serialize(x).toBytes();
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};
const seal = new SealClient({
  suiClient: client,
  serverConfigs: SEAL.serverObjectIds.map((objectId) => ({ objectId, weight: 1, aggregatorUrl: SEAL.aggregatorUrl })),
  verifyKeyServers: false,
});
const poolBytes = fromHex(poolId);
const slots = [];
for (let slot = 0; slot < n; slot++) {
  const salt = new Uint8Array(randomBytes(32));
  const prize = mapping[slot];
  const commitment = sha256(cat(u64(slot), u64(prize), salt));
  const id = toHex(cat(poolBytes, u64(slot)));
  const { encryptedObject } = await seal.encrypt({ threshold: SEAL.threshold, packageId: pkg, id, data: cat(u64(prize), salt) });
  slots.push({ slot, prize, salt: toHex(salt), commitment, ciphertext: encryptedObject });
}
console.log(`encrypted ${n} slots (ciphertext ${slots[0].ciphertext.length} bytes each)`);
writeFileSync(
  resolve(ROOT, `.sui/blind-${poolId.slice(0, 10)}.json`),
  JSON.stringify(slots.map(({ slot, prize, salt }) => ({ slot, prize, salt })), null, 2),
);

// --- 3. load + seal ---
const tx2 = new Transaction();
for (let i = 0; i < n; i += 8) {
  const chunk = slots.slice(i, i + 8);
  tx2.moveCall({
    target: `${pkg}::blind::add_slots`,
    typeArguments: [d.coinType],
    arguments: [
      tx2.object(capId),
      tx2.object(poolId),
      tx2.pure(bcs.vector(bcs.vector(bcs.u8())).serialize(chunk.map((s) => Array.from(s.commitment)))),
      tx2.pure(bcs.vector(bcs.vector(bcs.u8())).serialize(chunk.map((s) => Array.from(s.ciphertext)))),
    ],
  });
}
tx2.moveCall({ target: `${pkg}::blind::seal_slots`, typeArguments: [d.coinType], arguments: [tx2.object(capId), tx2.object(poolId)] });
const r2 = await client.signAndExecuteTransaction({ transaction: tx2, signer: kp, include: { effects: true } });
if (r2.$kind !== "Transaction") throw new Error(JSON.stringify(r2.FailedTransaction?.status));
await client.waitForTransaction({ digest: r2.Transaction.digest });
console.log(`sealed in ${r2.Transaction.digest}`);

const entry = { poolId, capId, createDigest: r1.Transaction.digest, sealDigest: r2.Transaction.digest };
d.blind = {
  ...d.blind,
  ...(args.key === "main" ? entry : {}),
  pools: { ...(d.blind.pools ?? {}), [args.key]: entry },
  seal: { serverObjectIds: SEAL.serverObjectIds, threshold: SEAL.threshold, aggregatorUrl: SEAL.aggregatorUrl },
};
writeDeployed(d);
