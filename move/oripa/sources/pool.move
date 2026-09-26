/// Trustless Oripa: a finite prize pool ("oripa") whose contents are fixed at
/// creation, drawn with Sui's native randomness, and backed by operator
/// collateral that pays out automatically if a won card is never shipped.
///
/// What the operator can NOT do once a pool exists (there is no function for it):
/// - add, remove, reorder or re-price prizes
/// - change the number of draws or the price
/// - know or influence which prize the next draw returns
///
/// Two sale modes share the same pool:
/// - instant (MODE_INSTANT): every `draw` picks uniformly from what is left.
/// - batch (MODE_BATCH): spots are sold until `sale_end_ms`; `settle` then
///   shuffles the pool once and assigns prizes to the sold spots. Unsold
///   prizes go back to the operator, so the pool does not need to sell out.
#[allow(lint(self_transfer))]
module oripa::pool;

use std::string::String;
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::display;
use sui::event;
use sui::package;
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
const EWrongMode: u64 = 12;
const ESaleClosed: u64 = 13;
const ESaleOpen: u64 = 14;
const EAlreadySettled: u64 = 15;
const ENotSettled: u64 = 16;
const EExpired: u64 = 17;
const EClaimWindowOpen: u64 = 18;

// === Constants ===

const MODE_INSTANT: u8 = 0;
const MODE_BATCH: u8 = 1;
const BPS: u64 = 10_000;

// === Types ===

/// One-time witness, used to claim the Publisher for the Pull display.
public struct POOL has drop {}

/// A prize slot. Fixed-size fields only, so every draw costs the same gas
/// whichever prize comes out (no gas-budget "abort if I lose" attacks).
/// Names and images live off-chain and are committed by `metadata_hash`.
public struct Prize has store, copy, drop {
    prize_id: u64,
    /// SNKRDUNK product id of the card (image / metadata key).
    card_id: u64,
    /// PSA certification number of the physical card.
    cert: u64,
    /// Value in the pool's coin (base units).
    value: u64,
    /// 0 = S (top hit), 1 = A, 2 = B, 3 = C.
    tier: u8,
}

public struct Pool<phantom T> has key {
    id: UID,
    name: String,
    operator: address,
    mode: u8,
    price: u64,
    total_count: u64,
    total_value: u64,
    /// Prizes not yet drawn (instant) or not yet assigned (batch).
    remaining: vector<Prize>,
    remaining_value: u64,
    /// sha256 of the off-chain card metadata JSON (names, images, grades).
    metadata_hash: vector<u8>,
    sales: Balance<T>,
    collateral: Balance<T>,
    /// Share of a prize's value paid from collateral if it is not shipped.
    collateral_bps: u64,
    /// Time the operator has to ship after a redemption request.
    redeem_window_ms: u64,
    /// Redemption requests that are neither shipped nor paid out.
    outstanding: u64,
    /// Set when the instant pool sells out or the batch pool is settled.
    closed: bool,
    closed_at_ms: u64,
    // --- batch mode ---
    sale_end_ms: u64,
    spots_sold: u64,
    settled: bool,
    /// assignments[spot_no] = prize for that spot, filled by `settle`.
    assignments: vector<Prize>,
}

/// Held by the operator. Can only ship redemptions and withdraw funds.
public struct AdminCap has key, store {
    id: UID,
    pool_id: ID,
}

/// A drawn prize: the claim ticket for one physical card.
public struct Pull has key, store {
    id: UID,
    pool_id: ID,
    prize: Prize,
    drawn_at_ms: u64,
}

/// A batch-mode spot, opened into a Pull after `settle`.
public struct Spot has key, store {
    id: UID,
    pool_id: ID,
    spot_no: u64,
}

/// A shipping request. Shared so the operator can mark it shipped.
public struct Redemption has key {
    id: UID,
    pool_id: ID,
    owner: address,
    prize: Prize,
    requested_at_ms: u64,
    deadline_ms: u64,
    shipped: bool,
    tracking: String,
}

// === Events ===

public struct PoolCreated has copy, drop {
    pool_id: ID,
    operator: address,
    mode: u8,
    price: u64,
    total_count: u64,
    total_value: u64,
    collateral: u64,
}

