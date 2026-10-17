//! 贴图的明确交付手柄。绘制与命中复用同一矩形，避免混合 DPI 下点不准。
use windows::core::w;
use windows::Win32::Foundation::{COLORREF, RECT};
use windows::Win32::Graphics::Gdi::*;

pub fn handle_rect(width: i32, height: i32, dpi: u32) -> Option<RECT> {
    let scale = dpi.max(96) as f32 / 96.0;
    let dip = |n: f32| (n * scale).round() as i32;
    let (margin, w, h) = (dip(8.0), dip(104.0), dip(28.0));
    if width < w + dip(48.0) || height < h + margin * 2 { return None; }
    Some(RECT { left: margin, top: margin, right: margin + w, bottom: margin + h })
}
pub fn hit(width: i32, height: i32, dpi: u32, x: i32, y: i32) -> bool {
    handle_rect(width, height, dpi).is_some_and(|r| x >= r.left && x < r.right && y >= r.top && y < r.bottom)
}
pub unsafe fn draw(hdc: HDC, width: i32, height: i32, dpi: u32, hot: bool) {
    let Some(mut rect) = handle_rect(width, height, dpi) else { return; };
    // 沿用原生贴图关闭按钮的深色底衬与 indigo 悬停色，白字在浅色图上也清晰。
    let brush = CreateSolidBrush(COLORREF(if hot { 0x00CA3843 } else { 0x00382B25 }));
    FillRect(hdc, &rect, brush);
    let _ = DeleteObject(brush);
    let font = CreateFontW((12 * dpi.max(96) / 96) as i32, 0, 0, 0, 500, 0, 0, 0, 1, 0, 0, 0, 0, w!("Microsoft YaHei UI"));
    let old_font = SelectObject(hdc, font);
    let old_mode = SetBkMode(hdc, TRANSPARENT);
    let old_color = SetTextColor(hdc, COLORREF(0x00FFFFFF));
    let mut text: Vec<u16> = "拖入应用".encode_utf16().collect();
    DrawTextW(hdc, &mut text, &mut rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    SetTextColor(hdc, old_color);
    SetBkMode(hdc, BACKGROUND_MODE(old_mode as u32));
    SelectObject(hdc, old_font);
    let _ = DeleteObject(font);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transfer_hit_matches_painted_rect_at_mixed_dpi() {
        for dpi in [96, 120, 144, 192] {
            let r = handle_rect(800, 600, dpi).unwrap();
            assert!(hit(800, 600, dpi, r.left, r.top));
            assert!(!hit(800, 600, dpi, r.right, r.bottom));
            assert!(!hit(20, 20, dpi, 8, 8));
        }
    }
}
