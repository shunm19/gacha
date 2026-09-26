// Send test SUI + USDC from the operator key to another address (e.g. a demo wallet).
//   npx tsx scripts/fund.ts <address> [sui=0.15] [usdc=0.6]
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { client, keypair, readDeployed } from "./lib.ts";

const [to, sui = "0.15", usdc = "0.6"] = process.argv.slice(2);
if (!to) throw new Error("usage: fund.ts <address> [sui] [usdc]");
const d = readDeployed();
const tx = new Transaction();
tx.transferObjects(
  [coinWithBalance({ balance: BigInt(Math.round(Number(sui) * 1e9)) }), coinWithBalance({ type: d.coinType, balance: BigInt(Math.round(Number(usdc) * 1e6)) })],
  to,
);
const res = await client.signAndExecuteTransaction({ transaction: tx, signer: keypair(), include: { effects: true } });
if (res.$kind !== "Transaction") throw new Error(JSON.stringify(res.FailedTransaction?.status));
await client.waitForTransaction({ digest: res.Transaction.digest });
console.log(`sent ${sui} SUI + ${usdc} USDC to ${to}: ${res.Transaction.digest}`);