public struct Drawn has copy, drop {
    pool_id: ID,
    pull_id: ID,
    drawer: address,
    prize: Prize,
    remaining: u64,
    remaining_value: u64,
}

public struct SpotBought has copy, drop {
    pool_id: ID,
    spot_id: ID,
    buyer: address,
    spot_no: u64,
}

public struct Settled has copy, drop {
    pool_id: ID,
    spots_sold: u64,
    returned_to_operator: u64,
}

public struct RedeemRequested has copy, drop {
    pool_id: ID,
    redemption_id: ID,
    owner: address,
    prize: Prize,
    deadline_ms: u64,
}

public struct Shipped has copy, drop {
    pool_id: ID,
    redemption_id: ID,
    tracking: String,
}

public struct CollateralClaimed has copy, drop {
    pool_id: ID,
    redemption_id: ID,
    owner: address,
    amount: u64,
}

// === Init: wallet display for Pulls ===

fun init(otw: POOL, ctx: &mut TxContext) {
    let publisher = package::claim(otw, ctx);
    let mut d = display::new_with_fields<Pull>(
        &publisher,
        vector[
            b"name".to_string(),
            b"description".to_string(),
            b"image_url".to_string(),
            b"project_url".to_string(),
        ],
        vector[
            b"Oripa Pull #{prize.prize_id}".to_string(),
            b"Claim ticket for one PSA-graded card (tier {prize.tier}, cert {prize.cert}). Drawn with Sui on-chain randomness.".to_string(),
            b"http://localhost:5173/cards/{prize.card_id}.webp".to_string(),
            b"http://localhost:5173".to_string(),
        ],
        ctx,
    );
    d.update_version();
    transfer::public_transfer(publisher, ctx.sender());
    transfer::public_transfer(d, ctx.sender());
}

// === Pool creation ===

/// Instant pool: anyone can `draw` until it is empty.
public fun create_pool<T>(
    name: String,
    price: u64,
    card_ids: vector<u64>,
    certs: vector<u64>,
    values: vector<u64>,
    tiers: vector<u8>,
    metadata_hash: vector<u8>,
    collateral: Coin<T>,
    collateral_bps: u64,
    redeem_window_ms: u64,
    ctx: &mut TxContext,
) {
    new_pool(
        name, MODE_INSTANT, price, card_ids, certs, values, tiers, metadata_hash,
        collateral, collateral_bps, redeem_window_ms, 0, ctx,
    );
}

/// Batch pool: spots sell until `sale_end_ms`, then `settle` assigns prizes.
public fun create_batch_pool<T>(
    name: String,
    price: u64,
    card_ids: vector<u64>,
    certs: vector<u64>,
    values: vector<u64>,
    tiers: vector<u8>,
    metadata_hash: vector<u8>,
    collateral: Coin<T>,
    collateral_bps: u64,
    redeem_window_ms: u64,
    sale_end_ms: u64,
    ctx: &mut TxContext,
) {
    new_pool(
        name, MODE_BATCH, price, card_ids, certs, values, tiers, metadata_hash,
        collateral, collateral_bps, redeem_window_ms, sale_end_ms, ctx,
    );
}

fun new_pool<T>(
    name: String,
    mode: u8,
    price: u64,
    card_ids: vector<u64>,
    certs: vector<u64>,
    values: vector<u64>,
    tiers: vector<u8>,
    metadata_hash: vector<u8>,
    collateral: Coin<T>,
    collateral_bps: u64,
    redeem_window_ms: u64,
    sale_end_ms: u64,
    ctx: &mut TxContext,
) {
    let n = card_ids.length();
    assert!(n > 0, EEmptyPool);
    assert!(certs.length() == n && values.length() == n && tiers.length() == n, ELengthMismatch);
    assert!(collateral_bps <= BPS, EBadBps);

    let mut remaining = vector[];
    let mut total_value = 0;
    let mut i = 0;
    while (i < n) {
        let value = values[i];
        remaining.push_back(Prize {
            prize_id: i,
            card_id: card_ids[i],
            cert: certs[i],
            value,
            tier: tiers[i],
        });
        total_value = total_value + value;
        i = i + 1;
    };

    let required = ((total_value as u128) * (collateral_bps as u128) / (BPS as u128)) as u64;
    assert!(collateral.value() >= required, EInsufficientCollateral);

    let pool = Pool<T> {
        id: object::new(ctx),
        name,
        operator: ctx.sender(),
        mode,
        price,
        total_count: n,
        total_value,
        remaining,
        remaining_value: total_value,
        metadata_hash,
        sales: balance::zero(),
        collateral: collateral.into_balance(),
        collateral_bps,
        redeem_window_ms,
        outstanding: 0,
        closed: false,
        closed_at_ms: 0,
        sale_end_ms,
        spots_sold: 0,
        settled: false,
        assignments: vector[],
    };
    let pool_id = object::id(&pool);
    event::emit(PoolCreated {
        pool_id,
        operator: ctx.sender(),
        mode,
        price,
        total_count: n,
        total_value,
        collateral: pool.collateral.value(),
    });
    transfer::public_transfer(AdminCap { id: object::new(ctx), pool_id }, ctx.sender());
    transfer::share_object(pool);
}

