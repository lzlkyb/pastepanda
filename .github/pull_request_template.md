## 变更说明

<!-- 简述本次改动解决了什么问题、用户能感知到什么变化（中文） -->

## 自查清单（提交前逐项勾选）

- [ ] 已先出方案/设计稿并经维护者确认（UI 改动：`design/` 下有 HTML 设计稿）
- [ ] 未修改版本号（`tauri.conf.json` / `Cargo.toml` / `package.json` 均未动）
- [ ] 未构建 exe（`npm run tauri build` 未执行）
- [ ] 新增/修改的 `.tsx` 组件 ≤ 300 行；超标已拆分
- [ ] 公共纯函数已收口到 `src/lib/utils.ts`（未在组件内重复定义）
- [ ] 新增「某类 X 特殊处理」分支已 grep 全同类调用点收口 + 守卫单测
- [ ] 无新增常驻循环/动画；backdrop-filter 未加在重复元素上
- [ ] 反馈与触发在同一可见性域（按钮的成败展示同级可见）
- [ ] 涉及 AI 能力：已过 `ai_enabled` / `aiAvailable` 门控
- [ ] `npx tsc --noEmit` 通过（0 error）
- [ ] `npm run lint` 通过（0 warning）
- [ ] `npx vitest run` 通过（新增逻辑已补单测）
- [ ] `cargo check` / `cargo test` 通过（涉及 Rust 时，记得 `LIBCLANG_PATH`）

## 相关 Issue

<!-- 如有关联 Issue，填 #编号；没有则删掉本节 -->
Closes #
