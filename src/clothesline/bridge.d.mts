export interface Photo {
  id: string;
  path: string;
  name: string;
  source: string;
  width: number;
  height: number;
  aspect?: number;
  url?: string;
  weight?: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Pin {
  point?: [number, number];
  force?: boolean;
  hwnd: number;
  generation: number;
  path: string;
  rect: Rect;
}
export interface Snapshot {
  items: Photo[];
  enabled: boolean;
  wind: boolean;
  locked: boolean;
  anchors: unknown;
  workArea: Rect;
  scale: number;
}
export interface Callbacks {
  update: (snapshot: Snapshot) => unknown;
  visible: (value: boolean) => unknown;
  hover: (value: boolean) => unknown;
  pinPreview: (pin: Pin | null) => unknown;
  pinDrop: (pin: Pin) => unknown;
  pinClosed: (pin: Pin) => unknown;
  dismissPreview: () => unknown;
}
export function createBridge(): {
  safe: (promise: Promise<unknown>) => Promise<unknown>;
  logical: (rect: Rect) => Rect;
  physical: (rect: Rect) => Rect;
  prepare: (photo: Photo, retry?: boolean) => Promise<Photo>;
  original: (photo: Photo) => Promise<string>;
  snapshot: () => Promise<Snapshot>;
  subscribe: (callbacks: Callbacks) => Promise<void>;
  ready: () => Promise<void>;
  reportError: (message: string) => Promise<void>;
  focusPreview: () => Promise<void>;
  regions: (regions: Rect[], dragging: boolean) => Promise<unknown>;
  config: (config: Record<string, unknown>) => Promise<void>;
  remove: (ids: string[]) => Promise<void>;
  restore: (items: Photo[]) => Promise<void>;
  order: (ids: string[]) => Promise<void>;
  idle: () => Promise<unknown>;
  take: (item: Photo, rect: Rect) => Promise<Pin>;
  dragTake: (item: Photo, rect: Rect) => Promise<Pin>;
  startDrag: (pin: Pin, rect: Rect, held: boolean, point?: { x: number; y: number }) => Promise<Pin>;
  showPin: (pin: Pin) => Promise<void>;
  closePin: (pin: Pin) => Promise<void>;
  returnPin: (pin: Pin, id: string, slot: number) => Promise<Photo>;
  photoForPin: (pin: Pin, id?: string) => Promise<Photo>;
  manager: () => Promise<unknown>;
  dispose: () => void;
};
