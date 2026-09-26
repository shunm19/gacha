#[test_only]
module oripa::blind_tests;

use oripa::blind::{Self, BlindPool, BlindCap, BlindPull, BlindRedemption};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::random::{Self, Random};
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const OP: address = @0xA;
const ALICE: address = @0xB;
const PRICE: u64 = 100;
const WINDOW: u64 = 1_000;
// Lineup (public): prize 0 is the jackpot.
const VALUES: vector<u64> = vector[1000, 200, 50, 50];
const TOTAL: u64 = 1300;
// Hidden mapping slot -> prize.
const MAPPING: vector<u64> = vector[2, 0, 3, 1];

fun salt(slot: u64): vector<u8> {
    let mut s = vector[];
    let mut i = 0u64;
    while (i < 32) {
        s.push_back(((slot * 7 + i) % 256) as u8);
        i = i + 1;
    };
    s
}

fun start(): (Scenario, Clock) {
    let mut s = ts::begin(@0x0);
    random::create_for_testing(s.ctx());
    s.next_tx(@0x0);
    let mut r = s.take_shared<Random>();
    r.update_randomness_state_for_testing(
        0,
        x"2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A",
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

/// Create, load slots per `mapping`, seal.
fun create(s: &mut Scenario, mapping: vector<u64>, reveal_tail: u64, sale_end_ms: u64) {
    s.next_tx(OP);
    blind::create_blind_pool<SUI>(
        b"Blind".to_string(),
        PRICE,
        vector[11, 22, 33, 44],
        vector[1, 2, 3, 4],
        VALUES,
        vector[0, 1, 3, 3],
        x"00",
        reveal_tail,
        sale_end_ms,
        coin::mint_for_testing<SUI>(TOTAL, s.ctx()),
        10_000,
        WINDOW,
        s.ctx(),
    );
    s.next_tx(OP);
    let cap = s.take_from_sender<BlindCap>();
    let mut pool = s.take_shared<BlindPool<SUI>>();
    let mut commitments = vector[];
    let mut cts = vector[];
    let mut slot = 0u64;
    while (slot < 4) {
        commitments.push_back(blind::commitment(slot, mapping[slot], &salt(slot)));
        cts.push_back(b"ciphertext");
        slot = slot + 1;
    };
    blind::add_slots(&cap, &mut pool, commitments, cts);
    blind::seal_slots(&cap, &mut pool);
    ts::return_shared(pool);
    s.return_to_sender(cap);
}

fun draw_as(s: &mut Scenario, clock: &Clock, who: address): BlindPull {
    s.next_tx(who);
    let mut pool = s.take_shared<BlindPool<SUI>>();
    let r = s.take_shared<Random>();
    blind::draw_for_testing(&mut pool, coin::mint_for_testing<SUI>(PRICE, s.ctx()), &r, clock, s.ctx());
    ts::return_shared(pool);
    ts::return_shared(r);
    s.next_tx(who);
    s.take_from_sender<BlindPull>()
}

fun reveal(s: &mut Scenario, slot: u64, prize: u64, salt_: vector<u8>) {
    s.next_tx(ALICE);
    let mut pool = s.take_shared<BlindPool<SUI>>();
    blind::reveal(&mut pool, slot, prize, salt_);
    ts::return_shared(pool);
}

fun give_back(mut pulls: vector<BlindPull>) {
    while (!pulls.is_empty()) transfer::public_transfer(pulls.pop_back(), ALICE);
    pulls.destroy_empty();
}

fun pool_id(s: &mut Scenario): ID {
    s.next_tx(ALICE);
    let pool = s.take_shared<BlindPool<SUI>>();
    let id = object::id(&pool);
    ts::return_shared(pool);
    id
}

// === Draw and hide ===

#[test]
fun draws_each_slot_once_and_closes() {
    let (mut s, clock) = start();
    create(&mut s, MAPPING, 0, 0);
    let mut seen = vector[false, false, false, false];
    let mut pulls = vector[];
    let mut i = 0u64;
    while (i < 4) {
        let p = draw_as(&mut s, &clock, ALICE);
        let slot = blind::pull_slot(&p);
        assert!(!seen[slot]);
        *&mut seen[slot] = true;
        pulls.push_back(p);
        i = i + 1;
    };
    s.next_tx(ALICE);
    let pool = s.take_shared<BlindPool<SUI>>();
    assert!(blind::is_closed(&pool));
    assert!(blind::sales_value(&pool) == 4 * PRICE);
    ts::return_shared(pool);
    give_back(pulls);
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::blind::ENotSealed)]
fun cannot_draw_before_seal() {
    let (mut s, clock) = start();
    s.next_tx(OP);
    blind::create_blind_pool<SUI>(
        b"x".to_string(), PRICE, vector[1], vector[1], vector[10], vector[0], x"00", 0, 0,
        coin::mint_for_testing<SUI>(10, s.ctx()), 10_000, WINDOW, s.ctx(),
    );
    let p = draw_as(&mut s, &clock, ALICE);
    transfer::public_transfer(p, ALICE);
    finish(s, clock);
}

// === Seal policies ===

#[test]
fun holder_can_decrypt_own_slot() {
    let (mut s, clock) = start();
    create(&mut s, MAPPING, 0, 0);
    let p = draw_as(&mut s, &clock, ALICE);
    blind::seal_approve_holder_for_testing(blind::seal_id(blind::pull_pool_id(&p), blind::pull_slot(&p)), &p);
    transfer::public_transfer(p, ALICE);
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::blind::ENoAccess)]
fun holder_cannot_decrypt_other_slot() {
    let (mut s, clock) = start();
    create(&mut s, MAPPING, 0, 0);
    let p = draw_as(&mut s, &clock, ALICE);
    let other = (blind::pull_slot(&p) + 1) % 4;
    blind::seal_approve_holder_for_testing(blind::seal_id(blind::pull_pool_id(&p), other), &p);
    transfer::public_transfer(p, ALICE);
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::blind::ENoAccess)]
fun public_cannot_decrypt_during_sale() {
    let (mut s, clock) = start();
    create(&mut s, MAPPING, 1, 0);
    let id = pool_id(&mut s);
    s.next_tx(ALICE);
    let pool = s.take_shared<BlindPool<SUI>>();
    blind::seal_approve_public_for_testing(blind::seal_id(id, 0), &pool);
    ts::return_shared(pool);
    finish(s, clock);
}

