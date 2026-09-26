// deployed.json is written by scripts/deploy.ts and scripts/seed.ts.
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
  blind?: {
    packageId: string;
    publishDigest: string;
    poolId?: string;
    capId?: string;
    createDigest?: string;
    sealDigest?: string;
    seal?: { serverObjectIds: string[]; threshold: number; aggregatorUrl?: string };
  };
};

export const LOCAL = import.meta.env.VITE_ORIPA_NETWORK === "local";

const found = import.meta.glob<{ default: Deployed }>("./config/deployed*.json", { eager: true });
export const deployed: Deployed | null =
  found[LOCAL ? "./config/deployed.local.json" : "./config/deployed.json"]?.default ?? null;

export const RANDOM_OBJECT = "0x8";
