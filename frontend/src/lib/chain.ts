import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import { Transaction } from "@mysten/sui/transactions";
import { sha256 } from "@noble/hashes/sha2.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import {
  DrawnEvent,
  Pool,
  Pull,
  RedeemRequestedEvent,
  Redemption,
  Spot,
  type DrawnT,
  type PullT,
  type RedemptionT,
  type SpotT,
} from "./bcs";
import { toHex, type CardMeta, type Metadata } from "./format";

/** Card metadata served with the app, plus its sha256 (committed on-chain). */
export function useMetadata() {
  return useQuery({
    queryKey: ["metadata"],
    staleTime: Infinity,
    queryFn: async () => {
      const buf = await (await fetch("/pool-metadata.json")).arrayBuffer();
      // Pure-JS sha256: crypto.subtle is missing on plain-http origins (LAN / Tailscale IPs).
      const hash = toHex(sha256(new Uint8Array(buf)));
      const meta = JSON.parse(new TextDecoder().decode(buf)) as Metadata;
      const byCard = new Map<number, CardMeta>(meta.cards.map((c) => [c.card_id, c]));
      return { meta, hash, byCard };
    },
  });
}

export function usePool(poolId: string | undefined) {
  const client = useCurrentClient();
  return useQuery({
    queryKey: ["pool", poolId],
    enabled: !!poolId,
    refetchInterval: 3000,
    queryFn: async () => {
      const { object } = await client.core.getObject({ objectId: poolId!, include: { content: true } });
      return { ...Pool.parse(object.content), version: object.version };
    },
  });
}

export function useUsdcBalance(coinType: string | undefined) {
  const client = useCurrentClient();
  const account = useCurrentAccount();
  return useQuery({
    queryKey: ["balance", account?.address, coinType],
    enabled: !!account && !!coinType,
    refetchInterval: 5000,
    queryFn: async () => {
      const [usdc, sui] = await Promise.all([
        client.core.getBalance({ owner: account!.address, coinType: coinType! }),
        client.core.getBalance({ owner: account!.address }),
      ]);
      return { usdc: BigInt(usdc.balance.balance), sui: BigInt(sui.balance.balance) };
    },
  });
}

function useOwned<T>(type: string | undefined, parse: (b: Uint8Array) => T) {
  const client = useCurrentClient();
  const account = useCurrentAccount();
  return useQuery({
    queryKey: ["owned", account?.address, type],
    enabled: !!account && !!type,
    refetchInterval: 4000,
    queryFn: async () => {
      const { objects } = await client.core.listOwnedObjects({
        owner: account!.address,
        type: type!,
        include: { content: true },
        limit: 50,
      });
      return objects.map((o) => ({ ...parse(o.content), objectId: o.objectId }));
    },
  });
}

export const useMyPulls = (pkg?: string) =>
  useOwned<Omit<PullT, "objectId">>(pkg && `${pkg}::pool::Pull`, (b) => Pull.parse(b)) as ReturnType<
    typeof useQuery<PullT[]>
  >;

export const useMySpots = (pkg?: string) =>
  useOwned<Omit<SpotT, "objectId">>(pkg && `${pkg}::pool::Spot`, (b) => Spot.parse(b)) as ReturnType<
    typeof useQuery<SpotT[]>
  >;

export function useOwnsObject(objectId: string | undefined) {
  const client = useCurrentClient();
  const account = useCurrentAccount();
  return useQuery({
    queryKey: ["owns", account?.address, objectId],
    enabled: !!account && !!objectId,
    refetchInterval: 10000,
    queryFn: async () => {
      const { object } = await client.core.getObject({ objectId: objectId! });
      const owner = object.owner as { $kind?: string; AddressOwner?: string };
      return owner.AddressOwner === account!.address;
    },
  });
}

/** Most recent draws in this pool, newest first. */
export function useDrawFeed(pkg: string | undefined, poolId: string | undefined) {
  const client = useCurrentClient();
  return useQuery({
    queryKey: ["feed", poolId],
    enabled: !!pkg && !!poolId,
    refetchInterval: 4000,
    queryFn: async (): Promise<DrawnT[]> => {
      const { events } = await client.core.listEvents({
        filter: { eventType: `${pkg}::pool::Drawn` },
        order: "descending",
        limit: 40,
      });
      return events
        .map((e) => ({ ...DrawnEvent.parse(e.bcs), digest: e.transactionDigest }))
        .filter((d) => d.pool_id === poolId);
    },
  });
}

/** Redemption objects still alive for this pool (optionally only mine). */
export function useRedemptions(pkg: string | undefined, poolId: string | undefined, owner?: string) {
  const client = useCurrentClient();
  return useQuery({
    queryKey: ["redemptions", poolId, owner],
    enabled: !!pkg && !!poolId,
    refetchInterval: 4000,
    queryFn: async (): Promise<RedemptionT[]> => {
      const { events } = await client.core.listEvents({
        filter: { eventType: `${pkg}::pool::RedeemRequested` },
        order: "descending",
        limit: 50,
      });
      const ids = events
        .map((e) => RedeemRequestedEvent.parse(e.bcs))
        .filter((r) => r.pool_id === poolId && (!owner || r.owner === owner))
        .map((r) => r.redemption_id);
      if (ids.length === 0) return [];
      const { objects } = await client.core.getObjects({ objectIds: ids, include: { content: true } });
      return objects
        .filter((o): o is Exclude<typeof o, Error> => !(o instanceof Error) && !!o.content)
        .map((o) => ({ ...Redemption.parse(o.content), objectId: o.objectId }));
    },
  });
}

export type ExecResult = { digest: string; events: { eventType: string; bcs: Uint8Array }[] };

/** Build, sign with the connected wallet, wait, and refresh all queries. */
export function useExec() {
  const dAppKit = useDAppKit();
  const client = useCurrentClient();
  const account = useCurrentAccount();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exec = useCallback(
    async (label: string, build: (tx: Transaction) => void): Promise<ExecResult | null> => {
      if (!account) {
        setError("Connect a wallet first");
        return null;
      }
      setBusy(label);
      setError(null);
      try {
        const tx = new Transaction();
        tx.setSender(account.address);
        build(tx);
        const res = await dAppKit.signAndExecuteTransaction({ transaction: tx });
        if (res.$kind === "FailedTransaction") {
          throw new Error(JSON.stringify(res.FailedTransaction.status));
        }
        const done = await client.core.waitForTransaction({
          digest: res.Transaction.digest,
          include: { events: true },
        });
        const t = done.Transaction ?? done.FailedTransaction;
        if (!t?.status.success) throw new Error(JSON.stringify(t?.status));
        qc.invalidateQueries();
        return { digest: t.digest, events: t.events ?? [] };
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [account, client, dAppKit, qc],
  );

  return { exec, busy, error, clearError: () => setError(null) };
}
