#[test_only]
module oripa::gacha_point_tests;

use oripa::gacha_point;
use sui::test_scenario as ts;

#[test]
fun charge_mints_points() {
    let mut s = ts::begin(@0xB);
    let mut bank = gacha_point::new_bank_for_testing(s.ctx());
    let c = gacha_point::charge(&mut bank, 32_000, s.ctx());
    assert!(c.value() == 32_000);
    assert!(gacha_point::total_charged(&bank) == 32_000);
    std::unit_test::destroy(c);
    gacha_point::destroy_bank_for_testing(bank);
    s.end();
}

#[test, expected_failure(abort_code = oripa::gacha_point::EBadAmount)]
fun charge_over_limit_aborts() {
    let mut s = ts::begin(@0xB);
    let mut bank = gacha_point::new_bank_for_testing(s.ctx());
    let c = gacha_point::charge(&mut bank, gacha_point::max_charge() + 1, s.ctx());
    std::unit_test::destroy(c);
    gacha_point::destroy_bank_for_testing(bank);
    s.end();
}

#[test, expected_failure(abort_code = oripa::gacha_point::EBadAmount)]
fun charge_zero_aborts() {
    let mut s = ts::begin(@0xB);
    let mut bank = gacha_point::new_bank_for_testing(s.ctx());
    let c = gacha_point::charge(&mut bank, 0, s.ctx());
    std::unit_test::destroy(c);
    gacha_point::destroy_bank_for_testing(bank);
    s.end();
}
