/// Blind Oripa: the Japanese format, where buyers only see how many draws are
/// left, made trustless.
///
/// - The prize lineup is public; which slot holds which prize is hidden.
///   Each slot is committed on-chain (sha256 of slot_id, prize_id, salt) and
///   its (prize_id, salt) is Seal-encrypted to identity pool_id || slot_id.
/// - Each draw picks a random remaining slot with Sui randomness. There is no
///   order, so nobody (not even the operator) knows which draw number wins.
/// - Only the holder of a slot's Pull can decrypt it while sales run
///   (`seal_approve_holder`). Once the pool closes, or only `reveal_tail`
///   draws are left, anyone can decrypt every slot (`seal_approve_public`),
///   which removes the operator's end-game information edge.
/// - After close every drawn slot must be revealed on-chain (commitment
///   checked, each lineup prize usable once). A slot left unrevealed past the
///   window pays its holder the lineup's top prize value from collateral.
#[allow(lint(self_transfer))]
module oripa::blind;

use std::bcs;
use std::hash;
use std::string::String;
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::random::{Random, RandomGenerator, new_generator};

// === Errors ===

const EWrongPayment: u64 = 0;
const ESoldOut: u64 = 1;
const ELengthMismatch: u64 = 2;
const EEmptyPool: u64 = 3;
const EInsufficientCollateral: u64 = 4;
const EWrongPool: u64 = 5;
const ENotOwner: u64 = 6;
const EAlreadyShipped: u64 = 7;
const ENotExpired: u64 = 8;
const EOutstanding: u64 = 9;
const ENotClosed: u64 = 10;
const EBadBps: u64 = 11;
const ENotSealed: u64 = 12;
const EAlreadySealed: u64 = 13;
const ESaleClosed: u64 = 14;
const ESaleOpen: u64 = 15;
const ENoAccess: u64 = 16;
const EBadCommitment: u64 = 17;
const EPrizeUsed: u64 = 18;
const EAlreadyRevealed: u64 = 19;
const ENotRevealed: u64 = 20;
const ERevealLocked: u64 = 21;
const EExpired: u64 = 22;
const EWindowOpen: u64 = 23;
const EUnrevealed: u64 = 24;

const BPS: u64 = 10_000;
const NONE: u64 = 0xFFFF_FFFF_FFFF_FFFF;

// === Types ===

/// One entry of the public lineup; prize_id is its index.
public struct Card has store, copy, drop {
    card_id: u64,
    cert: u64,
    value: u64,
    tier: u8,
}

public struct BlindPool<phantom T> has key {
    id: UID,
    name: String,
    operator: address,
    price: u64,
    lineup: vector<Card>,
    total_value: u64,
    max_value: u64,
    metadata_hash: vector<u8>,
    /// slot_id -> sha256(bcs(slot_id) || bcs(prize_id) || salt)
    commitments: vector<vector<u8>>,
    /// slot_id -> Seal ciphertext of bcs(prize_id) || salt, id = pool_id || bcs(slot_id)
    ciphertexts: vector<vector<u8>>,
    sealed: bool,
    remaining: vector<u64>,
    drawn: vector<bool>,
    /// slot_id -> prize_id, NONE until revealed.
    revealed: vector<u64>,
    /// prize_id -> already matched to a slot.
    prize_used: vector<bool>,
    revealed_count: u64,
    /// When this many draws or fewer are left, everything becomes public.
    reveal_tail: u64,
    sale_end_ms: u64,
    closed: bool,
    closed_at_ms: u64,
    sales: Balance<T>,
    collateral: Balance<T>,
    collateral_bps: u64,
    /// Used both as the shipping window and the post-close reveal window.
    window_ms: u64,
    outstanding: u64,
}

public struct BlindCap has key, store {
    id: UID,
    pool_id: ID,
}

/// A drawn, still hidden slot. Decrypt it with Seal; reveal it to redeem.
public struct BlindPull has key, store {
    id: UID,
    pool_id: ID,
    slot_id: u64,
    drawn_at_ms: u64,
}

