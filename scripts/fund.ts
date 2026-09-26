// Send test SUI + USDC from the operator key to another address (e.g. a demo wallet).
//   npx tsx scripts/fund.ts <address> [sui=0.15] [points=0.6]
// For Gacha Point deployments the second amount is whole GP (charged, not sent).
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { client, keypair, payCoin, readDeployed } from "./lib.ts";

const [to, sui = "0.15", usdc = "0.6"] = process.argv.slice(2);
if (!to) throw new Error("usage: fund.ts <address> [sui] [usdc]");
const d = readDeployed();
const tx = new Transaction();
const coins = [coinWithBalance({ balance: BigInt(Math.round(Number(sui) * 1e9)) })];
if (Number(usdc) > 0) {
  coins.push(
    d.bankId
      ? payCoin(tx, d, BigInt(Math.round(Number(usdc))))
      : coinWithBalance({ type: d.coinType, balance: BigInt(Math.round(Number(usdc) * 1e6)) }),
  );
}
tx.transferObjects(coins, to);
const res = await client.signAndExecuteTransaction({ transaction: tx, signer: keypair(), include: { effects: true } });
if (res.$kind !== "Transaction") throw new Error(JSON.stringify(res.FailedTransaction?.status));
await client.waitForTransaction({ digest: res.Transaction.digest });
console.log(`sent ${sui} SUI + ${usdc} ${d.bankId ? "GP" : "USDC"} to ${to}: ${res.Transaction.digest}`);
