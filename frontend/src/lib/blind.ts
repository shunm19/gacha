// Seal + commitment helpers for the blind pool, shared by the app and scripts.
import { SealClient, type SessionKey } from "@mysten/seal";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { fromHex, toHex } from "@mysten/sui/utils";
import { sha256 } from "@noble/hashes/sha2.js";

export type SealConfig = { serverObjectIds: string[]; threshold: number; aggregatorUrl?: string };

const u64 = (x: number | bigint | string) => bcs.u64().serialize(x).toBytes();
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

/** Seal identity (without package prefix): pool_id || bcs(slot_id). */
export const sealId = (poolId: string, slot: number | string) => toHex(cat(fromHex(poolId), u64(slot)));

export const commitmentOf = (slot: number | string, prize: number | string, salt: Uint8Array) =>
  sha256(cat(u64(slot), u64(prize), salt));

export function parsePlain(bytes: Uint8Array) {
  const prize = Number(bcs.u64().parse(bytes.slice(0, 8)));
  return { prize, salt: bytes.slice(8, 40) };
}

export const makeSeal = (client: ClientWithCoreApi, cfg: SealConfig) =>
  new SealClient({
    suiClient: client,
    serverConfigs: cfg.serverObjectIds.map((objectId) => ({ objectId, weight: 1, aggregatorUrl: cfg.aggregatorUrl })),
    verifyKeyServers: false,
  });

export type SlotToOpen = { slot: number; ciphertext: Uint8Array; pullId?: string };
export type Opened = { slot: number; prize: number; salt: Uint8Array; commitmentOk: boolean };

/**
 * Decrypt slots in one key request. `holder` mode proves ownership of each
 * slot's Pull; `public` mode works once the pool is closed or in its tail.
 */
export async function openSlots(opts: {
  seal: SealClient;
  client: ClientWithCoreApi;
  sessionKey: SessionKey;
  cfg: SealConfig;
  pkg: string;
  coinType: string;
  poolId: string;
  commitments: number[][];
  slots: SlotToOpen[];
  mode: "holder" | "public";
}): Promise<Opened[]> {
  const { seal, client, sessionKey, cfg, pkg, coinType, poolId, commitments, slots, mode } = opts;
  if (slots.length === 0) return [];
  const tx = new Transaction();
  const ids = slots.map((s) => sealId(poolId, s.slot));
  slots.forEach((s, i) => {
    if (mode === "holder") {
      tx.moveCall({
        target: `${pkg}::blind::seal_approve_holder`,
        arguments: [tx.pure.vector("u8", Array.from(fromHex(ids[i]))), tx.object(s.pullId!)],
      });
    } else {
      tx.moveCall({
        target: `${pkg}::blind::seal_approve_public`,
        typeArguments: [coinType],
        arguments: [tx.pure.vector("u8", Array.from(fromHex(ids[i]))), tx.object(poolId)],
      });
    }
  });
  const txBytes = await tx.build({ client, onlyTransactionKind: true });
  await seal.fetchKeys({ ids, txBytes, sessionKey, threshold: cfg.threshold });
  const out: Opened[] = [];
  for (const s of slots) {
    const plain = await seal.decrypt({ data: s.ciphertext, sessionKey, txBytes });
    const { prize, salt } = parsePlain(plain);
    const expected = commitments[s.slot];
    const got = commitmentOf(s.slot, prize, salt);
    out.push({ slot: s.slot, prize, salt, commitmentOk: toHex(got) === toHex(Uint8Array.from(expected)) });
  }
  return out;
}
