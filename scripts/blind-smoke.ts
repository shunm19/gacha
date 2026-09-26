// Draw once from the blind pool with the operator key, then decrypt the slot
// as its holder through Seal and check the on-chain commitment.
import { SessionKey } from "@mysten/seal";
import { Transaction } from "@mysten/sui/transactions";
import { BlindDrawnEvent, BlindPool } from "../frontend/src/lib/bcs.ts";
import { makeSeal, openSlots } from "../frontend/src/lib/blind.ts";
import { client, keypair, payCoin, readDeployed } from "./lib.ts";

const d = readDeployed();
const b = d.blind!;
const kp = keypair();
const readPool = async () => {
  const { object } = await client.core.getObject({ objectId: b.poolId!, include: { content: true } });
  return BlindPool.parse(object.content);
};
let pool = await readPool();
console.log(`blind pool: ${pool.remaining.length}/${pool.lineup.length} left, sealed=${pool.sealed}, price ${pool.price}`);

const tx = new Transaction();
tx.moveCall({
  target: `${b.packageId}::blind::draw`,
  typeArguments: [d.coinType],
  arguments: [tx.object(b.poolId!), payCoin(tx, d, BigInt(pool.price)), tx.object.random(), tx.object.clock()],
});
const res = await client.signAndExecuteTransaction({ transaction: tx, signer: kp, include: { events: true } });
if (res.$kind !== "Transaction") throw new Error(JSON.stringify(res.FailedTransaction?.status));
await client.waitForTransaction({ digest: res.Transaction.digest });
const ev = BlindDrawnEvent.parse(res.Transaction.events!.find((e) => e.eventType.endsWith("::blind::BlindDrawn"))!.bcs);
console.log(`drew slot ${ev.slot_id} (pull ${ev.pull_id}), ${ev.remaining} left — the event carries no prize`);

pool = await readPool();
const seal = makeSeal(client, b.seal!);
const sessionKey = await SessionKey.create({ address: kp.toSuiAddress(), packageId: b.packageId, ttlMin: 10, suiClient: client, signer: kp });
const t0 = Date.now();
const [opened] = await openSlots({
  seal, client, sessionKey, cfg: b.seal!, pkg: b.packageId, coinType: d.coinType, poolId: b.poolId!,
  commitments: pool.commitments, mode: "holder",
  slots: [{ slot: Number(ev.slot_id), ciphertext: Uint8Array.from(pool.ciphertexts[Number(ev.slot_id)]), pullId: ev.pull_id }],
});
console.log(`holder decrypt in ${Date.now() - t0}ms: slot ${opened.slot} -> prize ${opened.prize} (card ${pool.lineup[opened.prize].card_id}, tier ${pool.lineup[opened.prize].tier}) commitmentOk=${opened.commitmentOk}`);

// A different slot must NOT decrypt as holder.
try {
  const other = (Number(ev.slot_id) + 1) % pool.lineup.length;
  await openSlots({
    seal, client, sessionKey, cfg: b.seal!, pkg: b.packageId, coinType: d.coinType, poolId: b.poolId!,
    commitments: pool.commitments, mode: "public",
    slots: [{ slot: other, ciphertext: Uint8Array.from(pool.ciphertexts[other]) }],
  });
  console.log("UNEXPECTED: public decrypt succeeded during sale");
} catch (e) {
  console.log(`public decrypt during sale correctly denied: ${(e as Error).constructor.name}`);
}
