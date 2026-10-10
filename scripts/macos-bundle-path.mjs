import path from "node:path";
// Resolve the same target/name overrides passed to Tauri. Repairing a different
// debug bundle would invalidate the old app's already-approved privacy signature.
export function debugBundlePath(targetDir, defaultName, args, readConfig) {
  let target, name = defaultName;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target") target = args[++i];
    else if (args[i].startsWith("--target=")) target = args[i].slice(9);
    else if (args[i] === "--config" || args[i].startsWith("--config=")) {
      const value = args[i] === "--config" ? args[++i] : args[i].slice(9);
      if (!value) throw new Error("Missing Tauri config value");
      const config = JSON.parse(value.trim().startsWith("{") ? value : readConfig(value));
      if (config.productName !== undefined) name = config.productName;
    }
  }
  if (typeof name !== "string" || !name || /[\/\\\x00]/.test(name)) throw new Error("Invalid bundle product name");
  if (target && !/^[a-z0-9_-]+$/.test(target)) throw new Error("Invalid target triple");
  return path.join(targetDir, ...(target ? [target] : []), "debug/bundle/macos", `${name}.app`);
}
