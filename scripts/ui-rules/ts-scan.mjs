/**
 * TS/TSX 侧扫描（TypeScript Compiler API，不是正则）。
 *
 * 用 AST 的原因：L2（图标按钮有没有常驻文字）与 U3.5（catch 里是不是只有日志）
 * 都是**结构性**判断——正则写法在注释、字符串、嵌套里都会误判，
 * 而这两条恰恰是最容易被误报抵制的两条：误报一次，人就再也不看输出。
 */
import ts from "typescript";
import {
  RADII,
  FONT_SIZES,
  SPACINGS,
  COLOR_NAME_VARS,
  RAW_COLOR_FILES,
} from "./rules.mjs";

const LOG_CALLEE = /^(logger|console|log|toast|showToast|notify)$/;
const LOG_METHOD = /^(trace|debug|info|log|warn|error)$/;
const TOAST_LIKE = /^(toast|showToast|notify)/i;

/** `logger.warn` / `console.error` / `logger` 都算「只是记了一笔」 */
function calleeText(expr, sf) {
  if (ts.isPropertyAccessExpression(expr)) {
    const head = expr.expression.getText(sf);
    return { head, member: expr.name.getText(sf) };
  }
  return { head: expr.getText(sf), member: null };
}

function isLogOnlyCall(expr, sf) {
  if (!ts.isCallExpression(expr)) return false;
  const { head, member } = calleeText(expr.expression, sf);
  if (TOAST_LIKE.test(head)) return true;
  if (member && LOG_METHOD.test(member) && (LOG_CALLEE.test(head) || /log/i.test(head))) return true;
  if (!member && LOG_CALLEE.test(head)) return true;
  return false;
}

/** 往上找包住这个节点的函数 */
function enclosingFunction(node) {
  let p = node.parent;
  while (p && !ts.isFunctionLike(p) && !ts.isSourceFile(p)) p = p.parent;
  return p && ts.isFunctionLike(p) ? p : null;
}

function containsAwait(node) {
  if (ts.isAwaitExpression(node)) return true;
  let hit = false;
  const scan = (n) => {
    if (hit) return;
    if (ts.isAwaitExpression(n)) { hit = true; return; }
    ts.forEachChild(n, scan);
  };
  ts.forEachChild(node, scan);
  return hit;
}

/**
 * 这个函数体里有没有 `setXxx(await …)`——即「把异步结果写进状态」。
 *
 * 🔴 这一步是 U3.5 精度的全部来源。不加它，规则退化成「catch 里只有日志就报」，
 * 于是 `catch { logger.warn("应用主题失败") }` 这种**根本没有空态可落**的也一起报
 * （2026-09-22 实测 245 处，其中绝大多数是这个）。
 * 误报一次，人就再也不看输出——所以判定必须贴着文档原句：
 * 「失败后的渲染结果与『真的没数据』不可区分」。
 */
function hasAwaitedStateAssign(fn, sf) {
  if (!fn || !fn.body) return false;
  let found = false;
  const scan = (n) => {
    if (found || ts.isCatchClause(n)) return; // catch 自己不算
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      if (/^(set|update)[A-Z_]/.test(callee) && n.arguments.some(containsAwait)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, scan);
  };
  ts.forEachChild(fn.body, scan);
  return found;
}

/** 空态文案：只写「暂无X」= 浪费了教学位 */
const BARE_EMPTY = /^暂无(数据|内容|记录|结果|项目|文件|匹配|条目)$/;
const SOFT_EMPTY = /^暂无/;
const HAS_NEXT_STEP = /(点击|试试|新建|添加|导入|清|选择|拖动|按)/;

