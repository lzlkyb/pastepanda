/**
 * rcCapability — 「这一档能不能动键鼠」的**唯一**判据（规则 #11.1）。
 *
 * 收口前 `x === "control"` 这个比较在十几个文件里各写一遍，文案又各自 ternary
 * （「可控」「可控（含只看）」「看屏幕 + 控制键鼠」…）。
 * **文案允许不同**（长短各有用途，条各归其位），**判定必须只有一份**：
 * 将来加第三档（例如「只读剪贴板」）时，漏掉一处的失败方式不是编译报错，
 * 而是那一处把新档**当成「可控」或「只看」**用——前者是功能坏了，
 * 后者是隐私事故（对方以为只能看，实际能操作键鼠）。
 *
 * 🔴 未知值一律按保守的一侧（「只看」）。这不是防御式编程：历史行的
 * `capability` 来自磁盘，老版本 / 半写坏的记录都可能给出任意字符串，
 * 而这些地方**没有类型系统兜底**（`RcHistoryRow.capability: string`）。
 */
import type { RcCapability } from "@/lib/api/rcTypes";

/** 只有明确是「可控」才算能操作键鼠；其他一切值（含 null/未知）都算「只看」。 */
export function rcCanControl(cap: RcCapability | string | null | undefined): boolean {
  return cap === "control";
}

/** 归一到两档之一：给 `data-cap` 这类只认两档的下游（色调、再次连接的预填）。 */
export function rcCapTone(cap: RcCapability | string | null | undefined): RcCapability {
  return rcCanControl(cap) ? "control" : "view";
}

/** HUD / 列表用的两字短文案。要说全信息的长文案各组件自己写（见文件头）。 */
export function rcCapShort(cap: RcCapability | string | null | undefined): string {
  return rcCanControl(cap) ? "可控" : "只看";
}
