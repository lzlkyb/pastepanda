/**
 * localStorage 旧命名迁移（修复 Low：残留 pasteship_* 旧应用名键）
 * 应用更名为 PastePanda 后，历史版本写入的 pasteship_* 键需要迁移到 pastepanda_*，
 * 直接改名会导致老用户"已显示过的提示"状态丢失、提示重复弹出，因此做一次性搬移：
 * 读取旧键值 → 写入新键 → 删除旧键。新键已存在时优先保留新键。
 */
const LEGACY_KEY_MAP: Record<string, string> = {
  pasteship_install_day: "pastepanda_install_day",
  pasteship_shown_tips: "pastepanda_shown_tips",
  pasteship_hidden_tip_shown: "pastepanda_hidden_tip_shown",
};

let migrated = false;

export function migrateLegacyStorageKeys(): void {
  if (migrated) return;
  migrated = true;
  try {
    for (const [oldKey, newKey] of Object.entries(LEGACY_KEY_MAP)) {
      const oldValue = localStorage.getItem(oldKey);
      if (oldValue === null) continue;
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, oldValue);
      }
      localStorage.removeItem(oldKey);
    }
  } catch {
    /* localStorage 不可用时忽略，功能降级为默认行为 */
  }
}