export function scanTs(file, text, inScopeLine, hasAllow, relPath) {
  const isTsx = /\.tsx$/.test(file);
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings = [];
  const stats = { inlineStyle: 0 };
  const skipRawColor = RAW_COLOR_FILES.some(([p]) => relPath === p);

  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const push = (rule, node, snippet) => {
    const line = typeof node === "number" ? node : lineOf(node);
    if (!inScopeLine(line)) return;
    if (hasAllow(line)) return;
    findings.push({ rule, line, snippet });
  };
  const text9 = (node) => node.getText(sf).replace(/\s+/g, " ").slice(0, 110);

  /**
   * L2 用：这个 JSX 节点是否**一定没有**可读文字。
   *
   * 只认「确定的图标」——`svg`、自闭合元素、`{null}`/`{false}`/`{undefined}`、空白文本。
   * 其余表达式（`{o.label}`、`{a ? "x" : "y"}`）静态判不出来，一律**按有文字处理**：
   * 反向的代价（把有文案的按钮报成图标按钮）实测出现过两次（`RcControlBanner` 的
   * 音频开关、`RcDropdown` 的选项），假警报一多，这条提示就没人看了。
   * 条件表达式递归看两个分支，所以 `{on ? <VolumeX/> : <Volume2/>}` 仍会被认出是图标按钮，
   * 而 `{on ? "恢复" : "停用"}` 不会。非 `svg` 的 JSX 元素递归看 children。
   */
  function isTextlessExpr(e) {
    if (!e) return true; // {/* 注释 */}
    if (e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return true;
    if (ts.isIdentifier(e) && e.text === "undefined") return true;
    if (ts.isConditionalExpression(e)) {
      return isTextlessExpr(e.whenTrue) && isTextlessExpr(e.whenFalse);
    }
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e)) return isTextlessJsx(e);
    return false;
  }

  function isTextlessJsx(n) {
    if (ts.isJsxSelfClosingElement(n)) return true; // 自闭合 ⇒ 没有 children
    if (n.openingElement.tagName.getText(sf) === "svg") return true;
    return n.children.every(isTextlessChild);
  }

  function isTextlessChild(c) {
    if (ts.isJsxText(c)) return c.text.trim().length === 0;
    if (ts.isJsxExpression(c)) return isTextlessExpr(c.expression);
    if (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) return isTextlessJsx(c);
    return false;
  }

  /** style 对象里的数值属性（U5） */
  function checkStyleObject(obj) {
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const name = prop.name.getText(sf).replace(/['"]/g, "");
      const init = prop.initializer;
      const isNum = ts.isNumericLiteral(init);
      const isStr = ts.isStringLiteral(init);
      if (!isNum && !isStr && !ts.isPrefixUnaryExpression(init)) continue;
      const valueText = init.getText(sf);
      const numeric = isNum ? Number(init.text) : isStr ? parseFloat(valueText.replace(/['"]/g, "")) : NaN;

      if (/^(borderRadius|fontSize|borderTopLeftRadius|borderTopRightRadius|borderBottomLeftRadius|borderBottomRightRadius)$/.test(name)) {
        if (Number.isFinite(numeric)) {
          const table = name === "fontSize" ? FONT_SIZES : RADII;
          if (!table.includes(numeric)) {
            push(name === "fontSize" ? "U5font" : "U5radius", prop, `style={{ ${name}: ${valueText} }}`);
          }
        }
      }
      if (/^(gap|rowGap|columnGap|padding|margin|paddingTop|paddingBottom|paddingLeft|paddingRight|marginTop|marginBottom|marginLeft|marginRight)$/.test(name)) {
        if (Number.isFinite(numeric) && numeric !== 0 && !SPACINGS.includes(numeric)) {
          push("U5space", prop, `style={{ ${name}: ${valueText} }}`);
        }
      }
      if (/^(transition|animation)$/.test(name) && isStr) {
        for (const m of valueText.matchAll(/(?<![\w.#-])(\d*\.?\d+)(ms|s)\b/g)) {
          const ms = m[2] === "s" ? Number(m[1]) * 1000 : Number(m[1]);
          if (ms === 0) continue;
          if (ms >= 1000 && name === "animation") continue;
          if (![150, 200, 300, 400].includes(ms)) {
            push("U2", prop, `style={{ ${name}: ${valueText} }}`);
          }
        }
      }
    }
  }

  function visit(node) {
    // ── U8 内联 style + U5/U2 内联值 ─────────────────────────
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === "style") {
      const init = node.initializer;
      if (init && ts.isJsxExpression(init) && init.expression && ts.isObjectLiteralExpression(init.expression)) {
        const line = lineOf(node);
        if (inScopeLine(line) && !hasAllow(line)) stats.inlineStyle++;
        push("U8", node, `<… style={{ … }} />`);
        checkStyleObject(init.expression);
      }
    }

    // ── V3 / U6 / L3：字符串字面量 ────────────────────────────
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const v = node.text;
      if (/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v.trim()) || /#[0-9a-fA-F]{6}\b/.test(v)) {
        if (!skipRawColor) push("V3", node, `字符串色值 "${v.slice(0, 40)}"`);
      }
      for (const m of v.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (COLOR_NAME_VARS.test(m[1])) push("U6", node, `"${v.slice(0, 60)}" → var(${m[1]})`);
      }
      if (BARE_EMPTY.test(v.trim())) push("L3", node, `空态文案「${v.trim()}」——没有「怎么让它不出现」`);
      else if (SOFT_EMPTY.test(v.trim()) && !HAS_NEXT_STEP.test(v)) {
        push("L3", node, `空态文案「${v.trim()}」——看不出下一步`);
      }
    }

    // ── U3.5 catch 只记日志、又确实会落到空态 ─────────────────
    if (ts.isCatchClause(node) && node.block && node.block.statements.length) {
      const stmts = node.block.statements.filter((s) => !ts.isEmptyStatement(s));
      const onlyLog = stmts.length > 0 && stmts.every((s) => {
        if (ts.isReturnStatement(s)) return !s.expression;
        if (!ts.isExpressionStatement(s)) return false;
        const e = s.expression;
        if (ts.isAwaitExpression(e)) return isLogOnlyCall(e.expression, sf);
        return isLogOnlyCall(e, sf);
      });
      const fn = enclosingFunction(node);
      if (onlyLog && hasAwaitedStateAssign(fn, sf)) {
        push("U3_5", node, `catch 只记了日志/弹了 toast，而同函数里有 setXxx(await …)：${text9(node.block).slice(0, 80)}`);
      }
    }

    // ── L2 图标按钮只有 title ────────────────────────────────
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      if (opening.tagName.getText(sf) === "button") {
        const attrs = opening.attributes.properties.filter(ts.isJsxAttribute);
        const hasTitle = attrs.some((a) => a.name.getText(sf) === "title");
        const hasAria = attrs.some((a) => a.name.getText(sf) === "aria-label");
        if (hasTitle && !hasAria) {
          const children = ts.isJsxElement(node) ? node.children : [];
          if (children.every(isTextlessChild)) {
            push("L2", node, `<button title="…"> 没有常驻文字`);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return { findings, stats };
}
