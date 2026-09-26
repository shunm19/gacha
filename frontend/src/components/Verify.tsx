import { useCurrentClient } from "@mysten/dapp-kit-react";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Deployed } from "../config";
import { useDrawFeed, usePool } from "../lib/chain";
import { n, objUrl, pct, toHex, txUrl, usdc, type Metadata } from "../lib/format";

type Body = {
  type?: number;
  typeName?: string;
  typeParameterInstantiation: Body[];
  typeParameter?: number;
};
type Sig = { reference?: number; body?: Body };

const PRIMS: Record<number, string> = { 1: "address", 2: "bool", 3: "u8", 4: "u16", 5: "u32", 6: "u64", 7: "u128", 8: "u256" };

function fmtBody(b?: Body): string {
  if (!b) return "?";
  if (b.typeName) {
    const name = b.typeName.split("::").slice(-2).join("::");
    const args = b.typeParameterInstantiation.map(fmtBody);
    return args.length ? `${name}<${args.join(", ")}>` : name;
  }
  if (b.typeParameter !== undefined) return `T${b.typeParameter}`;
  if (b.type === 9) return `vector<${fmtBody(b.typeParameterInstantiation[0])}>`;
  return PRIMS[b.type ?? 0] ?? "?";
}
const fmtSig = (s: Sig) => `${s.reference === 2 ? "&mut " : s.reference === 1 ? "&" : ""}${fmtBody(s.body)}`;

// What each function that takes `&mut Pool` is allowed to change.
const WRITES: Record<string, string> = {
  draw: "removes 1 random prize, adds payment to sales",
  buy_spot: "sells a spot (batch)",
  settle: "one shuffle, assigns sold spots (batch)",
  request_redeem: "opens a shipping request",
  mark_shipped: "marks shipped before deadline (AdminCap)",
  claim_collateral: "pays winner from collateral after deadline",
  withdraw_sales: "operator takes sales (AdminCap)",
  withdraw_collateral: "only after close + window + nothing outstanding",
};

