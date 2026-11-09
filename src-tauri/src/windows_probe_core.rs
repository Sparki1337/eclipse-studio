//! Чистый разбор флагов ядра и CIM_DATETIME для совместимости журналов VBS.
pub fn kva_needed(flags: u32) -> bool {
    flags & 1 != 0 || flags & 0x30 == 0x30
}
pub fn dse_mode(options: u32) -> i32 {
    if options & 1 == 0 {
        0
    } else if options & 2 != 0 {
        1
    } else {
        2
    }
}
fn days(year: u32, month: u32) -> u32 {
    match month {
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}
pub fn cim_boot_id(value: &str) -> Result<String, String> {
    let bad = || "Неверный LastBootUpTime Windows".to_string();
    let bytes = value.as_bytes();
    if bytes.len() != 25
        || bytes[14] != b'.'
        || !matches!(bytes[21], b'+' | b'-')
        || bytes
            .iter()
            .enumerate()
            .any(|(i, c)| i != 14 && i != 21 && !c.is_ascii_digit())
    {
        return Err(bad());
    }
    let number = |a, b| {
        value
            .get(a..b)
            .ok_or_else(bad)?
            .parse::<u32>()
            .map_err(|_| bad())
    };
    let mut year = number(0, 4)?;
    let mut month = number(4, 6)?;
    let mut day = number(6, 8)?;
    let hour = number(8, 10)?;
    let minute = number(10, 12)?;
    let second = number(12, 14)?;
    if !(1601..=9999).contains(&year)
        || !(1..=12).contains(&month)
        || !(1..=days(year, month)).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(bad());
    }
    let offset = number(22, 25)? as i32 * if bytes[21] == b'+' { 1 } else { -1 };
    let mut total = (hour * 60 + minute) as i32 - offset;
    while total < 0 {
        total += 1440;
        if day > 1 {
            day -= 1;
        } else {
            if month > 1 {
                month -= 1;
            } else {
                if year == 1601 {
                    return Err(bad());
                }
                year -= 1;
                month = 12;
            }
            day = days(year, month);
        }
    }
    while total >= 1440 {
        total -= 1440;
        if day < days(year, month) {
            day += 1;
        } else {
            day = 1;
            if month < 12 {
                month += 1;
            } else {
                if year == 9999 {
                    return Err(bad());
                }
                year += 1;
                month = 1;
            }
        }
    }
    // Формат прежних журналов .NET: семь знаков дробной части и суффикс UTC Z.
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{second:02}.{}0Z",
        total / 60,
        total % 60,
        &value[15..21]
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cim_time_is_identical_to_legacy_utc_round_trip_format() {
        assert_eq!(
            cim_boot_id("20261105150354.123456+120").unwrap(),
            "2026-11-05T13:03:54.1234560Z"
        );
        assert_eq!(
            cim_boot_id("20260101003000.000000+120").unwrap(),
            "2025-12-31T22:30:00.0000000Z"
        );
        assert_eq!(
            cim_boot_id("20260228233000.999999-060").unwrap(),
            "2026-03-01T00:30:00.9999990Z"
        );
        assert_eq!(
            cim_boot_id("20240301003000.000000+120").unwrap(),
            "2024-02-29T22:30:00.0000000Z"
        );
        assert_eq!(
            cim_boot_id("20260301003000.000000+120").unwrap(),
            "2026-02-28T22:30:00.0000000Z"
        );
    }
    #[test]
    fn invalid_or_unknown_boot_dates_are_never_fabricated() {
        for value in [
            "",
            "2026**********.******+***",
            "20260229000000.000000+000",
            "20261301000000.000000+000",
            "20260101246000.000000+000",
            "16010101000000.000000+001",
            "99991231235959.000000-001",
            "2026🦀***",
        ] {
            assert!(cim_boot_id(value).is_err(), "{value}");
        }
    }
    #[test]
    fn native_kernel_flags_keep_both_kva_and_dse_modes() {
        for value in [0, 0x10, 0x20, 0x40] {
            assert!(!kva_needed(value));
        }
        for value in [1, 0x30, 0x31] {
            assert!(kva_needed(value));
        }
        assert_eq!(dse_mode(0), 0);
        assert_eq!(dse_mode(1), 2);
        assert_eq!(dse_mode(3), 1);
        assert_eq!(dse_mode(0x4001), 2);
    }
}
