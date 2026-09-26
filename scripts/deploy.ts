// Publish the oripa package and make it immutable in the same transaction:
// the UpgradeCap goes straight into 0x2::package::make_immutable, so nobody
// (including us) can ever add a function that touches existing pools.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Transaction } from "@mysten/sui/transactions";
import { existsSync } from "node:fs";
import { DEPLOYED, ROOT, SUI_CONFIG, USDC_TYPE, client, createdObjects, keypair, readDeployed, writeDeployed } from "./lib.ts";

// --blind: publish a new package version for the blind pool, keeping existing pools.
const BLIND = process.argv.includes("--blind");

const kp = keypair();
const build = JSON.parse(
  execFileSync(
    "sui",
    ["move", "--client.config", SUI_CONFIG, "build", "--dump-bytecode-as-base64", "--path", "move/oripa", "-e", "testnet"],
    { cwd: ROOT, encoding: "utf8" },
  ),
) as { modules: string[]; dependencies: string[] };

const tx = new Transaction();
const upgradeCap = tx.publish({ modules: build.modules, dependencies: build.dependencies });
tx.moveCall({ target: "0x2::package::make_immutable", arguments: [upgradeCap] });

const res = await client.signAndExecuteTransaction({
  transaction: tx,
  signer: kp,
  include: { effects: true, objectTypes: true },
});
if (res.$kind !== "Transaction") throw new Error(`publish failed: ${JSON.stringify(res.FailedTransaction?.status)}`);
const t = res.Transaction;
await client.waitForTransaction({ digest: t.digest });

const pkg = t.effects.changedObjects.find((o) => o.outputState === "PackageWrite");
if (!pkg) throw new Error("no package in effects");
const created = createdObjects(t.effects, t.objectTypes);
console.log(`package ${pkg.objectId}  (immutable)  tx ${t.digest}`);
for (const o of created) console.log(`  created ${o.type}  ${o.id}`);

mkdirSync(dirname(DEPLOYED), { recursive: true });
if (BLIND && existsSync(DEPLOYED)) {
  const d = readDeployed();
  d.blind = { packageId: pkg.objectId, publishDigest: t.digest };
  writeDeployed(d);
  process.exit(0);
}
writeDeployed({
  network: "testnet",
  packageId: pkg.objectId,
  publishDigest: t.digest,
  coinType: USDC_TYPE,
  operator: kp.toSuiAddress(),
  pools: {},
});
