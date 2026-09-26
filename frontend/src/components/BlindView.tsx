import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import { coinWithBalance } from "@mysten/sui/transactions";
import { toHex } from "@mysten/sui/utils";
import { useMemo, useState } from "react";
import type { Deployed } from "../config";
import { BlindDrawnEvent, NONE, type BlindPoolT } from "../lib/bcs";
import { openSlots, type Opened } from "../lib/blind";
import { useBlindFeed, useBlindPool, useBlindRedemptions, useMyBlindPulls, useSeal } from "../lib/blindChain";
import { useExec, useOwnsObject } from "../lib/chain";
import { countdown, n, short, txUrl, unitsToYen, yen, type CardMeta, type Metadata, amt } from "../lib/format";
import { CardTile, TierBadge } from "./CardTile";
import { useNow } from "./MyPulls";
import { Stat } from "./PoolView";
import { RevealModal, type Reveal } from "./RevealModal";

type Props = { deployed: Deployed; meta: Metadata; byCard: Map<number, CardMeta> };

const cardOf = (pool: BlindPoolT, byCard: Map<number, CardMeta>, prize: number) =>
  byCard.get(n(pool.lineup[prize]?.card_id));

export function BlindView({ deployed, meta, byCard }: Props) {
  const b = deployed.blind!;
  const pkg = b.packageId;
  const pools = b.pools ?? { main: { poolId: b.poolId!, capId: b.capId!, createDigest: b.createDigest!, sealDigest: b.sealDigest! } };
  const [key, setKey] = useState(Object.keys(pools).includes("main") ? "main" : Object.keys(pools)[0]);
  const entry = pools[key] ?? Object.values(pools)[0];
  const poolId = entry.poolId;
  const coinType = deployed.coinType;
  const client = useCurrentClient();
  const account = useCurrentAccount();
  const now = useNow();
  const { data: pool } = useBlindPool(poolId);
  const { data: pulls } = useMyBlindPulls(pkg, poolId);
  const { data: feed } = useBlindFeed(pkg, poolId);
  const { data: myRedemptions } = useBlindRedemptions(pkg, poolId, account?.address);
  const { data: allRedemptions } = useBlindRedemptions(pkg, poolId);
  const { data: isOperator } = useOwnsObject(entry.capId);
  const { seal, sessionKey } = useSeal(pkg, b.seal);
  const { exec, busy, error } = useExec();
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [peeked, setPeeked] = useState<Record<number, Opened>>({});
  const [publicOpen, setPublicOpen] = useState<Opened[] | null>(null);
  const [sealError, setSealError] = useState<string | null>(null);
  const [sealBusy, setSealBusy] = useState<string | null>(null);
  const [tracking, setTracking] = useState<Record<string, string>>({});

  const switchPool = (k: string) => {
    setKey(k);
    setPeeked({});
    setPublicOpen(null);
    setSealError(null);
  };

  const isPublic = !!pool && pool.sealed && (pool.closed || pool.remaining.length <= n(pool.reveal_tail));
  const lineup = useMemo(
    () =>
      pool
        ? pool.lineup
            .map((c, prize) => ({ prize, card: byCard.get(n(c.card_id))! }))
            .filter((x) => x.card)
            .sort((a, z) => a.card.tier - z.card.tier || z.card.value_jpy - a.card.value_jpy)
        : [],
    [pool, byCard],
  );

  async function open(label: string, slots: { slot: number; pullId?: string }[], mode: "holder" | "public") {
    if (!pool || !seal) return [];
    setSealBusy(label);
    setSealError(null);
    try {
      const key = await sessionKey();
      return await openSlots({
        seal,
        client,
        sessionKey: key,
        cfg: b.seal!,
        pkg,
        coinType,
        poolId,
        commitments: pool.commitments,
        mode,
        slots: slots.map((s) => ({ ...s, ciphertext: Uint8Array.from(pool.ciphertexts[s.slot]) })),
      });
    } catch (e) {
      setSealError(e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e));
      return [];
    } finally {
      setSealBusy(null);
    }
  }

  async function draw() {
    if (!pool) return;
    setReveal({ phase: "pending", label: "Drawing a hidden slot with Sui randomness…" });
    const res = await exec("draw", (tx) =>
      tx.moveCall({
        target: `${pkg}::blind::draw`,
        typeArguments: [coinType],
        arguments: [
          tx.object(poolId),
          coinWithBalance({ type: coinType, balance: BigInt(pool.price) }),
          tx.object.random(),
          tx.object.clock(),
        ],
      }),
    );
    const ev = res?.events.find((e) => e.eventType.endsWith("::blind::BlindDrawn"));
    if (!res || !ev) return setReveal(null);
    const d = BlindDrawnEvent.parse(ev.bcs);
    setReveal({ phase: "pending", label: `You drew slot #${d.slot_id}. Sign once to decrypt it with Seal (only you can).` });
    const [o] = await open("peek", [{ slot: n(d.slot_id), pullId: d.pull_id }], "holder");
    const card = o && cardOf(pool, byCard, o.prize);
    if (!o || !card) return setReveal(null);
    setPeeked((p) => ({ ...p, [o.slot]: o }));
    setReveal({
      phase: "done",
      card,
      digest: res.digest,
      valueUnits: pool.lineup[o.prize].value,
      remaining: n(d.remaining),
      note: `Decrypted with Seal · commitment ${o.commitmentOk ? "verified ✓" : "MISMATCH ✗"} · hidden from everyone else until the pool goes public`,
    });
  }

  if (!pool) return <div className="text-muted-foreground">Loading blind pool…</div>;
  const left = pool.remaining.length;
  const total = pool.lineup.length;
  const errors = [error, sealError].filter(Boolean);

  // Public verification: every slot opens, matches its commitment, and the
  // lineup is used exactly once.
  const lineupOk =
    publicOpen && publicOpen.length === total && new Set(publicOpen.map((o) => o.prize)).size === total;
  const allCommitsOk = publicOpen?.every((o) => o.commitmentOk);
  const unrevealedOpened = (publicOpen ?? []).filter((o) => pool.revealed[o.slot] === NONE && (pool.drawn[o.slot] || isPublic));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-3xl">
          {Object.keys(pools).length > 1 && (
            <div className="mb-2 flex gap-1">
              {Object.keys(pools).map((k) => (
                <button
                  key={k}
                  onClick={() => switchPool(k)}
                  className={`rounded-md px-2.5 py-1 text-xs ${k === key ? "bg-violet-500/30 font-semibold text-violet-200" : "text-muted-foreground hover:bg-white/5"}`}
                >
                  {k === "mini" ? "6-slot pool (already public — try the verification)" : k === "main" ? "100-slot pool" : k}
                </button>
              ))}
            </div>
          )}
          <h2 className="text-2xl font-bold">{pool.name}</h2>
          <p className="text-sm text-muted-foreground">
            Japanese format: you only see how many draws are left. Which slot holds which card is committed on-chain and
            sealed with <span className="text-foreground">Seal</span>. Each draw picks a random remaining slot with Sui
            randomness, so no one — not even the operator — knows which draw wins. Only you can decrypt your slot. When
            the pool closes or only {n(pool.reveal_tail)} draws are left, everyone can decrypt every slot and verify it.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={draw}
            disabled={!account || left === 0 || pool.closed || !!busy || !!sealBusy}
            className="rounded-xl bg-gradient-to-r from-rose-400 to-violet-500 px-8 py-3 text-lg font-black text-black shadow-lg disabled:opacity-40"
          >
            {left === 0 || pool.closed ? "CLOSED" : busy || sealBusy ? "Working…" : "BLIND DRAW ×1"}
          </button>
          <div className="text-xs text-muted-foreground">
            {amt(pool.price)} (= {yen(unitsToYen(pool.price, meta))}) per draw
          </div>
        </div>
      </div>

      {!window.isSecureContext && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          Seal decryption needs a secure context (https or localhost); this page is plain http, so the browser hides
          the AES-GCM API it uses. Open the https address instead, e.g.{" "}
          <a className="underline" href={`https://mac-mini.tail65cb28.ts.net:8793${location.pathname}`}>
            https://mac-mini.tail65cb28.ts.net:8793
          </a>
          .
        </div>
      )}

      {errors.map((e) => (
        <div key={e} className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs break-all text-red-300">
          {e}
        </div>
      ))}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Draws left" value={`${left} / ${total}`} sub={`${total - left} drawn — contents hidden`} />
        <Stat
          label="Visibility"
          value={isPublic ? "PUBLIC" : "SEALED"}
          sub={isPublic ? "anyone can decrypt every slot" : `opens to all at ≤ ${n(pool.reveal_tail)} left or close`}
          className={isPublic ? "border-emerald-500/50" : "border-violet-500/50"}
        />
        <Stat
          label="Revealed on-chain"
          value={`${n(pool.revealed_count)} / ${total}`}
          sub={
            pool.closed
              ? `a drawn slot still hidden in ${countdown(n(pool.closed_at_ms) + n(pool.window_ms) - now)} pays the top prize`
              : `slots with a published result · ${total - left} drawn`
          }
        />
        <Stat
          label="Collateral locked"
          value={amt(pool.collateral, 2)}
          sub={`top prize ${yen(unitsToYen(pool.max_value, meta))} if a result is hidden`}
        />
      </div>

      <section>
        <h3 className="mb-2 font-semibold">Your hidden pulls ({pulls?.length ?? 0})</h3>
        {(pulls ?? []).length === 0 && <div className="text-sm text-muted-foreground">None yet.</div>}
        <div className="flex flex-wrap gap-3">
          {(pulls ?? []).map((p) => {
            const slot = n(p.slot_id);
            const revealedPrize = pool.revealed[slot];
            const o = peeked[slot];
            const card = revealedPrize !== NONE ? cardOf(pool, byCard, n(revealedPrize)) : o && cardOf(pool, byCard, o.prize);
            return (
              <div key={p.objectId} className="w-44 space-y-2">
                {card ? (
                  <CardTile card={card} label={revealedPrize !== NONE ? "REVEALED" : "ONLY YOU SEE THIS"} />
                ) : (
                  <div className="flex aspect-[63/88] flex-col items-center justify-center rounded-xl bg-gradient-to-br from-violet-700 to-rose-500 text-white">
                    <div className="text-4xl font-black">?</div>
                    <div className="text-xs">slot #{slot}</div>
                  </div>
                )}
                {revealedPrize === NONE && !o && (
                  <button
                    disabled={!!sealBusy}
                    onClick={async () => {
                      const [r] = await open("peek", [{ slot, pullId: p.objectId }], "holder");
                      if (r) setPeeked((x) => ({ ...x, [slot]: r }));
                    }}
                    className="w-full rounded-lg border px-2 py-1.5 text-xs font-semibold hover:bg-white/10"
                  >
                    Decrypt with Seal
                  </button>
                )}
                {revealedPrize === NONE && o && (
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      exec("reveal", (tx) =>
                        tx.moveCall({
                          target: `${pkg}::blind::reveal`,
                          typeArguments: [coinType],
                          arguments: [
                            tx.object(poolId),
                            tx.pure.u64(slot),
                            tx.pure.u64(o.prize),
                            tx.pure.vector("u8", Array.from(o.salt)),
                          ],
                        }),
                      )
                    }
                    className="w-full rounded-lg border px-2 py-1.5 text-xs font-semibold hover:bg-white/10"
                    title="Publishes your result on-chain (needed to redeem)."
                  >
                    Reveal on-chain {o.commitmentOk ? "✓" : "✗"}
                  </button>
                )}
                {revealedPrize !== NONE && (
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      exec("redeem", (tx) =>
                        tx.moveCall({
                          target: `${pkg}::blind::request_redeem`,
                          typeArguments: [coinType],
                          arguments: [tx.object(poolId), tx.object(p.objectId), tx.object.clock()],
                        }),
                      )
                    }
                    className="w-full rounded-lg border px-2 py-1.5 text-xs font-semibold hover:bg-white/10"
                  >
                    Request shipping
                  </button>
                )}
                {revealedPrize === NONE && pool.closed && now > n(pool.closed_at_ms) + n(pool.window_ms) + 5000 && (
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      exec("claim unrevealed", (tx) =>
                        tx.moveCall({
                          target: `${pkg}::blind::claim_unrevealed`,
                          typeArguments: [coinType],
                          arguments: [tx.object(poolId), tx.object(p.objectId), tx.object.clock()],
                        }),
                      )
                    }
                    className="w-full rounded-lg bg-emerald-400 px-2 py-1.5 text-xs font-bold text-black"
                  >
                    Never revealed → claim top prize
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {(myRedemptions ?? []).length > 0 && (
        <section className="space-y-2">
          <h3 className="font-semibold">Your shipping requests</h3>
          {(myRedemptions ?? []).map((r) => {
            const c = byCard.get(n(r.card.card_id));
            const leftMs = n(r.deadline_ms) - now;
            return (
              <div key={r.objectId} className="flex items-center gap-3 rounded-xl border bg-white/[0.03] p-3 text-sm">
                {c && <img src={c.image} alt="" className="aspect-[63/88] h-14 rounded object-cover" />}
                <div className="flex-1">
                  <div className="font-medium">{c?.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.shipped ? `Shipped · ${r.tracking}` : leftMs > 0 ? `${countdown(leftMs)} left to ship` : "Not shipped in time"}
                  </div>
                </div>
                {!r.shipped && leftMs <= -5000 && (
                  <button
                    onClick={() =>
                      exec("claim", (tx) =>
                        tx.moveCall({
                          target: `${pkg}::blind::claim_collateral`,
                          typeArguments: [coinType],
                          arguments: [tx.object(poolId), tx.object(r.objectId), tx.object.clock()],
                        }),
                      )
                    }
                    className="rounded-lg bg-emerald-400 px-3 py-1.5 text-xs font-bold text-black"
                  >
                    Claim {amt((n(r.card.value) * n(pool.collateral_bps)) / 10000)}
                  </button>
                )}
              </div>
            );
          })}
        </section>
      )}

      {isOperator && (allRedemptions ?? []).some((r) => !r.shipped) && (
        <section className="space-y-2">
          <h3 className="font-semibold">Operator: ship</h3>
          {(allRedemptions ?? [])
            .filter((r) => !r.shipped && n(r.deadline_ms) > now)
            .map((r) => (
              <div key={r.objectId} className="flex items-center gap-2 text-sm">
                <span className="flex-1">
                  {byCard.get(n(r.card.card_id))?.name} → {short(r.owner)} ({countdown(n(r.deadline_ms) - now)})
                </span>
                <input
                  placeholder="Tracking no."
                  value={tracking[r.objectId] ?? ""}
                  onChange={(e) => setTracking({ ...tracking, [r.objectId]: e.target.value })}
                  className="w-36 rounded-lg border bg-transparent px-2 py-1 text-xs"
                />
                <button
                  disabled={!tracking[r.objectId]}
                  onClick={() =>
                    exec("ship", (tx) =>
                      tx.moveCall({
                        target: `${pkg}::blind::mark_shipped`,
                        typeArguments: [coinType],
                        arguments: [
                          tx.object(entry.capId),
                          tx.object(poolId),
                          tx.object(r.objectId),
                          tx.pure.string(tracking[r.objectId]),
                          tx.object.clock(),
                        ],
                      }),
                    )
                  }
                  className="rounded-lg bg-white px-3 py-1 text-xs font-bold text-black disabled:opacity-40"
                >
                  Mark shipped
                </button>
              </div>
            ))}
        </section>
      )}

      <section className="rounded-xl border bg-white/[0.03] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Public verification</h3>
          <div className="flex gap-2">
            <button
              disabled={!isPublic || !!sealBusy || !account}
              onClick={async () =>
                setPublicOpen(await open("verify", pool.lineup.map((_, slot) => ({ slot })), "public"))
              }
              className="rounded-lg border px-3 py-1.5 text-xs font-semibold hover:bg-white/10 disabled:opacity-40"
              title={isPublic ? "" : "Locked while sealed — Seal key servers refuse until the pool is public"}
            >
              {sealBusy === "verify" ? "Decrypting…" : `Decrypt all ${total} slots with Seal`}
            </button>
            <button
              disabled={!publicOpen || unrevealedOpened.length === 0 || !!busy}
              onClick={() =>
                exec("reveal all", (tx) => {
                  for (const o of unrevealedOpened) {
                    tx.moveCall({
                      target: `${pkg}::blind::reveal`,
                      typeArguments: [coinType],
                      arguments: [tx.object(poolId), tx.pure.u64(o.slot), tx.pure.u64(o.prize), tx.pure.vector("u8", Array.from(o.salt))],
                    });
                  }
                })
              }
              className="rounded-lg border px-3 py-1.5 text-xs font-semibold hover:bg-white/10 disabled:opacity-40"
            >
              Reveal {unrevealedOpened.length} on-chain
            </button>
          </div>
        </div>
        {!isPublic && (
          <p className="mt-2 text-sm text-muted-foreground">
            Sealed. Trying now fails: the Seal key servers only release keys when <code>seal_approve_public</code> passes
            on-chain (pool closed or ≤ {n(pool.reveal_tail)} left).
          </p>
        )}
        {publicOpen && (
          <div className="mt-3 space-y-2 text-sm">
            <div className={allCommitsOk && lineupOk ? "text-emerald-400" : "text-red-400"}>
              {allCommitsOk ? "✓" : "✗"} every slot matches its on-chain commitment · {lineupOk ? "✓" : "✗"} the announced
              lineup appears exactly once
            </div>
            <div className="grid grid-cols-2 gap-1 text-xs sm:grid-cols-4">
              {publicOpen.map((o) => {
                const c = cardOf(pool, byCard, o.prize);
                return (
                  <div key={o.slot} className="flex items-center gap-1.5 rounded border px-2 py-1">
                    <span className="text-muted-foreground">#{o.slot}</span>
                    {c && <TierBadge tier={c.tier} />}
                    <span className="truncate">{c?.name}</span>
                    <span className="ml-auto">{pool.drawn[o.slot] ? "drawn" : "unsold"}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 font-semibold">Announced lineup ({total} cards — positions hidden)</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-10">
          {lineup.map(({ prize, card }) => {
            // Positions only become visible once a slot is revealed on-chain.
            const slot = pool.revealed.findIndex((p) => p !== NONE && n(p) === prize);
            const drawn = slot >= 0 && pool.drawn[slot];
            return (
              <CardTile
                key={prize}
                card={card}
                drawn={drawn}
                label={slot < 0 ? undefined : drawn ? `SLOT #${slot} · DRAWN` : `SLOT #${slot} · STILL IN`}
              />
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Commitments: {pool.commitments.length} · ciphertexts {pool.ciphertexts[0]?.length ?? 0} bytes each · e.g. slot
          #0 = sha256 {toHex(Uint8Array.from(pool.commitments[0] ?? [])).slice(0, 16)}… ·{" "}
          <a className="text-sky-400 underline" href={txUrl(entry.sealDigest)} target="_blank" rel="noreferrer">
            seal tx
          </a>{" "}
          · recent draws: {(feed ?? []).slice(0, 8).map((d) => `#${d.slot_id}`).join(" ")}
        </p>
      </section>

      <RevealModal reveal={reveal} meta={meta} onClose={() => setReveal(null)} />
    </div>
  );
}
