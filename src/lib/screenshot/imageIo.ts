/**
 * 截图流程的图片 / 异步 IO 助手。
 *
 * 从 ScreenshotOverlay 抽出来的原因有两个：
 * ① 那个文件破了 claude.md §7 的 300 行上限，这些函数与 React 无关，天然可以外置；
 * ② 它们原来是**模块私有**的，一行单测都写不了 —— 而 withTimeout 的超时与清理、
 *    errText 对非 Error 的处理都是真出过问题的地方。
 *
 * 这里只做纯搬运：函数体与注释保持原样，不改行为。
 */

import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = src;
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 给 IPC 调用加超时。长截图循环里每个 invoke 都必须包。
 *
 * 不包的后果很重：裸 `await` 一旦挂起（目标窗口无响应、后端线程卡死），
 * `finally` 永远不会执行 → `show_screenshot_window` 不会被调用 →
 * 截图窗永久隐藏但进程还在，全屏透明覆盖层还挡着鼠标，只能杀进程。
 */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(`${what} 超时（${ms}ms）`)),
      ms,
    );
    p.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * canvas → **PNG** dataURL。
 *
 * 用 `toBlob` 而不是 `toDataURL`：后者是**同步**的，一张上万像素高的长图
 * 能把主线程卡住好几秒 —— 期间界面完全无响应，看起来就是“卡死了”。
 *
 * ⚠️ 曾经是 JPEG 0.92，已改回无损。原因：用户反馈“截图没有实际图片清晰”，
 * 查出有损压缩叠了两代：后端底图已经是 JPEG q90（且 image 0.25 的 JpegEncoder
 * 写死 4:2:2 色度抽样，与 quality 无关），这里再编一次就是第二代。
 * 屏幕内容（大片纯色 + 大量硬边 + 细文字）恰好是 JPEG 最不擅长的题材，
 * 表现为文字边缘发虚、带彩色镶边。ShareX 默认 PNG 用的就是这个理由。
 *
 * 为什么这里改得起：本函数只在用户点了「完成 / 更多 / 保存 / 贴图」之后跑，
 * PNG 多花的百毫秒级耗时无感；而底图那条路是按下快捷键后的**即时路径**，
 * 不能照搬（用户已经抱怨过一次“截图速度有点慢”），得等 encode_bench 的数字。
 *
 * 落盘不用改：`save_screenshot_image` 走 `image::guess_format` 自动认格式，
 * 会自己存成 .png。
 */
export function canvasToDataUrl(c: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    c.toBlob((blob) => {
      if (!blob) {
        reject(new Error("canvas 编码失败"));
        return;
      }
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as string);
      fr.onerror = () => reject(fr.error ?? new Error("读取编码结果失败"));
      fr.readAsDataURL(blob);
    }, "image/png");
  });
}

/**
 * 合成图落盘：编码 → 保存 → **撤销 OCR 临时登记**。
 *
 * 第三步不能漏。`save_screenshot_image` 是 md5 去重的，而提前 OCR 存的是选区原图；
 * 用户没画标注时结果图与选区原图像素一致 → md5 相同 → 拿到的是**同一个路径**。
 * 不撤销登记的话关窗时 `purge_ocr_temp` 会把它删掉，卡片就指向一个不存在的文件
 * （界面上表现为「图片加载失败」）。
 *
 * 收口在这里而不是在两个调用点各写一遍：finalizeCanvas（长截图/普通完成）与
 * ensureResultPath（完成/更多/保存/贴图）都要落盘，漏一处就是同一个 bug（规则 11.1）。
 */
export async function saveResultImage(
  out: HTMLCanvasElement,
): Promise<{ path: string; dataUrl: string }> {
  const dataUrl = await canvasToDataUrl(out);
  const path = await withTimeout(
    invoke<string>("save_screenshot_image", { dataBase64: dataUrl }),
    15000,
    "保存截图",
  );
  // 失败不能影响主流程：撤销登记没成功最坏是多留一个临时文件，
  // 而抛出去会让「完成」整个失败。
  void invoke("unmark_ocr_temp", { path }).catch((e) =>
    logger.warn("撤销 OCR 临时登记失败（图片可能被误清理）", e),
  );
  // 一并把已经编码好的 dataUrl 送出去：谁要是还需要一份图的 URL（贴图浮动预览），
  // 直接用这份，不要再调 canvas.toDataURL()——那个是同步编码，长图能卡住主线程好几秒。
  return { path, dataUrl };
}

/** 把一帧缩成 26×40 的小图给状态窗。每帧一次这个尺寸的 JPEG 编码，成本可忽略。 */
export function thumbOf(c: HTMLCanvasElement): string | null {
  try {
    const t = document.createElement("canvas");
    t.width = 26;
    t.height = 40;
    const tx = t.getContext("2d");
    if (!tx) return null;
    tx.drawImage(c, 0, 0, 26, 40);
    return t.toDataURL("image/jpeg", 0.6);
  } catch {
    return null; // 缩略图失败不能影响长截图本身
  }
}

/** 把未知异常转成一句可读文本（Tauri invoke 抛的常常是字符串而不是 Error） */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}
