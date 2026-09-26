/// Gacha Point (GP): the prepaid point players draw with. 1 GP = 1 JPY, no
/// decimals, so prices and prize values read as yen.
///
/// Testnet demo: anyone can charge up to MAX_CHARGE per call from the shared
/// PointBank. In production the bank would sell GP 1:1 for yen / JPYC / USDC;
/// the pools are generic over the coin, so nothing else changes.
module oripa::gacha_point;

use sui::coin::{Self, Coin, TreasuryCap};
use sui::coin_registry;
use sui::event;

const EBadAmount: u64 = 0;

const MAX_CHARGE: u64 = 1_000_000;

public struct GACHA_POINT has drop {}

public struct PointBank has key {
    id: UID,
    cap: TreasuryCap<GACHA_POINT>,
    total_charged: u64,
}

public struct Charged has copy, drop {
    who: address,
    amount: u64,
}

fun init(otw: GACHA_POINT, ctx: &mut TxContext) {
    let (init, cap) = coin_registry::new_currency_with_otw(
        otw,
        0,
        b"GP".to_string(),
        b"Gacha Point".to_string(),
        b"Prepaid points for Trustless Oripa (1 GP = 1 JPY). Free to charge on testnet.".to_string(),
        b"".to_string(),
        ctx,
    );
    init.finalize_and_delete_metadata_cap(ctx);
    transfer::share_object(PointBank { id: object::new(ctx), cap, total_charged: 0 });
}

/// Charge `amount` GP (1..=MAX_CHARGE).
public fun charge(bank: &mut PointBank, amount: u64, ctx: &mut TxContext): Coin<GACHA_POINT> {
    assert!(amount > 0 && amount <= MAX_CHARGE, EBadAmount);
    bank.total_charged = bank.total_charged + amount;
    event::emit(Charged { who: ctx.sender(), amount });
    coin::mint(&mut bank.cap, amount, ctx)
}

public fun max_charge(): u64 { MAX_CHARGE }
public fun total_charged(bank: &PointBank): u64 { bank.total_charged }

#[test_only]
public fun new_bank_for_testing(ctx: &mut TxContext): PointBank {
    PointBank { id: object::new(ctx), cap: coin::create_treasury_cap_for_testing(ctx), total_charged: 0 }
}

#[test_only]
public fun destroy_bank_for_testing(bank: PointBank) {
    let PointBank { id, cap, total_charged: _ } = bank;
    id.delete();
    std::unit_test::destroy(cap);
}