public struct BlindRedemption has key {
    id: UID,
    pool_id: ID,
    owner: address,
    slot_id: u64,
    card: Card,
    deadline_ms: u64,
    shipped: bool,
    tracking: String,
}

// === Events ===

public struct BlindPoolCreated has copy, drop { pool_id: ID, operator: address, slots: u64, total_value: u64 }
public struct BlindSealed has copy, drop { pool_id: ID, slots: u64 }
public struct BlindDrawn has copy, drop {
    pool_id: ID,
    pull_id: ID,
    drawer: address,
    slot_id: u64,
    remaining: u64,
}
public struct BlindClosed has copy, drop { pool_id: ID, unsold: u64 }
public struct SlotRevealed has copy, drop { pool_id: ID, slot_id: u64, prize_id: u64, card: Card }
public struct BlindRedeemRequested has copy, drop {
    pool_id: ID,
    redemption_id: ID,
    owner: address,
    slot_id: u64,
    deadline_ms: u64,
}
public struct BlindShipped has copy, drop { pool_id: ID, redemption_id: ID, tracking: String }
public struct BlindCollateralClaimed has copy, drop {
    pool_id: ID,
    owner: address,
    slot_id: u64,
    amount: u64,
    unrevealed: bool,
}

// === Creation (two steps: the Seal ids need the pool id) ===

public fun create_blind_pool<T>(
    name: String,
    price: u64,
    card_ids: vector<u64>,
    certs: vector<u64>,
    values: vector<u64>,
    tiers: vector<u8>,
    metadata_hash: vector<u8>,
    reveal_tail: u64,
    sale_end_ms: u64,
    collateral: Coin<T>,
    collateral_bps: u64,
    window_ms: u64,
    ctx: &mut TxContext,
) {
    let n = card_ids.length();
    assert!(n > 0, EEmptyPool);
    assert!(certs.length() == n && values.length() == n && tiers.length() == n, ELengthMismatch);
    assert!(collateral_bps <= BPS, EBadBps);

    let mut lineup = vector[];
    let mut total_value = 0;
    let mut max_value = 0;
    let mut i = 0;
    while (i < n) {
        let value = values[i];
        lineup.push_back(Card { card_id: card_ids[i], cert: certs[i], value, tier: tiers[i] });
        total_value = total_value + value;
        if (value > max_value) max_value = value;
        i = i + 1;
    };
    let required = ((total_value as u128) * (collateral_bps as u128) / (BPS as u128)) as u64;
    assert!(collateral.value() >= required, EInsufficientCollateral);

    let pool = BlindPool<T> {
        id: object::new(ctx),
        name,
        operator: ctx.sender(),
        price,
        lineup,
        total_value,
        max_value,
        metadata_hash,
        commitments: vector[],
        ciphertexts: vector[],
        sealed: false,
        remaining: vector[],
        drawn: vector[],
        revealed: vector[],
        prize_used: vector[],
        revealed_count: 0,
        reveal_tail,
        sale_end_ms,
        closed: false,
        closed_at_ms: 0,
        sales: balance::zero(),
        collateral: collateral.into_balance(),
        collateral_bps,
        window_ms,
        outstanding: 0,
    };
    let pool_id = object::id(&pool);
    event::emit(BlindPoolCreated { pool_id, operator: ctx.sender(), slots: n, total_value });
    transfer::public_transfer(BlindCap { id: object::new(ctx), pool_id }, ctx.sender());
    transfer::share_object(pool);
}

/// Append hidden slots (may be called several times to stay under tx limits).
public fun add_slots<T>(
    cap: &BlindCap,
    pool: &mut BlindPool<T>,
    commitments: vector<vector<u8>>,
    ciphertexts: vector<vector<u8>>,
) {
    assert!(cap.pool_id == object::id(pool), EWrongPool);
    assert!(!pool.sealed, EAlreadySealed);
    assert!(commitments.length() == ciphertexts.length(), ELengthMismatch);
    pool.commitments.append(commitments);
    pool.ciphertexts.append(ciphertexts);
}