// === Instant mode ===

/// Pay `price` and receive a uniformly random prize from what is left.
/// Private `entry`: it cannot be called from another module, and Sui rejects
/// PTB commands after it other than transfers, so a caller cannot inspect
/// the result and abort.
entry fun draw<T>(
    pool: &mut Pool<T>,
    payment: Coin<T>,
    r: &Random,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let mut g = new_generator(r, ctx);
    draw_with(pool, payment, &mut g, clock, ctx);
}

fun draw_with<T>(
    pool: &mut Pool<T>,
    payment: Coin<T>,
    g: &mut RandomGenerator,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(pool.mode == MODE_INSTANT, EWrongMode);
    let n = pool.remaining.length();
    assert!(n > 0, ESoldOut);
    assert!(payment.value() == pool.price, EWrongPayment);
    pool.sales.join(payment.into_balance());

    // Same code path and same object size for every outcome.
    let i = g.generate_u64_in_range(0, n - 1);
    let prize = pool.remaining.swap_remove(i);
    pool.remaining_value = pool.remaining_value - prize.value;
    if (n == 1) {
        pool.closed = true;
        pool.closed_at_ms = clock.timestamp_ms();
    };
    mint_pull(pool, prize, clock, ctx);
}

// === Batch mode ===

public fun buy_spot<T>(
    pool: &mut Pool<T>,
    payment: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(pool.mode == MODE_BATCH, EWrongMode);
    assert!(clock.timestamp_ms() < pool.sale_end_ms, ESaleClosed);
    assert!(pool.spots_sold < pool.total_count, ESoldOut);
    assert!(payment.value() == pool.price, EWrongPayment);
    pool.sales.join(payment.into_balance());

    let spot = Spot { id: object::new(ctx), pool_id: object::id(pool), spot_no: pool.spots_sold };
    pool.spots_sold = pool.spots_sold + 1;
    event::emit(SpotBought {
        pool_id: object::id(pool),
        spot_id: object::id(&spot),
        buyer: ctx.sender(),
        spot_no: spot.spot_no,
    });
    transfer::public_transfer(spot, ctx.sender());
}

/// Anyone can settle once the sale has ended (or every spot is sold).
/// Shuffles the whole pool once and gives the first `spots_sold` prizes to
/// the spots; the rest stay in `remaining` and belong to the operator.
entry fun settle<T>(pool: &mut Pool<T>, r: &Random, clock: &Clock, ctx: &mut TxContext) {
    let mut g = new_generator(r, ctx);
    settle_with(pool, &mut g, clock);
}

fun settle_with<T>(pool: &mut Pool<T>, g: &mut RandomGenerator, clock: &Clock) {
    assert!(pool.mode == MODE_BATCH, EWrongMode);
    assert!(!pool.settled, EAlreadySettled);
    let now = clock.timestamp_ms();
    assert!(now >= pool.sale_end_ms || pool.spots_sold == pool.total_count, ESaleOpen);

    g.shuffle(&mut pool.remaining);
    let mut i = 0;
    while (i < pool.spots_sold) {
        let prize = pool.remaining.pop_back();
        pool.remaining_value = pool.remaining_value - prize.value;
        pool.assignments.push_back(prize);
        i = i + 1;
    };
    pool.settled = true;
    pool.closed = true;
    pool.closed_at_ms = now;
    event::emit(Settled {
        pool_id: object::id(pool),
        spots_sold: pool.spots_sold,
        returned_to_operator: pool.remaining.length(),
    });
}

