/**
 * 隐私文本识别（截图「自动打码」用）。
 *
 * 纯函数、可单测。输入 OCR 识别出的一行文本，返回该行里**命中隐私的字符区间**。
 * 仅做文本正则匹配 —— 复用现有离线 PP-OCRv6。人脸需模型（P0 不做）；姓名/地址用「带标签」正则（见下方 RULES），不引入 NER 模型。
 *
 * 覆盖：手机号 / 身份证 / 银行卡 / 座机 / 邮箱 / IPv4 / 车牌 / 姓名（须带 姓名：/收件人： 等标签）/ 地址（须带 地址：/收货地址： 等标签）/ QQ（须带 QQ 字样）/ 微信号（须带微信字样或 wxid_ 前缀）。
 * 不覆盖：人脸（需模型）。姓名/地址只认「标签 + 值」结构，不认无标签裸姓名（与 QQ/微信号同理，宁可漏检也不滥报）。
 *
 * ## 两条设计原则
 *
 * **1. 返回区间而不是布尔。**
 * 旧实现是「整行判定、命中就盖整行」，于是
 * 「客服电话 13800138000 工作时间 9:00-18:00」整行被涂掉，用户想留的部分一起没了。
 * 后端已能给出逐字符 bbox，定位到子串就只盖该盖的那几个字。
 *
 * **2. 分不清的模式必须要上下文线索。**
 * 旧实现有一条 QQ 规则 `^[1-9]\d{4,10}$`，而且是**剥掉所有非数字之后**再判的，
 * 于是任何 5–11 位数字都命中：
 *   `2026-08-18` → 抽成 `20260818` → 命中；`共 1234 项 合计 56 元` → `123456` → 命中。
 * 微信 ID 那条 `[a-zA-Z][\w-]{5,19}` 只要含 `-` 就算，于是 `background-color`、
 * `user-name` 这类词全中——它自己的注释还写着「必须含数字，否则会把界面英文标签全打码」。
 * 一个裸的 6 位数字既可能是 QQ 也可能是订单号，一个裸标识符既可能是微信号也可能是
 * CSS 属性名，**光靠字符串本身无法区分**。所以这两类改为要求邻近出现 QQ / 微信 字样
 * （真实截图里本来就有），或 `wxid_` 这种自带身份的前缀。
 * 宁可漏检也不能滥报：打码预览里全是误报，用户就会直接放弃这个功能。
 */

/** 一段命中区间（`[start, end)`，下标对应传入字符串的字符位置）。 */
export interface PrivateSpan {
  start: number;
  end: number;
  /** 命中的类别，便于调试与将来分级 */
  kind: string;
}

/**
 * 匹配规则表。
 *
 * `group` 指定要打码的捕获组序号（省略 = 整个匹配）。带上下文线索的规则用它
 * 把「QQ:」「微信号：」这类提示词排除在打码范围之外——盖住号码就够了，
 * 把提示词也盖掉反而让人看不懂这里原来是什么。
 */