/// Lock the slots and open sales. After this nothing about the pool can change.
public fun seal_slots<T>(cap: &BlindCap, pool: &mut BlindPool<T>) {
    assert!(cap.pool_id == object::id(pool), EWrongPool);
    assert!(!pool.sealed, EAlreadySealed);
    let n = pool.lineup.length();
    assert!(pool.commitments.length() == n, ELengthMismatch);
    let mut i = 0;
    while (i < n) {
        pool.remaining.push_back(i);
        pool.drawn.push_back(false);
        pool.revealed.push_back(NONE);
        pool.prize_used.push_back(false);
        i = i + 1;
    };
    pool.sealed = true;
    event::emit(BlindSealed { pool_id: object::id(pool), slots: n });
}

// === Drawing ===

/// Pay `price`, receive a random remaining slot. Only the slot id is public.
entry fun draw<T>(
    pool: &mut BlindPool<T>,
    payment: Coin<T>,
    r: &Random,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let mut g = new_generator(r, ctx);
    draw_with(pool, payment, &mut g, clock, ctx);
}

fun draw_with<T>(
    pool: &mut BlindPool<T>,
    payment: Coin<T>,
    g: &mut RandomGenerator,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(pool.sealed, ENotSealed);
    assert!(!pool.closed, ESaleClosed);
    let now = clock.timestamp_ms();
    assert!(pool.sale_end_ms == 0 || now < pool.sale_end_ms, ESaleClosed);
    let n = pool.remaining.length();
    assert!(n > 0, ESoldOut);
    assert!(payment.value() == pool.price, EWrongPayment);
    pool.sales.join(payment.into_balance());

    let i = g.generate_u64_in_range(0, n - 1);
    let slot_id = pool.remaining.swap_remove(i);
    *&mut pool.drawn[slot_id] = true;
    if (n == 1) close(pool, now);

    let pull = BlindPull { id: object::new(ctx), pool_id: object::id(pool), slot_id, drawn_at_ms: now };
    event::emit(BlindDrawn {
        pool_id: object::id(pool),
        pull_id: object::id(&pull),
        drawer: ctx.sender(),
        slot_id,
        remaining: n - 1,
    });
    transfer::public_transfer(pull, ctx.sender());
}

/// Anyone can close a pool whose sale deadline passed; unsold slots stay with the operator.
public fun close_after_sale<T>(pool: &mut BlindPool<T>, clock: &Clock) {
    assert!(pool.sealed && !pool.closed, ESaleClosed);
    let now = clock.timestamp_ms();
    assert!(pool.sale_end_ms != 0 && now >= pool.sale_end_ms, ESaleOpen);
    close(pool, now);
}

fun close<T>(pool: &mut BlindPool<T>, now: u64) {
    pool.closed = true;
    pool.closed_at_ms = now;
    event::emit(BlindClosed { pool_id: object::id(pool), unsold: pool.remaining.length() });
}

// === Seal access policies (evaluated by key servers, no side effects) ===

public fun seal_id(pool_id: ID, slot_id: u64): vector<u8> {
    let mut id = pool_id.to_bytes();
    id.append(bcs::to_bytes(&slot_id));
    id
}

/// The holder of a slot's Pull may decrypt that slot at any time.
entry fun seal_approve_holder(id: vector<u8>, pull: &BlindPull) {
    assert!(id == seal_id(pull.pool_id, pull.slot_id), ENoAccess);
}

/// Anyone may decrypt any slot once the pool is closed or in its public tail.
entry fun seal_approve_public<T>(id: vector<u8>, pool: &BlindPool<T>) {
    assert!(is_public(pool), ENoAccess);
    assert!(id.length() == 40, ENoAccess);
    let prefix = object::id(pool).to_bytes();
    let mut i = 0;
    while (i < 32) {
        assert!(id[i] == prefix[i], ENoAccess);
        i = i + 1;
    };
}

public fun is_public<T>(pool: &BlindPool<T>): bool {
    pool.sealed && (pool.closed || pool.remaining.length() <= pool.reveal_tail)
}

// === Reveal: open a commitment on-chain ===

public fun commitment(slot_id: u64, prize_id: u64, salt: &vector<u8>): vector<u8> {
    let mut b = bcs::to_bytes(&slot_id);
    b.append(bcs::to_bytes(&prize_id));
    b.append(*salt);
    hash::sha2_256(b)
}

