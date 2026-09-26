#[test_only]
module oripa::pool_tests;

use oripa::pool::{Self, Pool, AdminCap, Pull, Spot, Redemption};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::random::{Self, Random};
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const OP: address = @0xA;
const ALICE: address = @0xB;
const BOB: address = @0xC;
const PRICE: u64 = 100;
const WINDOW: u64 = 1_000;
// 4 prizes: one S hit, one A, two C.
const VALUES: vector<u64> = vector[1000, 200, 50, 50];
const TOTAL: u64 = 1300;

// === Helpers ===

fun start(): (Scenario, Clock) {
    let mut s = ts::begin(@0x0);
    random::create_for_testing(s.ctx());
    s.next_tx(@0x0);
    let mut r = s.take_shared<Random>();
    r.update_randomness_state_for_testing(
        0,
        x"1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F",
        s.ctx(),
    );
    ts::return_shared(r);
    let clock = clock::create_for_testing(s.ctx());
    (s, clock)
}

fun finish(s: Scenario, clock: Clock) {
    clock.destroy_for_testing();
    s.end();
}

fun create_instant(s: &mut Scenario, collateral: u64, bps: u64) {
    s.next_tx(OP);
    pool::create_pool<SUI>(
        b"Test pool".to_string(),
        PRICE,
        vector[11, 22, 33, 44],
        vector[1, 2, 3, 4],
        VALUES,
        vector[0, 1, 3, 3],
        x"00",
        coin::mint_for_testing<SUI>(collateral, s.ctx()),
        bps,
        WINDOW,
        s.ctx(),
    );
}

fun create_batch(s: &mut Scenario, sale_end_ms: u64) {
    s.next_tx(OP);
    pool::create_batch_pool<SUI>(
        b"Batch pool".to_string(),
        PRICE,
        vector[11, 22, 33, 44],
        vector[1, 2, 3, 4],
        VALUES,
        vector[0, 1, 3, 3],
        x"00",
        coin::mint_for_testing<SUI>(TOTAL, s.ctx()),
        10_000,
        WINDOW,
        sale_end_ms,
        s.ctx(),
    );
}

/// `who` pays `amount` and draws once; returns the Pull they received.
fun draw_as(s: &mut Scenario, clock: &Clock, who: address, amount: u64): Pull {
    s.next_tx(who);
    let mut pool = s.take_shared<Pool<SUI>>();
    let r = s.take_shared<Random>();
    let payment = coin::mint_for_testing<SUI>(amount, s.ctx());
    pool::draw_for_testing(&mut pool, payment, &r, clock, s.ctx());
    ts::return_shared(pool);
    ts::return_shared(r);
    s.next_tx(who);
    s.take_from_sender<Pull>()
}

fun give_back(mut pulls: vector<Pull>, to: address) {
    while (!pulls.is_empty()) {
        transfer::public_transfer(pulls.pop_back(), to);
    };
    pulls.destroy_empty();
}

fun redeem(s: &mut Scenario, clock: &Clock, who: address, pull: Pull) {
    s.next_tx(who);
    let mut pool = s.take_shared<Pool<SUI>>();
    pool::request_redeem(&mut pool, pull, clock, s.ctx());
    ts::return_shared(pool);
}

// === Instant mode ===