#[test]
fun public_can_decrypt_in_tail() {
    let (mut s, clock) = start();
    create(&mut s, MAPPING, 1, 0);
    let id = pool_id(&mut s);
    let mut pulls = vector[];
    let mut i = 0u64;
    while (i < 3) {
        pulls.push_back(draw_as(&mut s, &clock, ALICE));
        i = i + 1;
    };
    s.next_tx(ALICE);
    let pool = s.take_shared<BlindPool<SUI>>();
    assert!(blind::is_public(&pool));
    blind::seal_approve_public_for_testing(blind::seal_id(id, 2), &pool);
    ts::return_shared(pool);
    give_back(pulls);
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::blind::ENoAccess)]
fun public_policy_rejects_other_pool_ids() {
    let (mut s, clock) = start();
    create(&mut s, MAPPING, 4, 0); // tail = everything public
    s.next_tx(ALICE);
    let pool = s.take_shared<BlindPool<SUI>>();
    blind::seal_approve_public_for_testing(blind::seal_id(object::id_from_address(@0x1234), 0), &pool);
    ts::return_shared(pool);
    finish(s, clock);
}

// === Reveal ===

#[test]
fun reveal_drawn_slot_then_redeem() {
    let (mut s, clock) = start();
    create(&mut s, MAPPING, 0, 0);
    let p = draw_as(&mut s, &clock, ALICE);
    let slot = blind::pull_slot(&p);
    reveal(&mut s, slot, MAPPING[slot], salt(slot));

    s.next_tx(ALICE);
    let mut pool = s.take_shared<BlindPool<SUI>>();
    assert!(blind::revealed_prize(&pool, slot) == MAPPING[slot]);
    blind::request_redeem(&mut pool, p, &clock, s.ctx());
    assert!(blind::outstanding(&pool) == 1);
    ts::return_shared(pool);
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::blind::ERevealLocked)]
fun cannot_reveal_undrawn_slot_during_sale() {
    let (mut s, clock) = start();
    create(&mut s, MAPPING, 0, 0);
    reveal(&mut s, 0, MAPPING[0], salt(0));
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::blind::EBadCommitment)]
fun wrong_prize_does_not_open_commitment() {
    let (mut s, clock) = start();
    create(&mut s, MAPPING, 0, 0);
    let p = draw_as(&mut s, &clock, ALICE);
    let slot = blind::pull_slot(&p);
    // Claim it was the jackpot when it was not (or vice versa).
    reveal(&mut s, slot, (MAPPING[slot] + 1) % 4, salt(slot));
    transfer::public_transfer(p, ALICE);
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::blind::EPrizeUsed)]
fun operator_cannot_commit_one_prize_twice() {
    let (mut s, clock) = start();
    // Cheating operator: no slot holds the jackpot (prize 0); prize 3 appears twice.
    create(&mut s, vector[2, 3, 3, 1], 0, 0);
    let mut pulls = vector[];
    let mut i = 0u64;
    while (i < 4) {
        pulls.push_back(draw_as(&mut s, &clock, ALICE));
        i = i + 1;
    };
    reveal(&mut s, 1, 3, salt(1));
    reveal(&mut s, 2, 3, salt(2));
    give_back(pulls);
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::blind::ENotRevealed)]
fun cannot_redeem_hidden_slot() {
    let (mut s, clock) = start();
    create(&mut s, MAPPING, 0, 0);
    let p = draw_as(&mut s, &clock, ALICE);
    s.next_tx(ALICE);
    let mut pool = s.take_shared<BlindPool<SUI>>();
    blind::request_redeem(&mut pool, p, &clock, s.ctx());
    ts::return_shared(pool);
    finish(s, clock);
}

