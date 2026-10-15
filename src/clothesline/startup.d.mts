import { createBridge } from './bridge.mjs';
export function startClothesline(bridge: ReturnType<typeof createBridge>): Promise<(() => void) | undefined>;
