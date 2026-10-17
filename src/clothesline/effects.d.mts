export interface Capture {
  copy: HTMLElement;
  bounds: { x: number; y: number; w: number; h: number };
  imageBounds?: Capture["bounds"];
  aspect?: number;
}
export function createEffects(options: { stage: HTMLElement; layer: HTMLElement; reduced: () => boolean }): {
  capture: (element: HTMLElement | null) => Capture | null;
  rect: (element: HTMLElement) => Capture["bounds"];
  transfer: (
    id: string,
    source: Capture | null,
    destination: HTMLElement | null,
    mode: "pin" | "hang",
    dragged?: boolean,
  ) => Promise<boolean>;
  gale: (id: string, source: Capture | HTMLElement | null, index: number, release: () => void) => Promise<boolean>;
  cancel: (id: string) => void;
  cancelAll: () => void;
};