/// Anyone who knows a slot's (prize_id, salt) may reveal it, but only once it
/// is drawn or the pool is public, so undrawn slots stay hidden during sales.
public fun reveal<T>(pool: &mut BlindPool<T>, slot_id: u64, prize_id: u64, salt: vector<u8>) {
    assert!(pool.sealed, ENotSealed);
    assert!(pool.drawn[slot_id] || is_public(pool), ERevealLocked);
    assert!(pool.revealed[slot_id] == NONE, EAlreadyRevealed);
    assert!(commitment(slot_id, prize_id, &salt) == pool.commitments[slot_id], EBadCommitment);
    assert!(!pool.prize_used[prize_id], EPrizeUsed);
    *&mut pool.prize_used[prize_id] = true;
    *&mut pool.revealed[slot_id] = prize_id;
    pool.revealed_count = pool.revealed_count + 1;
    event::emit(SlotRevealed { pool_id: object::id(pool), slot_id, prize_id, card: pool.lineup[prize_id] });
}

// === Redemption ===

/// Burn a revealed Pull and ask for the card.
public fun request_redeem<T>(pool: &mut BlindPool<T>, pull: BlindPull, clock: &Clock, ctx: &mut TxContext) {
    let BlindPull { id, pool_id, slot_id, drawn_at_ms: _ } = pull;
    assert!(pool_id == object::id(pool), EWrongPool);
    let prize_id = pool.revealed[slot_id];
    assert!(prize_id != NONE, ENotRevealed);
    id.delete();

    let deadline_ms = clock.timestamp_ms() + pool.window_ms;
    let r = BlindRedemption {
        id: object::new(ctx),
        pool_id,
        owner: ctx.sender(),
        slot_id,
        card: pool.lineup[prize_id],
        deadline_ms,
        shipped: false,
        tracking: b"".to_string(),
    };
    pool.outstanding = pool.outstanding + 1;
    event::emit(BlindRedeemRequested {
        pool_id,
        redemption_id: object::id(&r),
        owner: ctx.sender(),
        slot_id,
        deadline_ms,
    });
    transfer::share_object(r);
}

public fun mark_shipped<T>(
    cap: &BlindCap,
    pool: &mut BlindPool<T>,
    r: &mut BlindRedemption,
    tracking: String,
    clock: &Clock,
) {
    assert!(cap.pool_id == object::id(pool) && r.pool_id == object::id(pool), EWrongPool);
    assert!(!r.shipped, EAlreadyShipped);
    assert!(clock.timestamp_ms() <= r.deadline_ms, EExpired);
    r.shipped = true;
    r.tracking = tracking;
    pool.outstanding = pool.outstanding - 1;
    event::emit(BlindShipped { pool_id: r.pool_id, redemption_id: object::id(r), tracking });
}

public fun confirm_received(r: BlindRedemption, ctx: &TxContext) {
    assert!(r.owner == ctx.sender(), ENotOwner);
    assert!(r.shipped, EAlreadyShipped);
    let BlindRedemption { id, .. } = r;
    id.delete();
}

/// Not shipped in time: paid `value * bps` from collateral.
public fun claim_collateral<T>(
    pool: &mut BlindPool<T>,
    r: BlindRedemption,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(r.pool_id == object::id(pool), EWrongPool);
    assert!(r.owner == ctx.sender(), ENotOwner);
    assert!(!r.shipped, EAlreadyShipped);
    assert!(clock.timestamp_ms() > r.deadline_ms, ENotExpired);
    let BlindRedemption { id, owner, slot_id, card, .. } = r;
    id.delete();
    pool.outstanding = pool.outstanding - 1;
    pay_from_collateral(pool, owner, slot_id, card.value, false, ctx);
}

