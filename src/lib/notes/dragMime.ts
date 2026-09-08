/**
 * 笔记拖拽载荷的 MIME。
 *
 * 自定义类型而不是 `text/plain`：后者会让笔记能被拖进任何输入框，
 * 而我们只想让它能拖进文件夹。
 *
 * ❗ 单独一个文件而不是留在 `NoteList.tsx` 里（2026-09-07）：
 *   它有三个消费者（`NoteList` / `NoteCard` / `FolderTree`），而 `NoteCard`
 *   又是 `NoteList` 导入的 ⇒ 两者互相 import，**循环依赖**。
 *   常量只在渲染期读，目前跑得起来；但本项目有过 Vite dev 模块图
 *   返回空模块的历史，而循环依赖正是那类问题的典型诱因——不值得赌。
 */
export const NOTE_DRAG_MIME = "application/x-pastepanda-notes";
