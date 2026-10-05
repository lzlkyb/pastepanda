//! All pairing and discovery paths must report the same native device name.

pub fn local_device_name() -> String {
    #[cfg(target_os = "android")]
    {
        return android_device_name();
    }
    #[cfg(not(target_os = "android"))]
    hostname::get()
        .map(|h| h.to_string_lossy().trim().to_string())
        .unwrap_or_default()
}

#[cfg(any(target_os = "android", test))]
fn choose_android_name(custom: &str, market: &str, manufacturer: &str, model: &str) -> String {
    for name in [custom, market] {
        if !name.trim().is_empty() {
            return name.trim().to_string();
        }
    }
    let model = model.trim();
    let maker = manufacturer.trim();
    if model.is_empty() {
        return "Android 手机".into();
    }
    if maker.is_empty() || model.to_lowercase().starts_with(&maker.to_lowercase()) {
        model.into()
    } else {
        format!("{maker} {model}")
    }
}

#[cfg(target_os = "android")]
fn android_device_name() -> String {
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_int};
    extern "C" {
        fn __system_property_get(name: *const c_char, value: *mut c_char) -> c_int;
    }
    let property = |key: &str| {
        let key = CString::new(key).expect("static property key");
        // Android's native API requires PROP_VALUE_MAX (92), including the NUL.
        let mut value = [0 as c_char; 92];
        unsafe {
            if __system_property_get(key.as_ptr(), value.as_mut_ptr()) <= 0 {
                return String::new();
            }
            CStr::from_ptr(value.as_ptr()).to_string_lossy().trim().to_string()
        }
    };
    choose_android_name(
        &property("persist.sys.device_name"),
        &property("ro.product.marketname"),
        &property("ro.product.manufacturer"),
        &property("ro.product.model"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phone_name_prefers_custom_then_market_then_real_model() {
        assert_eq!(choose_android_name(" 我的手机 ", "Pixel 9", "Google", "Pixel 9"), "我的手机");
        assert_eq!(choose_android_name("", " Redmi K80 ", "Xiaomi", "24122RKC7C"), "Redmi K80");
        assert_eq!(choose_android_name("", "", "Google", "Pixel 9"), "Google Pixel 9");
        assert_eq!(choose_android_name("", "", "Samsung", "Samsung SM-S9310"), "Samsung SM-S9310");
        assert_eq!(choose_android_name("", "", "", ""), "Android 手机");
    }

    #[test]
    fn pairing_paths_do_not_bypass_native_device_identity() {
        fn visit(path: &std::path::Path) {
            for entry in std::fs::read_dir(path).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    visit(&path);
                } else if path.extension().and_then(|s| s.to_str()) == Some("rs")
                    && path.file_name().unwrap() != "device_identity.rs"
                {
                    let source = std::fs::read_to_string(&path).unwrap();
                    let call = ["hostname::", "get()"].concat();
                    assert!(!source.lines().any(|line| {
                        !line.trim_start().starts_with("//") && line.contains(&call)
                    }), "{} bypasses native phone naming", path.display());
                }
            }
        }
        visit(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"));
    }
}