const RULES: { kind: string; re: RegExp; group?: number }[] = [
  // 手机号：11 位，1[3-9] 开头；也认 138 0013 8000 / 138-0013-8000 这种分段写法
  { kind: "phone", re: /(?<!\d)1[3-9]\d(?:[- ]?\d{4}){2}(?!\d)/g },
  // 身份证：18 位，末位可为 X
  { kind: "idcard", re: /(?<!\d)\d{17}[\dXx](?![\dXx])/g },
  // 银行卡：连续 16–19 位数字。这么长的连续数字极少是普通内容，不额外要求上下文
  { kind: "bankcard", re: /(?<!\d)\d{16,19}(?!\d)/g },
  // 座机：区号 + 号码（横杠可选）
  { kind: "tel", re: /(?<!\d)0\d{2,3}-?\d{7,8}(?!\d)/g },
  // 邮箱
  { kind: "email", re: /[\w.+-]+@[\w-]+\.[\w.-]*\w/g },
  // IPv4：四段点分数字。会连同「版本号 / 日期 1.2.3.4」一起盖——预览态可逐框排除
  { kind: "ip", re: /(?<!\d)\d{1,3}(?:\.\d{1,3}){3}(?!\d)/g },
  // 车牌：省份简称 + 字母 + 5~6 位（含新能源 6 位）。普通文本几乎不会命中，误报低
  { kind: "plate", re: /(?<!\w)[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-Z][A-Z0-9]{5,6}(?!\w)/g },
  // QQ：**必须**带 QQ 字样。裸的 5–11 位数字与订单号/金额/日期无法区分（见文件头）
  { kind: "qq", re: /(?:QQ|qq|Qq)\s*(?:号码?)?\s*[:：]?\s*([1-9]\d{4,10})(?!\d)/g, group: 1 },
  // 微信号：wxid_ 前缀自带身份，可以裸认
  { kind: "wechat", re: /\bwxid_[a-zA-Z0-9_-]{4,}/g },
  // 微信号：带「微信 / 微信号 / WeChat / weixin / VX / v信」提示词时才认后面的标识符
  {
    kind: "wechat",
    re: /(?:微信号|微信|WeChat|wechat|weixin|WX|wx|VX|vx|v信)\s*[:：]?\s*([a-zA-Z][a-zA-Z0-9_-]{5,19})/g,
    group: 1,
  },
  // 姓名：**必须**带标签（姓名：/收件人：/联系人：/投保人：…）。中文姓名无可靠正则，
  // 裸的「张三李四」既是姓名也可能是店名/昵称，与 QQ 同理必须靠上下文线索，否则误报爆炸。
  // 只盖姓名值（group:1），提示词不盖，保留「姓名：」让人看懂这原本是什么。
  {
    kind: "name",
    re: /(?:姓名|收件人|寄件人|发件人|联系人|收货人|投保人|被保险人|持卡人|开户名|户名)\s*[:：]\s*([\u4e00-\u9fa5·]{2,4})/g,
    group: 1,
  },
  // 地址：**必须**带标签（地址：/收货地址：/居住地：/户籍：…）。只盖地址值（group:1）。
  // 值边界：到中文标点或行尾为止；一行多字段时遇到下一个字段标签（收件人/电话/姓名…）即截断，
  // 避免把「地址：X 收件人：Y」整段当地址盖掉。下限 6 字过滤「地址：无」这类噪声。
  {
    kind: "address",
    re: /(?:地址|收货地址|居住地|户籍所在地|户籍|通讯地址|联系地址|家庭住址|公司地址|单位地址)\s*[:：]\s*([^，。；、\n]{6,80}?)(?=\s*(?:收件人|联系人|电话|手机号|姓名|邮编|$|，))/g,
    group: 1,
  },
];

/** 合并重叠/相邻的区间，避免同一段文字被多条规则重复产出。 */
function mergeSpans(spans: PrivateSpan[]): PrivateSpan[] {
  if (spans.length <= 1) return spans;
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: PrivateSpan[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = out[out.length - 1];
    if (cur.start <= last.end) {
      // 重叠：并成一段，类别用先命中的那条（更具体的规则排在前面）
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/**
 * 找出一行文本里所有命中隐私的字符区间（已按位置排序、已合并重叠）。
 *
 * 下标是**字符**下标（`Array.from(text)` 意义上的），与后端逐字符 bbox 一一对应。
 * 注意：JS 正则的 index 是 UTF-16 码元下标，含 emoji / 罕见汉字时会与字符下标错位；
 * 这里先把文本按码点切开再映射回去，保证与 `line.words` 对得上。
 */
export function findPrivateSpans(text: string): PrivateSpan[] {
  if (!text) return [];
  // 码元下标 → 字符下标 的映射表
  const chars = Array.from(text);
  const unitToChar = new Map<number, number>();
  let unit = 0;
  for (let ci = 0; ci < chars.length; ci++) {
    unitToChar.set(unit, ci);
    unit += chars[ci].length;
  }
  unitToChar.set(unit, chars.length); // 末尾哨兵

  /** 把码元下标钳到最近的字符边界（正则可能停在代理对中间，实践中极少见） */
  const toChar = (u: number, fallback: number): number => {
    for (let k = u; k >= 0; k--) {
      const c = unitToChar.get(k);
      if (c !== undefined) return c;
    }
    return fallback;
  };

  const spans: PrivateSpan[] = [];
  for (const rule of RULES) {
    // 规则表是模块级共享的，lastIndex 必须每轮归零，否则第二次调用会从上次的位置续找
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      // 零宽匹配保护：正则写错时不至于死循环
      if (m[0].length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      const g = rule.group ?? 0;
      const hit = m[g];
      if (!hit) continue;
      // 捕获组在整段匹配里的偏移：组内容一定出现在匹配串中，用 indexOf 定位足够
      const off = g === 0 ? 0 : m[0].indexOf(hit);
      const su = m.index + (off < 0 ? 0 : off);
      spans.push({
        kind: rule.kind,
        start: toChar(su, 0),
        end: toChar(su + hit.length, chars.length),
      });
    }
  }
  return mergeSpans(spans);
}

/**
 * 这行里是否含隐私信息。
 *
 * 保留它主要是给「有没有必要往下算」这类快速判断用；真正要打码请用
 * {@link findPrivateSpans}，只盖命中的那一段，别盖整行。
 */
export function detectPrivateText(raw: string): boolean {
  return findPrivateSpans(raw).length > 0;
}