#[test]
fun draws_every_prize_exactly_once() {
    let (mut s, clock) = start();
    create_instant(&mut s, TOTAL, 10_000);

    let mut seen = vector[false, false, false, false];
    let mut pulls = vector[];
    let mut drawn_value = 0;
    let mut i = 0u64;
    while (i < 4) {
        let pull = draw_as(&mut s, &clock, ALICE, PRICE);
        let prize = pool::pull_prize(&pull);
        let id = pool::prize_id(&prize);
        assert!(!seen[id]);
        *&mut seen[id] = true;
        drawn_value = drawn_value + pool::prize_value(&prize);

        s.next_tx(ALICE);
        let pool = s.take_shared<Pool<SUI>>();
        assert!(pool::remaining_count(&pool) == 3 - i);
        assert!(pool::remaining_value(&pool) == TOTAL - drawn_value);
        ts::return_shared(pool);

        pulls.push_back(pull);
        i = i + 1;
    };

    s.next_tx(OP);
    let pool = s.take_shared<Pool<SUI>>();
    assert!(pool::is_closed(&pool));
    assert!(pool::sales_value(&pool) == 4 * PRICE);
    assert!(pool::remaining_value(&pool) == 0);
    ts::return_shared(pool);

    give_back(pulls, ALICE);
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::pool::EWrongPayment)]
fun wrong_payment_aborts() {
    let (mut s, clock) = start();
    create_instant(&mut s, TOTAL, 10_000);
    let pull = draw_as(&mut s, &clock, ALICE, PRICE - 1);
    transfer::public_transfer(pull, ALICE);
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::pool::ESoldOut)]
fun draw_after_sold_out_aborts() {
    let (mut s, clock) = start();
    create_instant(&mut s, TOTAL, 10_000);
    let mut pulls = vector[];
    let mut i = 0u64;
    while (i < 5) {
        pulls.push_back(draw_as(&mut s, &clock, ALICE, PRICE));
        i = i + 1;
    };
    give_back(pulls, ALICE);
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::pool::EInsufficientCollateral)]
fun under_collateralised_pool_rejected() {
    let (mut s, clock) = start();
    // 50% of 1300 = 650 required.
    create_instant(&mut s, 649, 5_000);
    finish(s, clock);
}

// === Redemption and collateral ===

#[test]
fun unshipped_redemption_pays_collateral() {
    let (mut s, mut clock) = start();
    create_instant(&mut s, TOTAL, 10_000);
    let pull = draw_as(&mut s, &clock, ALICE, PRICE);
    let value = pool::prize_value(&pool::pull_prize(&pull));
    redeem(&mut s, &clock, ALICE, pull);

    clock.increment_for_testing(WINDOW + 1);
    s.next_tx(ALICE);
    let mut pool = s.take_shared<Pool<SUI>>();
    let redemption = s.take_shared<Redemption>();
    assert!(pool::outstanding(&pool) == 1);
    pool::claim_collateral(&mut pool, redemption, &clock, s.ctx());
    assert!(pool::outstanding(&pool) == 0);
    assert!(pool::collateral_value(&pool) == TOTAL - value);
    ts::return_shared(pool);

    s.next_tx(ALICE);
    let payout = s.take_from_sender<Coin<SUI>>();
    assert!(payout.value() == value);
    transfer::public_transfer(payout, ALICE);
    finish(s, clock);
}