/// Turn a spot into the Pull it was assigned at settlement.
public fun open_spot<T>(pool: &Pool<T>, spot: Spot, clock: &Clock, ctx: &mut TxContext) {
    let Spot { id, pool_id, spot_no } = spot;
    assert!(pool_id == object::id(pool), EWrongPool);
    assert!(pool.settled, ENotSettled);
    id.delete();
    let prize = pool.assignments[spot_no];
    mint_pull(pool, prize, clock, ctx);
}

fun mint_pull<T>(pool: &Pool<T>, prize: Prize, clock: &Clock, ctx: &mut TxContext) {
    let pull = Pull {
        id: object::new(ctx),
        pool_id: object::id(pool),
        prize,
        drawn_at_ms: clock.timestamp_ms(),
    };
    event::emit(Drawn {
        pool_id: object::id(pool),
        pull_id: object::id(&pull),
        drawer: ctx.sender(),
        prize,
        remaining: pool.remaining.length(),
        remaining_value: pool.remaining_value,
    });
    transfer::public_transfer(pull, ctx.sender());
}

// === Redemption: ship the card or pay from collateral ===

/// Burn a Pull and ask the operator to ship the card.
public fun request_redeem<T>(
    pool: &mut Pool<T>,
    pull: Pull,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let Pull { id, pool_id, prize, drawn_at_ms: _ } = pull;
    assert!(pool_id == object::id(pool), EWrongPool);
    id.delete();

    let now = clock.timestamp_ms();
    let redemption = Redemption {
        id: object::new(ctx),
        pool_id,
        owner: ctx.sender(),
        prize,
        requested_at_ms: now,
        deadline_ms: now + pool.redeem_window_ms,
        shipped: false,
        tracking: b"".to_string(),
    };
    pool.outstanding = pool.outstanding + 1;
    event::emit(RedeemRequested {
        pool_id,
        redemption_id: object::id(&redemption),
        owner: ctx.sender(),
        prize,
        deadline_ms: redemption.deadline_ms,
    });
    transfer::share_object(redemption);
}

/// Operator records shipment before the deadline. After the deadline only the
/// owner can act (claim collateral), so the operator cannot front-run a claim.
public fun mark_shipped<T>(
    cap: &AdminCap,
    pool: &mut Pool<T>,
    redemption: &mut Redemption,
    tracking: String,
    clock: &Clock,
) {
    assert!(cap.pool_id == object::id(pool), EWrongPool);
    assert!(redemption.pool_id == object::id(pool), EWrongPool);
    assert!(!redemption.shipped, EAlreadyShipped);
    assert!(clock.timestamp_ms() <= redemption.deadline_ms, EExpired);
    redemption.shipped = true;
    redemption.tracking = tracking;
    pool.outstanding = pool.outstanding - 1;
    event::emit(Shipped {
        pool_id: redemption.pool_id,
        redemption_id: object::id(redemption),
        tracking,
    });
}

/// Owner cleans up a shipped redemption once the card has arrived.
public fun confirm_received(redemption: Redemption, ctx: &TxContext) {
    assert!(redemption.owner == ctx.sender(), ENotOwner);
    assert!(redemption.shipped, EAlreadyShipped);
    let Redemption { id, .. } = redemption;
    id.delete();
}

/// Not shipped by the deadline: the owner is paid `value * collateral_bps`
/// from the operator's collateral, automatically and without asking anyone.
public fun claim_collateral<T>(
    pool: &mut Pool<T>,
    redemption: Redemption,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(redemption.pool_id == object::id(pool), EWrongPool);
    assert!(redemption.owner == ctx.sender(), ENotOwner);
    assert!(!redemption.shipped, EAlreadyShipped);
    assert!(clock.timestamp_ms() > redemption.deadline_ms, ENotExpired);

    let Redemption { id, owner, prize, .. } = redemption;
    let redemption_id = id.to_inner();
    id.delete();
    pool.outstanding = pool.outstanding - 1;

    let due = ((prize.value as u128) * (pool.collateral_bps as u128) / (BPS as u128)) as u64;
    let amount = if (due > pool.collateral.value()) pool.collateral.value() else due;
    let payout = coin::from_balance(pool.collateral.split(amount), ctx);
    event::emit(CollateralClaimed { pool_id: object::id(pool), redemption_id, owner, amount });
    transfer::public_transfer(payout, owner);
}

