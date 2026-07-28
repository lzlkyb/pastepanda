/// 导出命令：将历史记录导出为 CSV / Excel（.xlsx）格式。
/// JSON 导出仍由前端完成（无需 Rust 参与），此处仅处理需要二进制写入的格式。
use crate::data_store::DataStore;
use tauri::State;

/// 将历史记录导出为 CSV 文件
#[tauri::command]
pub fn export_history_csv(
    store: State<DataStore>,
    workspace: String,
    path: String,
) -> Result<u32, String> {
    let items = store.get_all_history(&workspace)?;
    let count = items.len() as u32;

    let mut wtr = csv::WriterBuilder::new()
        .has_headers(true)
        .from_path(&path)
        .map_err(|e| format!("无法创建 CSV 文件: {e}"))?;

    // 表头
    wtr.write_record(["时间", "来源", "内容类型", "内容", "标签", "置顶"])
        .map_err(|e| format!("写入表头失败: {e}"))?;

    for item in &items {
        let tags = item
            .tags
            .iter()
            .map(|t| t.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        wtr.write_record([
            item.time.as_str(),
            item.source.as_str(),
            item.content_type.as_deref().unwrap_or(""),
            item.content.as_str(),
            tags.as_str(),
            if item.pinned { "是" } else { "否" },
        ])
        .map_err(|e| format!("写入记录失败: {e}"))?;
    }

    wtr.flush().map_err(|e| format!("刷新 CSV 缓冲失败: {e}"))?;
    Ok(count)
}

/// 将历史记录导出为 Excel（.xlsx）文件
#[tauri::command]
pub fn export_history_xlsx(
    store: State<DataStore>,
    workspace: String,
    path: String,
) -> Result<u32, String> {
    use rust_xlsxwriter::{Format, Workbook, XlsxColor};

    let items = store.get_all_history(&workspace)?;
    let count = items.len() as u32;

    let mut workbook = Workbook::new(&path);
    let sheet = workbook.add_worksheet();
    sheet
        .set_name("剪贴板历史")
        .map_err(|e| format!("设置工作表名失败: {e}"))?;

    // 表头格式：加粗 + 浅灰背景
    let header_fmt = Format::new()
        .set_bold()
        .set_background_color(XlsxColor::RGB(0xF0F4F8));

    // 数据行默认格式
    let default_fmt = Format::new();

    let headers = ["时间", "来源", "内容类型", "内容", "标签", "置顶"];
    for (col, h) in headers.iter().enumerate() {
        sheet
            .write_string(0, col as u16, *h, &header_fmt)
            .map_err(|e| format!("写入表头失败: {e}"))?;
    }

    // 列宽
    let col_widths: [f64; 6] = [20.0, 25.0, 12.0, 60.0, 20.0, 6.0];
    for (col, w) in col_widths.iter().enumerate() {
        let _ = sheet.set_column_width(col as u16, *w);
    }

    // 数据行
    for (row_idx, item) in items.iter().enumerate() {
        let row = (row_idx + 1) as u32;
        let tags = item
            .tags
            .iter()
            .map(|t| t.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");

        let _ = sheet.write_string(row, 0, &item.time, &default_fmt);
        let _ = sheet.write_string(row, 1, &item.source, &default_fmt);
        let _ = sheet.write_string(row, 2, item.content_type.as_deref().unwrap_or(""), &default_fmt);
        let _ = sheet.write_string(row, 3, &item.content, &default_fmt);
        let _ = sheet.write_string(row, 4, &tags, &default_fmt);
        let _ = sheet.write_string(row, 5, if item.pinned { "是" } else { "否" }, &default_fmt);
    }

    workbook
        .close()
        .map_err(|e| format!("保存 Excel 文件失败: {e}"))?;

    Ok(count)
}