/// The operator must reveal every drawn slot within `window_ms` of closing.
/// A holder whose slot is still hidden after that is paid as if it were the
/// top prize: hiding a result is never cheaper than honouring it.
public fun claim_unrevealed<T>(pool: &mut BlindPool<T>, pull: BlindPull, clock: &Clock, ctx: &mut TxContext) {
    let BlindPull { id, pool_id, slot_id, drawn_at_ms: _ } = pull;
    assert!(pool_id == object::id(pool), EWrongPool);
    assert!(pool.closed, ENotClosed);
    assert!(clock.timestamp_ms() > pool.closed_at_ms + pool.window_ms, EWindowOpen);
    assert!(pool.revealed[slot_id] == NONE, EAlreadyRevealed);
    id.delete();
    let value = pool.max_value;
    pay_from_collateral(pool, ctx.sender(), slot_id, value, true, ctx);
}

fun pay_from_collateral<T>(
    pool: &mut BlindPool<T>,
    owner: address,
    slot_id: u64,
    value: u64,
    unrevealed: bool,
    ctx: &mut TxContext,
) {
    let due = ((value as u128) * (pool.collateral_bps as u128) / (BPS as u128)) as u64;
    let amount = if (due > pool.collateral.value()) pool.collateral.value() else due;
    let payout = coin::from_balance(pool.collateral.split(amount), ctx);
    event::emit(BlindCollateralClaimed { pool_id: object::id(pool), owner, slot_id, amount, unrevealed });
    transfer::public_transfer(payout, owner);
}

// === Operator funds ===

public fun withdraw_sales<T>(cap: &BlindCap, pool: &mut BlindPool<T>, ctx: &mut TxContext): Coin<T> {
    assert!(cap.pool_id == object::id(pool), EWrongPool);
    let amount = pool.sales.value();
    coin::from_balance(pool.sales.split(amount), ctx)
}

/// Unlocks after close + two windows, with every drawn slot revealed and
/// nothing left unshipped.
public fun withdraw_collateral<T>(
    cap: &BlindCap,
    pool: &mut BlindPool<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(cap.pool_id == object::id(pool), EWrongPool);
    assert!(pool.closed, ENotClosed);
    assert!(clock.timestamp_ms() >= pool.closed_at_ms + 2 * pool.window_ms, EWindowOpen);
    assert!(pool.outstanding == 0, EOutstanding);
    let mut i = 0;
    let n = pool.drawn.length();
    while (i < n) {
        assert!(!pool.drawn[i] || pool.revealed[i] != NONE, EUnrevealed);
        i = i + 1;
    };
    let amount = pool.collateral.value();
    coin::from_balance(pool.collateral.split(amount), ctx)
}

// === Views ===

public fun remaining_count<T>(pool: &BlindPool<T>): u64 { pool.remaining.length() }
public fun total_count<T>(pool: &BlindPool<T>): u64 { pool.lineup.length() }
public fun revealed_prize<T>(pool: &BlindPool<T>, slot_id: u64): u64 { pool.revealed[slot_id] }
public fun revealed_count<T>(pool: &BlindPool<T>): u64 { pool.revealed_count }
public fun is_closed<T>(pool: &BlindPool<T>): bool { pool.closed }
public fun is_sealed<T>(pool: &BlindPool<T>): bool { pool.sealed }
public fun sales_value<T>(pool: &BlindPool<T>): u64 { pool.sales.value() }
public fun collateral_value<T>(pool: &BlindPool<T>): u64 { pool.collateral.value() }
public fun outstanding<T>(pool: &BlindPool<T>): u64 { pool.outstanding }
public fun max_value<T>(pool: &BlindPool<T>): u64 { pool.max_value }
public fun card_value(c: &Card): u64 { c.value }
public fun pull_slot(pull: &BlindPull): u64 { pull.slot_id }
public fun pull_pool_id(pull: &BlindPull): ID { pull.pool_id }
public fun none(): u64 { NONE }

// === Test helpers ===

#[test_only]
#[allow(lint(public_random))]
public fun draw_for_testing<T>(
    pool: &mut BlindPool<T>,
    payment: Coin<T>,
    r: &Random,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    draw(pool, payment, r, clock, ctx);
}

#[test_only]
public fun seal_approve_holder_for_testing(id: vector<u8>, pull: &BlindPull) {
    seal_approve_holder(id, pull);
}

#[test_only]
public fun seal_approve_public_for_testing<T>(id: vector<u8>, pool: &BlindPool<T>) {
    seal_approve_public(id, pool);
}