// === Operator funds ===

/// Sales can be withdrawn at any time; prizes are secured by collateral.
public fun withdraw_sales<T>(cap: &AdminCap, pool: &mut Pool<T>, ctx: &mut TxContext): Coin<T> {
    assert!(cap.pool_id == object::id(pool), EWrongPool);
    let amount = pool.sales.value();
    coin::from_balance(pool.sales.split(amount), ctx)
}

/// Collateral unlocks only after the pool is closed, one redemption window has
/// passed since closing (so every holder had time to request), and no
/// request is left unshipped.
public fun withdraw_collateral<T>(
    cap: &AdminCap,
    pool: &mut Pool<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(cap.pool_id == object::id(pool), EWrongPool);
    assert!(pool.closed, ENotClosed);
    assert!(clock.timestamp_ms() >= pool.closed_at_ms + pool.redeem_window_ms, EClaimWindowOpen);
    assert!(pool.outstanding == 0, EOutstanding);
    let amount = pool.collateral.value();
    coin::from_balance(pool.collateral.split(amount), ctx)
}

// === Views ===

public fun name<T>(pool: &Pool<T>): String { pool.name }
public fun operator<T>(pool: &Pool<T>): address { pool.operator }
public fun mode<T>(pool: &Pool<T>): u8 { pool.mode }
public fun price<T>(pool: &Pool<T>): u64 { pool.price }
public fun total_count<T>(pool: &Pool<T>): u64 { pool.total_count }
public fun total_value<T>(pool: &Pool<T>): u64 { pool.total_value }
public fun remaining_count<T>(pool: &Pool<T>): u64 { pool.remaining.length() }
public fun remaining_value<T>(pool: &Pool<T>): u64 { pool.remaining_value }
public fun remaining<T>(pool: &Pool<T>): vector<Prize> { pool.remaining }
public fun metadata_hash<T>(pool: &Pool<T>): vector<u8> { pool.metadata_hash }
public fun sales_value<T>(pool: &Pool<T>): u64 { pool.sales.value() }
public fun collateral_value<T>(pool: &Pool<T>): u64 { pool.collateral.value() }
public fun collateral_bps<T>(pool: &Pool<T>): u64 { pool.collateral_bps }
public fun outstanding<T>(pool: &Pool<T>): u64 { pool.outstanding }
public fun is_closed<T>(pool: &Pool<T>): bool { pool.closed }
public fun spots_sold<T>(pool: &Pool<T>): u64 { pool.spots_sold }
public fun is_settled<T>(pool: &Pool<T>): bool { pool.settled }
public fun assignments<T>(pool: &Pool<T>): vector<Prize> { pool.assignments }

public fun pull_prize(pull: &Pull): Prize { pull.prize }
public fun pull_pool_id(pull: &Pull): ID { pull.pool_id }
public fun spot_no(spot: &Spot): u64 { spot.spot_no }
public fun redemption_prize(r: &Redemption): Prize { r.prize }
public fun redemption_owner(r: &Redemption): address { r.owner }
public fun redemption_deadline_ms(r: &Redemption): u64 { r.deadline_ms }
public fun redemption_shipped(r: &Redemption): bool { r.shipped }

public fun prize_id(p: &Prize): u64 { p.prize_id }
public fun prize_card_id(p: &Prize): u64 { p.card_id }
public fun prize_cert(p: &Prize): u64 { p.cert }
public fun prize_value(p: &Prize): u64 { p.value }
public fun prize_tier(p: &Prize): u8 { p.tier }

// === Test helpers ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(POOL {}, ctx);
}

#[test_only]
#[allow(lint(public_random))]
public fun draw_for_testing<T>(
    pool: &mut Pool<T>,
    payment: Coin<T>,
    r: &Random,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    draw(pool, payment, r, clock, ctx);
}

#[test_only]
#[allow(lint(public_random))]
public fun settle_for_testing<T>(pool: &mut Pool<T>, r: &Random, clock: &Clock, ctx: &mut TxContext) {
    settle(pool, r, clock, ctx);
}
