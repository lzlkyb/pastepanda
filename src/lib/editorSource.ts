import { invoke } from "@tauri-apps/api/core";
import { isToolItemId } from "./toolEditors";

/** Tool drafts have no database row. Explicit saves share the small editor's clipboard target. */
export async function persistEditorSource(id: string, text: string): Promise<"clipboard" | "history"> {
  if (isToolItemId(id)) {
    await navigator.clipboard.writeText(text);
    return "clipboard";
  }
  await invoke("update_history", { id, text });
  return "history";
}
