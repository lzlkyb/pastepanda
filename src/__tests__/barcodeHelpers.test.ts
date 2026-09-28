/**
 * 二维码/条码前端纯函数守卫（规则 11.1：收口后必须钉住不变量）。
 *
 * 钉住的关键判据：
 * - getImageBarcodes 的 null 三态与「后端回填优先」（useCardOcr 同款 != null 教训）；
 * - barcodeBadgeLabel 的分段计数与过长截断；
 * - 后端 rxing Display 是**小写**码制名（"qrcode"），所有映射按小写取键；
 * - barcodeBoundingRect 与后端 points 布局（左上→右上→右下→左下）的对应。
 */
import { describe, expect, it } from "vitest";
import {
  barcodeBadgeLabel,
  barcodeBoundingRect,
  barcodeFormatLabel,
  getImageBarcodes,
  isHttpUrl,
  isQrBarcodeFormat,
  joinBarcodeTexts,
  type BarcodeHit,
  type ImageBarcodeState,
} from "@/lib/utils";

const hit = (format: string, text: string): BarcodeHit => ({
  format,
  text,
  points: [[0, 0], [10, 0], [10, 10], [0, 10]],
});

describe("getImageBarcodes（后端优先 + null 三态）", () => {
  it("后端回填 [] = 解码过但无码 → 返回空数组，不被前端状态覆盖", () => {
    const state: ImageBarcodeState = { status: "done", hits: [hit("qrcode", "x")] };
    expect(getImageBarcodes({ barcodes: [] }, state)).toEqual([]);
  });

  it("后端 null（Rust Option::None）→ 前端 done 兜底", () => {
    const state: ImageBarcodeState = { status: "done", hits: [hit("qrcode", "x")] };
    expect(getImageBarcodes({ barcodes: null }, state)?.length).toBe(1);
  });

  it("字段缺失（undefined）同样走兜底——!= null 判据兼容两种序列化差异", () => {
    const state: ImageBarcodeState = { status: "done", hits: [hit("qrcode", "x")] };
    expect(getImageBarcodes({}, state)?.length).toBe(1);
  });

  it("解码中/失败 → null（结论未出，徽章不显示）", () => {
    expect(getImageBarcodes({}, { status: "decode" })).toBeNull();
    expect(getImageBarcodes({}, { status: "fail" })).toBeNull();
  });
});

describe("barcodeBadgeLabel（设计稿① 徽章形态）", () => {
  it("QR + 一维码分段计数", () => {
    expect(barcodeBadgeLabel([hit("qrcode", "a"), hit("code128", "b")])).toBe("▦ QR ×1 · 条码 ×1");
  });

  it("纯 QR", () => {
    expect(barcodeBadgeLabel([hit("qrcode", "a"), hit("datamatrix", "b")])).toBe("▦ QR ×2");
  });

  it("纯一维码", () => {
    expect(barcodeBadgeLabel([hit("ean13", "a")])).toBe("▦ 条码 ×1");
  });

  it("无码/未出结论 → undefined（零可见）", () => {
    expect(barcodeBadgeLabel([])).toBeUndefined();
    expect(barcodeBadgeLabel(null)).toBeUndefined();
  });

  it("未知码制归「码」；三类都有且过长时截断为 `▦ 码 ×n`", () => {
    expect(barcodeBadgeLabel([hit("unknownfmt", "x")])).toBe("▦ 码 ×1");
    const many: BarcodeHit[] = [
      ...Array.from({ length: 9 }, () => hit("qrcode", "a")),
      ...Array.from({ length: 9 }, () => hit("code128", "b")),
      ...Array.from({ length: 2 }, () => hit("unknownfmt", "c")),
    ];
    // "▦ QR ×9 · 条码 ×9 · 码 ×2" 超过 18 字符 ⇒ 截断
    expect(barcodeBadgeLabel(many)).toBe("▦ 码 ×20");
  });
});

describe("码制映射按后端小写 Display（rxing 实测钉住）", () => {
  it("qrcode → QRCode；Code128 形态与设计稿一致", () => {
    expect(barcodeFormatLabel("qrcode")).toBe("QRCode");
    expect(barcodeFormatLabel("code128")).toBe("Code128");
    expect(barcodeFormatLabel("ean13")).toBe("EAN-13");
  });

  it("未知码制大写回显", () => {
    expect(barcodeFormatLabel("rss14")).toBe("RSS14");
  });

  it("isQrBarcodeFormat：2D 为 true，一维为 false", () => {
    expect(isQrBarcodeFormat("qrcode")).toBe(true);
    expect(isQrBarcodeFormat("pdf417")).toBe(true);
    expect(isQrBarcodeFormat("code39")).toBe(false);
  });
});

describe("坐标与拼接", () => {
  it("barcodeBoundingRect 从四角点求包围盒（后端布局：左上→右上→右下→左下）", () => {
    const r = barcodeBoundingRect([[7, 3], [47, 3], [47, 23], [7, 23]]);
    expect(r).toEqual({ x: 7, y: 3, width: 40, height: 20 });
  });

  it("空点集 → null（防御：不让 NaN 进 style）", () => {
    expect(barcodeBoundingRect([])).toBeNull();
  });

  it("joinBarcodeTexts 按行拼接（复制全部/右键菜单共用同一份语义）", () => {
    expect(joinBarcodeTexts([hit("qrcode", "a"), hit("code128", "b")])).toBe("a\nb");
  });

  it("isHttpUrl 只放行 http/https（↗打开链接的门槛）", () => {
    expect(isHttpUrl("https://example.com")).toBe(true);
    expect(isHttpUrl("  http://a.b ")).toBe(true);
    expect(isHttpUrl("6901234567892")).toBe(false);
    expect(isHttpUrl("ftp://a.b")).toBe(false);
  });
});