#[test]
fun partial_collateral_pays_bps_share() {
    let (mut s, mut clock) = start();
    create_instant(&mut s, TOTAL / 2, 5_000);
    let pull = draw_as(&mut s, &clock, ALICE, PRICE);
    let value = pool::prize_value(&pool::pull_prize(&pull));
    redeem(&mut s, &clock, ALICE, pull);

    clock.increment_for_testing(WINDOW + 1);
    s.next_tx(ALICE);
    let mut pool = s.take_shared<Pool<SUI>>();
    let redemption = s.take_shared<Redemption>();
    pool::claim_collateral(&mut pool, redemption, &clock, s.ctx());
    ts::return_shared(pool);

    s.next_tx(ALICE);
    let payout = s.take_from_sender<Coin<SUI>>();
    assert!(payout.value() == value / 2);
    transfer::public_transfer(payout, ALICE);
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::pool::ENotExpired)]
fun claim_before_deadline_aborts() {
    let (mut s, clock) = start();
    create_instant(&mut s, TOTAL, 10_000);
    let pull = draw_as(&mut s, &clock, ALICE, PRICE);
    redeem(&mut s, &clock, ALICE, pull);

    s.next_tx(ALICE);
    let mut pool = s.take_shared<Pool<SUI>>();
    let redemption = s.take_shared<Redemption>();
    pool::claim_collateral(&mut pool, redemption, &clock, s.ctx());
    ts::return_shared(pool);
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::pool::EAlreadyShipped)]
fun shipped_redemption_cannot_claim() {
    let (mut s, mut clock) = start();
    create_instant(&mut s, TOTAL, 10_000);
    let pull = draw_as(&mut s, &clock, ALICE, PRICE);
    redeem(&mut s, &clock, ALICE, pull);

    s.next_tx(OP);
    let cap = s.take_from_sender<AdminCap>();
    let mut pool = s.take_shared<Pool<SUI>>();
    let mut redemption = s.take_shared<Redemption>();
    pool::mark_shipped(&cap, &mut pool, &mut redemption, b"JP123".to_string(), &clock);
    assert!(pool::outstanding(&pool) == 0);
    ts::return_shared(redemption);
    ts::return_shared(pool);
    s.return_to_sender(cap);

    clock.increment_for_testing(WINDOW + 1);
    s.next_tx(ALICE);
    let mut pool = s.take_shared<Pool<SUI>>();
    let redemption = s.take_shared<Redemption>();
    pool::claim_collateral(&mut pool, redemption, &clock, s.ctx());
    ts::return_shared(pool);
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::pool::EExpired)]
fun operator_cannot_ship_after_deadline() {
    let (mut s, mut clock) = start();
    create_instant(&mut s, TOTAL, 10_000);
    let pull = draw_as(&mut s, &clock, ALICE, PRICE);
    redeem(&mut s, &clock, ALICE, pull);

    clock.increment_for_testing(WINDOW + 1);
    s.next_tx(OP);
    let cap = s.take_from_sender<AdminCap>();
    let mut pool = s.take_shared<Pool<SUI>>();
    let mut redemption = s.take_shared<Redemption>();
    pool::mark_shipped(&cap, &mut pool, &mut redemption, b"late".to_string(), &clock);
    ts::return_shared(redemption);
    ts::return_shared(pool);
    s.return_to_sender(cap);
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::pool::ENotOwner)]
fun only_owner_can_claim() {
    let (mut s, mut clock) = start();
    create_instant(&mut s, TOTAL, 10_000);
    let pull = draw_as(&mut s, &clock, ALICE, PRICE);
    redeem(&mut s, &clock, ALICE, pull);

    clock.increment_for_testing(WINDOW + 1);
    s.next_tx(BOB);
    let mut pool = s.take_shared<Pool<SUI>>();
    let redemption = s.take_shared<Redemption>();
    pool::claim_collateral(&mut pool, redemption, &clock, s.ctx());
    ts::return_shared(pool);
    finish(s, clock);
}

// === Operator funds ===

#[test, expected_failure(abort_code = oripa::pool::ENotClosed)]
fun collateral_locked_while_open() {
    let (mut s, clock) = start();
    create_instant(&mut s, TOTAL, 10_000);
    s.next_tx(OP);
    let cap = s.take_from_sender<AdminCap>();
    let mut pool = s.take_shared<Pool<SUI>>();
    let c = pool::withdraw_collateral(&cap, &mut pool, &clock, s.ctx());
    transfer::public_transfer(c, OP);
    ts::return_shared(pool);
    s.return_to_sender(cap);
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::pool::EOutstanding)]
fun collateral_locked_while_redemption_outstanding() {
    let (mut s, mut clock) = start();
    create_instant(&mut s, TOTAL, 10_000);
    let mut pulls = vector[];
    let mut i = 0u64;
    while (i < 4) {
        pulls.push_back(draw_as(&mut s, &clock, ALICE, PRICE));
        i = i + 1;
    };
    redeem(&mut s, &clock, ALICE, pulls.pop_back());

    clock.increment_for_testing(WINDOW + 1);
    s.next_tx(OP);
    let cap = s.take_from_sender<AdminCap>();
    let mut pool = s.take_shared<Pool<SUI>>();
    let c = pool::withdraw_collateral(&cap, &mut pool, &clock, s.ctx());
    transfer::public_transfer(c, OP);
    ts::return_shared(pool);
    s.return_to_sender(cap);
    give_back(pulls, ALICE);
    finish(s, clock);
}

#[test]
fun operator_withdraws_after_close_and_window() {
    let (mut s, mut clock) = start();
    create_instant(&mut s, TOTAL, 10_000);
    let mut pulls = vector[];
    let mut i = 0u64;
    while (i < 4) {
        pulls.push_back(draw_as(&mut s, &clock, ALICE, PRICE));
        i = i + 1;
    };

    clock.increment_for_testing(WINDOW);
    s.next_tx(OP);
    let cap = s.take_from_sender<AdminCap>();
    let mut pool = s.take_shared<Pool<SUI>>();
    let sales = pool::withdraw_sales(&cap, &mut pool, s.ctx());
    assert!(sales.value() == 4 * PRICE);
    let c = pool::withdraw_collateral(&cap, &mut pool, &clock, s.ctx());
    assert!(c.value() == TOTAL);
    transfer::public_transfer(sales, OP);
    transfer::public_transfer(c, OP);
    ts::return_shared(pool);
    s.return_to_sender(cap);
    give_back(pulls, ALICE);
    finish(s, clock);
}