// === Penalties and collateral ===

#[test]
fun unrevealed_slot_pays_top_prize() {
    let (mut s, mut clock) = start();
    create(&mut s, MAPPING, 0, 0);
    let mut pulls = vector[];
    let mut i = 0u64;
    while (i < 4) {
        pulls.push_back(draw_as(&mut s, &clock, ALICE));
        i = i + 1;
    };
    clock.increment_for_testing(WINDOW + 1);
    let p = pulls.pop_back();
    s.next_tx(ALICE);
    let mut pool = s.take_shared<BlindPool<SUI>>();
    blind::claim_unrevealed(&mut pool, p, &clock, s.ctx());
    assert!(blind::collateral_value(&pool) == TOTAL - 1000);
    ts::return_shared(pool);
    s.next_tx(ALICE);
    let c = s.take_from_sender<Coin<SUI>>();
    assert!(c.value() == 1000);
    transfer::public_transfer(c, ALICE);
    give_back(pulls);
    finish(s, clock);
}

#[test, expected_failure(abort_code = oripa::blind::EUnrevealed)]
fun collateral_locked_until_all_drawn_slots_revealed() {
    let (mut s, mut clock) = start();
    create(&mut s, MAPPING, 0, 0);
    let mut pulls = vector[];
    let mut i = 0u64;
    while (i < 4) {
        pulls.push_back(draw_as(&mut s, &clock, ALICE));
        i = i + 1;
    };
    clock.increment_for_testing(2 * WINDOW);
    s.next_tx(OP);
    let cap = s.take_from_sender<BlindCap>();
    let mut pool = s.take_shared<BlindPool<SUI>>();
    let c = blind::withdraw_collateral(&cap, &mut pool, &clock, s.ctx());
    transfer::public_transfer(c, OP);
    ts::return_shared(pool);
    s.return_to_sender(cap);
    give_back(pulls);
    finish(s, clock);
}

#[test]
fun full_cycle_reveal_all_then_withdraw() {
    let (mut s, mut clock) = start();
    create(&mut s, MAPPING, 0, 0);
    let mut pulls = vector[];
    let mut i = 0u64;
    while (i < 4) {
        pulls.push_back(draw_as(&mut s, &clock, ALICE));
        i = i + 1;
    };
    let mut slot = 0u64;
    while (slot < 4) {
        reveal(&mut s, slot, MAPPING[slot], salt(slot));
        slot = slot + 1;
    };
    clock.increment_for_testing(2 * WINDOW);
    s.next_tx(OP);
    let cap = s.take_from_sender<BlindCap>();
    let mut pool = s.take_shared<BlindPool<SUI>>();
    assert!(blind::revealed_count(&pool) == 4);
    let sales = blind::withdraw_sales(&cap, &mut pool, s.ctx());
    let c = blind::withdraw_collateral(&cap, &mut pool, &clock, s.ctx());
    assert!(sales.value() == 4 * PRICE && c.value() == TOTAL);
    transfer::public_transfer(sales, OP);
    transfer::public_transfer(c, OP);
    ts::return_shared(pool);
    s.return_to_sender(cap);
    give_back(pulls);
    finish(s, clock);
}

#[test]
fun unshipped_redemption_pays_value() {
    let (mut s, mut clock) = start();
    create(&mut s, MAPPING, 0, 0);
    let p = draw_as(&mut s, &clock, ALICE);
    let slot = blind::pull_slot(&p);
    let prize = MAPPING[slot];
    reveal(&mut s, slot, prize, salt(slot));
    s.next_tx(ALICE);
    let mut pool = s.take_shared<BlindPool<SUI>>();
    blind::request_redeem(&mut pool, p, &clock, s.ctx());
    ts::return_shared(pool);

    clock.increment_for_testing(WINDOW + 1);
    s.next_tx(ALICE);
    let mut pool = s.take_shared<BlindPool<SUI>>();
    let r = s.take_shared<BlindRedemption>();
    blind::claim_collateral(&mut pool, r, &clock, s.ctx());
    ts::return_shared(pool);
    s.next_tx(ALICE);
    let c = s.take_from_sender<Coin<SUI>>();
    assert!(c.value() == VALUES[prize]);
    transfer::public_transfer(c, ALICE);
    finish(s, clock);
}

#[test]
fun close_after_sale_deadline_makes_everything_public() {
    let (mut s, mut clock) = start();
    create(&mut s, MAPPING, 0, 500);
    let p = draw_as(&mut s, &clock, ALICE);
    clock.increment_for_testing(500);
    s.next_tx(ALICE);
    let mut pool = s.take_shared<BlindPool<SUI>>();
    blind::close_after_sale(&mut pool, &clock);
    assert!(blind::is_public(&pool) && blind::remaining_count(&pool) == 3);
    ts::return_shared(pool);
    // An unsold slot can now be revealed by anyone.
    let unsold = (blind::pull_slot(&p) + 1) % 4;
    reveal(&mut s, unsold, MAPPING[unsold], salt(unsold));
    transfer::public_transfer(p, ALICE);
    finish(s, clock);
}
