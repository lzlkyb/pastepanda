# Remote Computer A2 Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current duplicated remote-computer home/navigation shell with the approved device-first A layout while preserving every existing remote-control capability and inheriting PastePanda's real themes.

**Architecture:** Keep `useRc`, request/session/file hooks, and the existing stage/session components as the behavioral layer. Add a thin A2 shell composed of a title/status bar, one persistent device/tool sidebar, a selected-device detail surface, and the existing file/history/settings/session surfaces. New A2 CSS consumes only the application's semantic theme tokens so `ocean`, `ocean-dark`, and `blossom` work without component branches.

**Tech Stack:** React 19, TypeScript, CSS Modules, Vitest, Testing Library, Tauri WebView2.

**Spec:** `design/远程电脑-设备优先Windows工作台-A方案-设计稿.html`

## Global Constraints

- Do not change remote protocol, Rust commands, persistence keys, or authorization semantics.
- Do not change `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, or any version number.
- Do not build an exe; use focused Vitest, TypeScript/build, CSS lint, and Tauri dev only if already running.
- No new `.tsx` component may exceed 300 lines.
- Reuse the existing `RcStage`, `RcSessionView`, `RcPageFiles`, `RcPageHistory`, and `RcPageSettings` behaviors.
- All new visible icon actions have persistent text labels; all focusable controls retain `:focus-visible`.
- New A2 colors consume `--app-bg`, `--section-bg`, `--card-bg`, `--text-*`, `--accent-*`, `--border-color`, and existing semantic status tokens.

## Review Focus

- Zero paired devices must route the primary device surface to pairing without exposing dead connection actions.
- A stale selected device id must fall back to the first current target and never render an empty detail pane.
- Pending and inbound sessions must remain visible even when a secondary tool page was selected previously.
- Outbound active sessions must recover the full canvas width and retain the existing end-session path.
- Theme changes must not make selected rows, primary buttons, destructive actions, or focus rings disappear in `ocean-dark` or `blossom`.

---

### Task 1: A2 selection and surface model

**Files:**
- Create: `src/lib/rcWorkbenchA2.ts`
- Create: `src/__tests__/rcWorkbenchA2.test.ts`

**Interfaces:**
- Produces: `RcA2Page`, `resolveRcA2Selection(targets, selectedId)`, and `resolveRcA2Surface(mode, page)`.
- Consumes: `WbMainMode` from `src/lib/rcWorkbench.ts`.

- [ ] **Step 1: Write failing tests** for first-target fallback, stale-id fallback, empty targets, pending/inbound override, and outbound full-session override.
- [ ] **Step 2: Run `npm test -- src/__tests__/rcWorkbenchA2.test.ts`** and verify failure is caused by the missing module.
- [ ] **Step 3: Implement the minimal pure functions** with pages `devices | files | history | settings`.
- [ ] **Step 4: Re-run the focused test** and verify all cases pass.

### Task 2: Device-first sidebar and device detail

**Files:**
- Create: `src/components/rc/RcA2Sidebar.tsx`
- Create: `src/components/rc/RcA2DeviceDetail.tsx`
- Create: `src/components/rc/RcA2Workbench.test.tsx`
- Create: `src/components/rc/RemoteComputerA2.module.css`

**Interfaces:**
- Consumes: `RcA2Page`, `RcTargetDevice`, the selected peer id, navigation callbacks, existing request/file/pair callbacks.
- Produces: accessible device selection, explicit `连接并控制`, `只看`, `传文件`, `添加设备`, and bottom tool navigation actions.

- [ ] **Step 1: Write failing component tests** proving row selection does not connect, explicit connect buttons call the correct capability, the empty sidebar exposes `添加设备`, and all four tool destinations are reachable with visible labels.
- [ ] **Step 2: Run `npm test -- src/components/rc/RcA2Workbench.test.tsx`** and verify missing components are the failure.
- [ ] **Step 3: Implement the sidebar and detail components** under 300 lines each, reusing device/presence helpers from `src/lib/rcDevice.ts`.
- [ ] **Step 4: Add minimal layout styles** backed by PastePanda semantic variables; no theme-name selectors in component CSS.
- [ ] **Step 5: Re-run the component tests** and verify they pass.

### Task 3: Integrate the A2 shell into the real workbench

**Files:**
- Create: `src/components/rc/RcA2TitleBar.tsx`
- Modify: `src/components/rc/RcWorkbench.tsx`
- Modify: `src/components/rc/RemoteComputerA2.module.css`
- Test: `src/components/rc/RcA2Workbench.test.tsx`

**Interfaces:**
- Consumes: existing `useRc`, `useRcLaunch`, `RcStage`, file/history/settings pages, and Task 1/2 components.
- Produces: one device-first non-session shell and one canvas-first active-session shell.

- [ ] **Step 1: Extend the failing integration test** to require device page default, pending/inbound session priority, and the active-session canvas class.
- [ ] **Step 2: Run the focused test** and verify the old shell fails the A2 assertions.
- [ ] **Step 3: Replace `RcNavRail`/`RcTopBar` mounting in `RcWorkbench`** with the A2 titlebar/sidebar/content composition while preserving all existing callbacks and overlays.
- [ ] **Step 4: Keep `RcStage` authoritative for pending, inbound, outbound, errors, and session termination.**
- [ ] **Step 5: Run focused remote tests**: `npm test -- src/components/rc/RcA2Workbench.test.tsx src/lib/rcWorkbench.test.ts src/__tests__/rcDeviceList.test.tsx src/components/rc/RcHud.test.tsx src/components/rc/RcViewTools.test.tsx`.

### Task 4: Theme fidelity and verification

**Files:**
- Modify: `src/components/rc/RemoteComputerA2.module.css`
- Modify: `src/components/rc/RemoteComputer.module.css` only where existing child surfaces need semantic-token corrections.
- Test: `src/__tests__/rcA2ThemeTokens.test.ts`

**Interfaces:**
- Consumes: global variables from `src/styles/theme.css` and `data-theme` application in `src/rc-main.tsx`.
- Produces: the same A2 hierarchy under `ocean`, `ocean-dark`, and `blossom` without hard-coded theme palettes.

- [ ] **Step 1: Write a failing token guard test** that rejects theme-name selectors, new raw hex colors, gradients, and `backdrop-filter` in `RemoteComputerA2.module.css`, while requiring the core PastePanda variables.
- [ ] **Step 2: Run `npm test -- src/__tests__/rcA2ThemeTokens.test.ts`** and verify it fails before the stylesheet is complete.
- [ ] **Step 3: Finish semantic styles** for light/dark/feature themes, selected/focus/disabled/destructive states, and the canvas boundary.
- [ ] **Step 4: Run `npm run lint:css`, `npm run build`, and the complete `npm test` suite.**
- [ ] **Step 5: Open the real workbench and visually inspect device, empty/pairing, pending, session, inbound, files, history, and settings in `ocean`, `ocean-dark`, and `blossom`; fix only blocking visual regressions.**