// === Batch mode ===

#[test]
fun batch_assigns_sold_spots_and_returns_rest() {
    let (mut s, mut clock) = start();
    create_batch(&mut s, 500);

    s.next_tx(ALICE);
    let mut pool = s.take_shared<Pool<SUI>>();
    pool::buy_spot(&mut pool, coin::mint_for_testing<SUI>(PRICE, s.ctx()), &clock, s.ctx());
    ts::return_shared(pool);
    s.next_tx(BOB);
    let mut pool = s.take_shared<Pool<SUI>>();
    pool::buy_spot(&mut pool, coin::mint_for_testing<SUI>(PRICE, s.ctx()), &clock, s.ctx());
    ts::return_shared(pool);

    clock.increment_for_testing(500);
    s.next_tx(BOB);
    let mut pool = s.take_shared<Pool<SUI>>();
    let r = s.take_shared<Random>();
    pool::settle_for_testing(&mut pool, &r, &clock, s.ctx());
    assert!(pool::is_settled(&pool));
    assert!(pool::assignments(&pool).length() == 2);
    // Two unsold prizes stay with the operator.
    assert!(pool::remaining_count(&pool) == 2);
    ts::return_shared(r);
    ts::return_shared(pool);

    // Both buyers open their spots into distinct prizes.
    s.next_tx(ALICE);
    let pool = s.take_shared<Pool<SUI>>();
    let spot = s.take_from_sender<Spot>();
    assert!(pool::spot_no(&spot) == 0);
    pool::open_spot(&pool, spot, &clock, s.ctx());
    ts::return_shared(pool);
    s.next_tx(ALICE);
    let a = s.take_from_sender<Pull>();

    s.next_tx(BOB);
    let pool = s.take_shared<Pool<SUI>>();
    let spot = s.take_from_sender<Spot>();
    pool::open_spot(&pool, spot, &clock, s.ctx());
    let assigned = pool::assignments(&pool);
    let remaining_value = pool::remaining_value(&pool);
    ts::return_shared(pool);
    s.next_tx(BOB);
    let b = s.take_from_sender<Pull>();

    let pa = pool::pull_prize(&a);
    let pb = pool::pull_prize(&b);
    assert!(pool::prize_id(&pa) != pool::prize_id(&pb));
    assert!(pool::prize_id(&pa) == pool::prize_id(&assigned[0]));
    assert!(pool::prize_value(&pa) + pool::prize_value(&pb) + remaining_value == TOTAL);

    transfer::public_transfer(a, ALICE);
    transfer::public_transfer(b, BOB);
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::pool::ESaleOpen)]
fun batch_cannot_settle_before_sale_end() {
    let (mut s, clock) = start();
    create_batch(&mut s, 500);
    s.next_tx(ALICE);
    let mut pool = s.take_shared<Pool<SUI>>();
    pool::buy_spot(&mut pool, coin::mint_for_testing<SUI>(PRICE, s.ctx()), &clock, s.ctx());
    let r = s.take_shared<Random>();
    pool::settle_for_testing(&mut pool, &r, &clock, s.ctx());
    ts::return_shared(r);
    ts::return_shared(pool);
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::pool::ESaleClosed)]
fun batch_cannot_buy_after_sale_end() {
    let (mut s, mut clock) = start();
    create_batch(&mut s, 500);
    clock.increment_for_testing(500);
    s.next_tx(ALICE);
    let mut pool = s.take_shared<Pool<SUI>>();
    pool::buy_spot(&mut pool, coin::mint_for_testing<SUI>(PRICE, s.ctx()), &clock, s.ctx());
    ts::return_shared(pool);
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::pool::EWrongMode)]
fun cannot_draw_from_batch_pool() {
    let (mut s, clock) = start();
    create_batch(&mut s, 500);
    let pull = draw_as(&mut s, &clock, ALICE, PRICE);
    transfer::public_transfer(pull, ALICE);
    finish(s, clock);
}
