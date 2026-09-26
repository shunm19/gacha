// End-to-end smoke test of the same calls the frontend makes, signed by the
// operator key: draw, decode events/objects via BCS, list events, read ABI,
// request redemption, and (with --claim) wait out the window and claim.
//   ORIPA_NETWORK=local npx tsx scripts/smoke.ts [--draws 3] [--claim]
import { parseArgs } from "node:util";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { DrawnEvent, Pool, Pull, Redemption } from "../frontend/src/lib/bcs.ts";
import { client, keypair, readDeployed } from "./lib.ts";

const { values: args } = parseArgs({
  options: { draws: { type: "string", default: "3" }, claim: { type: "boolean", default: false } },
});
const d = readDeployed();
const kp = keypair();
const me = kp.toSuiAddress();
const poolId = d.pools.main.poolId;

async function run(build: (tx: Transaction) => void) {
  const tx = new Transaction();
  tx.setSender(me);
  build(tx);
  const res = await client.signAndExecuteTransaction({ transaction: tx, signer: kp, include: { events: true, effects: true } });
  if (res.$kind !== "Transaction") throw new Error(JSON.stringify(res.FailedTransaction?.status));
  await client.waitForTransaction({ digest: res.Transaction.digest });
  return res.Transaction;
}

async function readPool() {
  const { object } = await client.core.getObject({ objectId: poolId, include: { content: true } });
  return Pool.parse(object.content);
}

let pool = await readPool();
console.log(`pool "${pool.name}" left ${pool.remaining.length}/${pool.total_count} value ${pool.remaining_value} price ${pool.price}`);

for (let i = 0; i < Number(args.draws); i++) {
  const t = await run((tx) =>
    tx.moveCall({
      target: `${d.packageId}::pool::draw`,
      typeArguments: [d.coinType],
      arguments: [tx.object(poolId), coinWithBalance({ type: d.coinType, balance: BigInt(pool.price) }), tx.object.random(), tx.object.clock()],
    }),
  );
  const ev = t.events!.find((e) => e.eventType.endsWith("::pool::Drawn"))!;
  const drawn = DrawnEvent.parse(ev.bcs);
  console.log(`draw ${i + 1}: card ${drawn.prize.card_id} tier ${drawn.prize.tier} value ${drawn.prize.value} left ${drawn.remaining}  gas ${t.effects!.gasUsed.computationCost}/${t.effects!.gasUsed.storageCost}`);
}

pool = await readPool();
console.log(`after: left ${pool.remaining.length} remaining_value ${pool.remaining_value} sales ${pool.sales}`);

const { events } = await client.core.listEvents({ filter: { eventType: `${d.packageId}::pool::Drawn` }, order: "descending", limit: 10 });
console.log(`listEvents(Drawn): ${events.length} events, newest card ${DrawnEvent.parse(events[0].bcs).prize.card_id}`);

const { objects } = await client.core.listOwnedObjects({ owner: me, type: `${d.packageId}::pool::Pull`, include: { content: true } });
const pulls = objects.map((o) => ({ ...Pull.parse(o.content), objectId: o.objectId }));
console.log(`owned Pulls: ${pulls.length}`);

const pkg = await client.movePackageService.getPackage({ packageId: d.packageId });
const fns = pkg.response.package?.modules.find((m) => m.name === "pool")?.functions ?? [];
console.log(`ABI: ${fns.length} functions; draw entry=${fns.find((f) => f.name === "draw")?.isEntry} vis=${fns.find((f) => f.name === "draw")?.visibility}`);

const target = pulls[0];
const rt = await run((tx) =>
  tx.moveCall({
    target: `${d.packageId}::pool::request_redeem`,
    typeArguments: [d.coinType],
    arguments: [tx.object(poolId), tx.object(target.objectId), tx.object.clock()],
  }),
);
const created = rt.effects!.changedObjects.find((o) => o.idOperation === "Created")!;
const { object: robj } = await client.core.getObject({ objectId: created.objectId, include: { content: true } });
const red = Redemption.parse(robj.content);
console.log(`redemption ${created.objectId} deadline in ${(Number(red.deadline_ms) - Date.now()) / 1000}s shipped=${red.shipped}`);

if (args.claim) {
  const wait = Number(red.deadline_ms) - Date.now() + 5000;
  console.log(`waiting ${Math.round(wait / 1000)}s for the deadline…`);
  await new Promise((r) => setTimeout(r, wait));
  const ct = await run((tx) =>
    tx.moveCall({
      target: `${d.packageId}::pool::claim_collateral`,
      typeArguments: [d.coinType],
      arguments: [tx.object(poolId), tx.object(created.objectId), tx.object.clock()],
    }),
  );
  pool = await readPool();
  console.log(`claimed in ${ct.digest}; collateral now ${pool.collateral}, outstanding ${pool.outstanding}`);
}
