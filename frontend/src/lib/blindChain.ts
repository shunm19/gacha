import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import { SessionKey } from "@mysten/seal";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import {
  BlindDrawnEvent,
  BlindPool,
  BlindPull,
  BlindRedeemRequestedEvent,
  BlindRedemption,
  type BlindPullT,
  type BlindRedemptionT,
} from "./bcs";
import { makeSeal, type SealConfig } from "./blind";

export function useBlindPool(poolId: string | undefined) {
  const client = useCurrentClient();
  return useQuery({
    queryKey: ["blindPool", poolId],
    enabled: !!poolId,
    refetchInterval: 3000,
    queryFn: async () => {
      const { object } = await client.core.getObject({ objectId: poolId!, include: { content: true } });
      return BlindPool.parse(object.content);
    },
  });
}

export function useMyBlindPulls(pkg: string | undefined, poolId: string | undefined) {
  const client = useCurrentClient();
  const account = useCurrentAccount();
  return useQuery({
    queryKey: ["blindPulls", account?.address, pkg],
    enabled: !!account && !!pkg,
    refetchInterval: 4000,
    queryFn: async (): Promise<BlindPullT[]> => {
      const { objects } = await client.core.listOwnedObjects({
        owner: account!.address,
        type: `${pkg}::blind::BlindPull`,
        include: { content: true },
        limit: 50,
      });
      return objects
        .map((o) => ({ ...BlindPull.parse(o.content), objectId: o.objectId }))
        .filter((p) => p.pool_id === poolId);
    },
  });
}

/** Draw count only: BlindDrawn carries the slot id, never the prize. */
export function useBlindFeed(pkg: string | undefined, poolId: string | undefined) {
  const client = useCurrentClient();
  return useQuery({
    queryKey: ["blindFeed", poolId],
    enabled: !!pkg && !!poolId,
    refetchInterval: 4000,
    queryFn: async () => {
      const { events } = await client.core.listEvents({
        filter: { eventType: `${pkg}::blind::BlindDrawn` },
        order: "descending",
        limit: 30,
      });
      return events
        .map((e) => ({ ...BlindDrawnEvent.parse(e.bcs), digest: e.transactionDigest }))
        .filter((d) => d.pool_id === poolId);
    },
  });
}

export function useBlindRedemptions(pkg: string | undefined, poolId: string | undefined, owner?: string) {
  const client = useCurrentClient();
  return useQuery({
    queryKey: ["blindRedemptions", poolId, owner],
    enabled: !!pkg && !!poolId,
    refetchInterval: 4000,
    queryFn: async (): Promise<BlindRedemptionT[]> => {
      const { events } = await client.core.listEvents({
        filter: { eventType: `${pkg}::blind::BlindRedeemRequested` },
        order: "descending",
        limit: 50,
      });
      const ids = events
        .map((e) => BlindRedeemRequestedEvent.parse(e.bcs))
        .filter((r) => r.pool_id === poolId && (!owner || r.owner === owner))
        .map((r) => r.redemption_id);
      if (ids.length === 0) return [];
      const { objects } = await client.core.getObjects({ objectIds: ids, include: { content: true } });
      return objects
        .filter((o): o is Exclude<typeof o, Error> => !(o instanceof Error) && !!o.content)
        .map((o) => ({ ...BlindRedemption.parse(o.content), objectId: o.objectId }));
    },
  });
}

/** Seal client + a session key signed once by the wallet (30 min). */
export function useSeal(pkg: string | undefined, cfg: SealConfig | undefined) {
  const client = useCurrentClient();
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  const cache = useRef<SessionKey | null>(null);
  const seal = useMemo(() => (cfg ? makeSeal(client, cfg) : null), [client, cfg]);

  const sessionKey = useCallback(async () => {
    if (!account || !pkg) throw new Error("Connect a wallet first");
    const c = cache.current;
    if (c && !c.isExpired() && c.getAddress() === account.address) return c;
    const key = await SessionKey.create({ address: account.address, packageId: pkg, ttlMin: 30, suiClient: client });
    const { signature } = await dAppKit.signPersonalMessage({ message: key.getPersonalMessage() });
    await key.setPersonalMessageSignature(signature);
    cache.current = key;
    return key;
  }, [account, client, dAppKit, pkg]);

  return { seal, sessionKey };
}
