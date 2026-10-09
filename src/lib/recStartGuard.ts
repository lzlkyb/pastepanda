/** A timed-out invoke keeps running; stop/save it before presenting a retry. */
export async function startRecordingWithWatchdog(
  start: () => Promise<void>,
  stopAndSave: () => Promise<void>,
  timeoutMs = 12_000,
): Promise<void> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      start(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("启动录制超时，已请求停止并保存，请稍后重试"));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (timedOut) await stopAndSave().catch(() => {});
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
