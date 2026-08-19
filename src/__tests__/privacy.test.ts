import { describe, it, expect } from "vitest";
import { detectPrivateText, findPrivateSpans } from "@/lib/screenshot/privacy";

/** 取命中的子串，便于断言「只盖该盖的那一段」 */
const hits = (t: string) => findPrivateSpans(t).map((s) => Array.from(t).slice(s.start, s.end).join(""));

describe("detectPrivateText", () => {
  it("命中手机号（含前缀标点 / 空格 / 分段）", () => {
    expect(detectPrivateText("13800138000")).toBe(true);
    expect(detectPrivateText("电话：13800138000")).toBe(true);
    expect(detectPrivateText("138 0013 8000")).toBe(true);
    expect(detectPrivateText("138-0013-8000")).toBe(true);
  });

  it("命中身份证（末位 X）", () => {
    expect(detectPrivateText("11010119900307123X")).toBe(true);
    expect(detectPrivateText("身份证:11010119900307123x")).toBe(true);
  });

  it("命中银行卡 / 座机 / 邮箱", () => {
    expect(detectPrivateText("6222021234567890123")).toBe(true); // 19 位
    expect(detectPrivateText("010-12345678")).toBe(true);
    expect(detectPrivateText("0755-87654321")).toBe(true);
    expect(detectPrivateText("user@example.com")).toBe(true);
  });

  it("QQ / 微信号需要上下文线索或自带前缀", () => {
    expect(detectPrivateText("QQ:123456")).toBe(true);
    expect(detectPrivateText("QQ号 987654321")).toBe(true);
    expect(detectPrivateText("wxid_abc123def")).toBe(true); // wxid_ 前缀自带身份
    expect(detectPrivateText("微信号：weixin2024x")).toBe(true);
  });

  it("不误伤普通文字 / 纯英文单词", () => {
    expect(detectPrivateText("设置")).toBe(false);
    expect(detectPrivateText("windows")).toBe(false);
    expect(detectPrivateText("settings")).toBe(false);
    expect(detectPrivateText("123")).toBe(false);
    expect(detectPrivateText("截图工具")).toBe(false);
    expect(detectPrivateText("")).toBe(false);
    expect(detectPrivateText("   ")).toBe(false);
  });

  /**
   * 回归：旧实现先 replace(/[^\dXx]/g,"") 抽出纯数字串，再用 QQ 规则
   * `^[1-9]\d{4,10}$` 判，于是任何 5–11 位数字都命中——日期、金额、计数全中招。
   */
  it("回归：裸数字不再被当成 QQ", () => {
    expect(detectPrivateText("2026-08-18")).toBe(false); // 抽成 20260818（8 位）
    expect(detectPrivateText("共 1234 项 合计 56 元")).toBe(false); // 抽成 123456
    expect(detectPrivateText("123456")).toBe(false); // 裸 6 位：订单号的可能性不比 QQ 小
    expect(detectPrivateText("端口 8080")).toBe(false);
  });

  /**
   * 回归：旧微信 ID 规则 `[a-zA-Z][a-zA-Z0-9_-]{5,19}` 只要含 `-` 或 `_` 就算，
   * 与它自己「必须含数字，否则会把界面英文标签全打码」的注释矛盾。
   */
  it("回归：连字符英文词不再被当成微信号", () => {
    expect(detectPrivateText("background-color")).toBe(false);
    expect(detectPrivateText("user-name")).toBe(false);
    expect(detectPrivateText("Claude-Code")).toBe(false);
    expect(detectPrivateText("font-size")).toBe(false);
  });

  it("命中 IPv4 / 车牌", () => {
    expect(detectPrivateText("192.168.1.1")).toBe(true);
    expect(detectPrivateText("IP: 10.0.0.255")).toBe(true);
    expect(detectPrivateText("京A12345")).toBe(true);
    expect(detectPrivateText("粤B12345")).toBe(true);
    expect(detectPrivateText("沪AD12345")).toBe(true); // 新能源 6 位
  });

  it("IPv4 会连同日期/版本号 1.2.3.4 一起盖（预览态可逐框排除，属已知 trade-off）", () => {
    expect(detectPrivateText("版本 1.2.3.4")).toBe(true);
  });

  it("不误伤：车牌需省份简称，裸字母数字串 / 纯中文不中", () => {
    expect(detectPrivateText("ABC12345")).toBe(false);
    expect(detectPrivateText("北京")).toBe(false);
    expect(detectPrivateText("windows")).toBe(false);
  });

  it("命中姓名 / 地址（须带标签）", () => {
    expect(detectPrivateText("姓名：张三")).toBe(true);
    expect(detectPrivateText("收件人：欧阳娜娜")).toBe(true);
    expect(detectPrivateText("地址：北京市朝阳区幸福路 1 号")).toBe(true);
    expect(detectPrivateText("收货地址：上海市浦东新区世纪大道 100 号")).toBe(true);
  });

  it("不误伤：姓名/地址需带标签，裸中文不中", () => {
    expect(detectPrivateText("张三李四")).toBe(false);
    expect(detectPrivateText("北京市朝阳区")).toBe(false);
    expect(detectPrivateText("客户满意度很高")).toBe(false); // 无「客户：」
    expect(detectPrivateText("用户名 admin")).toBe(false);
  });
});

