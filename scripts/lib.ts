// Shared helpers for deploy / seed. Testnet only; the key is a throwaway
// generated into .sui/ (gitignored) by `make wallet`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromBase64 } from "@mysten/sui/utils";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// ORIPA_NETWORK=local runs everything against `sui start` (localnet, SUI as the coin)
// with its own config/key in .sui-local/, so the testnet setup is never touched.
export const LOCAL = process.env.ORIPA_NETWORK === "local";
export const NETWORK = LOCAL ? "local" : "testnet";
const SUI_DIR = resolve(ROOT, LOCAL ? ".sui-local" : ".sui");
export const SUI_CONFIG = resolve(SUI_DIR, "client.yaml");
export const DEPLOYED = resolve(ROOT, `frontend/src/config/deployed${LOCAL ? ".local" : ""}.json`);
export const USDC_TYPE = LOCAL
  ? "0x2::sui::SUI"
  : "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";

export const client = new SuiGrpcClient({
  network: LOCAL ? "localnet" : "testnet",
  baseUrl: LOCAL ? "http://127.0.0.1:9000" : "https://fullnode.testnet.sui.io:443",
});

export function keypair(): Ed25519Keypair {
  const keys = JSON.parse(readFileSync(resolve(SUI_DIR, "sui.keystore"), "utf8")) as string[];
  const kp = Ed25519Keypair.fromSecretKey(fromBase64(keys[0]).slice(1));
  const active = execFileSync("sui", ["client", "--client.config", SUI_CONFIG, "active-address"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  if (kp.toSuiAddress() !== active) {
    throw new Error(`keystore[0] ${kp.toSuiAddress()} != active address ${active}`);
  }
  return kp;
}

export type Deployed = {
  network: "testnet";
  packageId: string;
  publishDigest: string;
  coinType: string;
  operator: string;
  pools: Record<
    string,
    { poolId: string; adminCapId: string; mode: "instant" | "batch"; createDigest: string }
  >;
  /** Package v2 (adds the blind module) and its Seal-backed pool. */
  blind?: {
    packageId: string;
    publishDigest: string;
    poolId?: string;
    capId?: string;
    createDigest?: string;
    sealDigest?: string;
    seal?: { serverObjectIds: string[]; threshold: number; aggregatorUrl?: string };
    pools?: Record<string, { poolId: string; capId: string; createDigest: string; sealDigest: string }>;
  };
};

export function readDeployed(): Deployed {
  if (!existsSync(DEPLOYED)) throw new Error("run `make deploy` first");
  return JSON.parse(readFileSync(DEPLOYED, "utf8"));
}

export function writeDeployed(d: Deployed) {
  writeFileSync(DEPLOYED, JSON.stringify(d, null, 2) + "\n");
  console.log(`wrote ${DEPLOYED}`);
}

/** Map created object ids to their Move types for a finished transaction. */
export function createdObjects(
  effects: { changedObjects: { objectId: string; idOperation: string }[] },
  objectTypes: Record<string, string>,
) {
  return effects.changedObjects
    .filter((o) => o.idOperation === "Created")
    .map((o) => ({ id: o.objectId, type: objectTypes[o.objectId] ?? "" }));
}