function Check({ ok, title, children }: { ok: boolean | undefined; title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border bg-white/[0.03] p-4">
      <div className="flex items-center gap-2 font-semibold">
        <span className={ok === undefined ? "text-muted-foreground" : ok ? "text-emerald-400" : "text-red-400"}>
          {ok === undefined ? "…" : ok ? "✓" : "✗"}
        </span>
        {title}
      </div>
      <div className="mt-2 space-y-1 text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

export function Verify({
  deployed,
  poolId,
  meta,
  metaHash,
}: {
  deployed: Deployed;
  poolId: string;
  meta: Metadata;
  metaHash: string;
}) {
  const client = useCurrentClient() as unknown as SuiGrpcClient;
  const { data: pool } = usePool(poolId);
  const { data: feed } = useDrawFeed(deployed.packageId, poolId);

  const { data: publish } = useQuery({
    queryKey: ["publish", deployed.publishDigest],
    queryFn: async () => {
      const res = await client.core.getTransaction({
        digest: deployed.publishDigest,
        include: { effects: true, objectTypes: true },
      });
      const t = res.Transaction ?? res.FailedTransaction!;
      const created = t.effects.changedObjects
        .filter((o) => o.idOperation === "Created")
        .map((o) => t.objectTypes[o.objectId] ?? "package");
      return { created, hasUpgradeCap: created.some((ty) => ty.endsWith("::package::UpgradeCap")) };
    },
  });

  const { data: abi } = useQuery({
    queryKey: ["abi", deployed.packageId],
    queryFn: async () => {
      const { response } = await client.movePackageService.getPackage({ packageId: deployed.packageId });
      const mod = response.package?.modules.find((m) => m.name === "pool");
      return (mod?.functions ?? []).map((f) => ({
        name: f.name ?? "",
        visibility: f.visibility === 2 ? "public" : f.visibility === 1 ? "private" : "friend",
        isEntry: !!f.isEntry,
        params: (f.parameters as Sig[]).map(fmtSig),
      }));
    },
  });

  const onChainHash = pool ? toHex(pool.metadata_hash) : undefined;
  const mutators = (abi ?? []).filter((f) => f.visibility === "public" || f.isEntry).filter((f) => f.params.some((p) => p.startsWith("&mut pool::Pool")));
  const lastDraw = feed?.[0];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Check ok={publish ? !publish.hasUpgradeCap : undefined} title="Package is immutable">
        <p>
          Published and passed its UpgradeCap to <code>0x2::package::make_immutable</code> in the same transaction, so
          no one can ever add a function that changes an existing pool.
        </p>
        <p>
          Created in that tx: {publish?.created.map((t) => t.split("::").slice(-2).join("::")).join(", ")}
        </p>
        <a className="text-sky-400 underline" href={txUrl(deployed.publishDigest)} target="_blank" rel="noreferrer">
          publish tx
        </a>{" "}
        ·{" "}
        <a className="text-sky-400 underline" href={objUrl(deployed.packageId)} target="_blank" rel="noreferrer">
          package
        </a>
      </Check>

      <Check ok={onChainHash ? onChainHash === metaHash : undefined} title="Card list matches the on-chain commitment">
        <p>sha256 of /pool-metadata.json (names, images, grades, prices) computed in your browser:</p>
        <code className="block break-all text-xs">{metaHash}</code>
        <p>metadata_hash stored in the pool at creation:</p>
        <code className="block break-all text-xs">{onChainHash ?? "…"}</code>
      </Check>

      <Check ok={abi ? mutators.every((f) => f.name in WRITES) : undefined} title="Nothing can change the prizes">
        <p>Every public/entry function that takes &amp;mut Pool, read live from the chain:</p>
        <table className="mt-1 w-full text-xs">
          <tbody>
            {mutators.map((f) => (
              <tr key={f.name} className="border-t border-white/5">
                <td className="py-1 pr-2 font-mono text-foreground">
                  {f.name}
                  {f.isEntry && f.visibility !== "public" ? " (entry)" : ""}
                </td>
                <td className="py-1">{WRITES[f.name] ?? "UNEXPECTED"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="pt-1">There is no add / remove / reprice / reorder function.</p>
      </Check>

      <Check
        ok={abi ? !!abi.find((f) => f.name === "draw" && f.visibility === "private" && f.isEntry && f.params.some((p) => p === "&random::Random")) : undefined}
        title="Draws use Sui's randomness, not ours"
      >
        <p>
          <code>draw</code> is a private entry function taking <code>&amp;Random</code> (object 0x8, produced by
          validators via threshold cryptography). It picks uniformly from what is left; there is no seed or pre-shuffled
          order that we could know in advance. Being private entry, it cannot be wrapped by another contract to abort
          on a bad result.
        </p>
        <p className="font-mono text-xs">
          draw({abi?.find((f) => f.name === "draw")?.params.join(", ")})
        </p>
        {lastDraw && (
          <a className="text-sky-400 underline" href={txUrl(lastDraw.digest)} target="_blank" rel="noreferrer">
            latest draw tx
          </a>
        )}
      </Check>

      <Check ok={pool ? n(pool.collateral) * 10000 >= n(pool.remaining_value) * n(pool.collateral_bps) : undefined} title="Delivery is backed by collateral">
        <p>
          Locked: {usdc(pool?.collateral ?? 0)} USDC for {usdc(pool?.total_value ?? 0)} USDC of prizes (
          {pool ? pct(n(pool.collateral_bps) / 10000, 0) : "…"} per prize). Open shipping requests:{" "}
          {pool ? n(pool.outstanding) : "…"}.
        </p>
        <p>
          The operator can only unlock it after the pool closes, a full redemption window passes, and nothing is left
          unshipped.
        </p>
      </Check>

      <Check ok={true} title="What is still trusted">
        <p>
          That the physical cards exist and are the ones listed (PSA cert numbers are public; the demo uses placeholder
          certs), and that a "shipped" mark matches a real parcel. Market prices are SNKRDUNK snapshots ({meta.prices_from}).
        </p>
      </Check>
    </div>
  );
}
