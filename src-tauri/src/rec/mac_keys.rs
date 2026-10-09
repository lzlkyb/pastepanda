//! Physical key codes only: never inspect characters or input-method text.
pub(super) fn combo(code: u32, flags: u64) -> Option<String> {
    let control = flags & (1 << 18) != 0;
    let option = flags & (1 << 19) != 0;
    let command = flags & (1 << 20) != 0;
    let shift = flags & (1 << 17) != 0;
    let functional = match code {
        36 => Some("Enter"),
        48 => Some("Tab"),
        49 => Some("Space"),
        51 => Some("Backspace"),
        53 => Some("Escape"),
        117 => Some("Delete"),
        115 => Some("Home"),
        119 => Some("End"),
        116 => Some("PageUp"),
        121 => Some("PageDown"),
        123 => Some("Left"),
        124 => Some("Right"),
        125 => Some("Down"),
        126 => Some("Up"),
        122 => Some("F1"),
        120 => Some("F2"),
        99 => Some("F3"),
        118 => Some("F4"),
        96 => Some("F5"),
        97 => Some("F6"),
        98 => Some("F7"),
        100 => Some("F8"),
        101 => Some("F9"),
        109 => Some("F10"),
        103 => Some("F11"),
        111 => Some("F12"),
        _ => None,
    };
    let key = functional.or_else(|| {
        // Option-only letters may be ordinary accented text on a Mac keyboard.
        if !control && !command {
            return None;
        }
        match code {
            0 => Some("A"),
            1 => Some("S"),
            2 => Some("D"),
            3 => Some("F"),
            4 => Some("H"),
            5 => Some("G"),
            6 => Some("Z"),
            7 => Some("X"),
            8 => Some("C"),
            9 => Some("V"),
            11 => Some("B"),
            12 => Some("Q"),
            13 => Some("W"),
            14 => Some("E"),
            15 => Some("R"),
            16 => Some("Y"),
            17 => Some("T"),
            18 => Some("1"),
            19 => Some("2"),
            20 => Some("3"),
            21 => Some("4"),
            22 => Some("6"),
            23 => Some("5"),
            25 => Some("9"),
            26 => Some("7"),
            28 => Some("8"),
            29 => Some("0"),
            31 => Some("O"),
            32 => Some("U"),
            34 => Some("I"),
            35 => Some("P"),
            37 => Some("L"),
            38 => Some("J"),
            40 => Some("K"),
            45 => Some("N"),
            46 => Some("M"),
            _ => None,
        }
    })?;
    let mut parts = Vec::new();
    if control {
        parts.push("Control");
    }
    if option {
        parts.push("Option");
    }
    if shift {
        parts.push("Shift");
    }
    if command {
        parts.push("Command");
    }
    parts.push(key);
    Some(parts.join("+"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn privacy_rejects_text_punctuation_and_modifiers() {
        for code in [0, 8, 18, 41, 42, 56, 59, 55, 200] {
            assert!(combo(code, 0).is_none());
            assert!(combo(code, 1 << 17).is_none());
        }
        for code in [41, 42, 56, 59, 55, 200] {
            assert!(combo(code, 1 << 20).is_none());
        }
        assert!(combo(8, 1 << 19).is_none());
        assert_eq!(combo(8, 1 << 20).as_deref(), Some("Command+C"));
        assert_eq!(combo(123, 1 << 17).as_deref(), Some("Shift+Left"));
    }
}