describe("findPrivateSpans", () => {
  it("只圈出命中的那一段，不吃掉整行", () => {
    // 旧实现命中就盖整行，这一行会被整条涂黑
    expect(hits("客服电话 13800138000 工作时间 9:00-18:00")).toEqual(["13800138000"]);
  });

  it("一行里多处命中各自成段", () => {
    const t = "张三 13800138000 邮箱 zhang@a.com";
    expect(hits(t)).toEqual(["13800138000", "zhang@a.com"]);
  });

  it("区间按位置排序且互不重叠", () => {
    const spans = findPrivateSpans("a@b.cn 13800138000 010-12345678");
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
    }
  });

  it("重叠命中会被合并成一段", () => {
    // 18 位身份证同时命中 idcard 与 bankcard，应合并为一段而不是两段
    expect(findPrivateSpans("110101199003071234")).toHaveLength(1);
  });

  it("QQ 只盖号码，不盖提示词", () => {
    expect(hits("QQ:123456")).toEqual(["123456"]);
    expect(hits("微信号：weixin2024x")).toEqual(["weixin2024x"]);
  });

  it("下标是字符下标（与逐字 bbox 对齐），emoji 不会错位", () => {
    const t = "🙂 13800138000";
    const [s] = findPrivateSpans(t);
    expect(Array.from(t).slice(s.start, s.end).join("")).toBe("13800138000");
  });

  it("空输入返回空数组", () => {
    expect(findPrivateSpans("")).toEqual([]);
    expect(findPrivateSpans("没有隐私")).toEqual([]);
  });

  it("多次调用结果稳定（全局正则 lastIndex 已归零）", () => {
    const t = "13800138000";
    expect(findPrivateSpans(t)).toEqual(findPrivateSpans(t));
    expect(findPrivateSpans(t)).toHaveLength(1);
  });

  it("IPv4 / 车牌只圈命中的段（不吃掉整行）", () => {
    expect(hits("车辆 京A12345 备注")).toEqual(["京A12345"]);
    expect(hits("网关 192.168.1.1 端口 80")).toEqual(["192.168.1.1"]);
  });

  it("姓名只圈姓名值不盖标签；地址遇下一字段即截断", () => {
    expect(hits("姓名：张三 工号 001")).toEqual(["张三"]);
    // 一行多字段：地址值遇下一字段截断，收件人/电话也各自被识别（正确协同）
    expect(
      hits("地址：北京市朝阳区幸福路 1 号 收件人：李四 电话：13800138000"),
    ).toEqual(["北京市朝阳区幸福路 1 号", "李四", "13800138000"]);
  });

  it("姓名/地址不认无标签裸值（宁可漏检也不滥报）", () => {
    expect(hits("张三李四 王五")).toEqual([]);
    expect(hits("北京市朝阳区幸福路 1 号")).toEqual([]);
  });
});
