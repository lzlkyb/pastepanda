export interface Item {
  id: string;
  aspect: number;
  weight?: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface Anchors {
  left: Point;
  right: Point;
}
export interface Geometry {
  left: number;
  right: number;
  span: number;
  anchors: Anchors;
  cards: { item: Item; x: number; iw: number; ih: number; width: number; height: number }[];
  queued: number;
}
export const WIND_TIMING: { lead: number; flight: number; stagger: number };
export function defaultAnchors(width: number): Anchors;
export function constrainAnchors(anchors: Anchors, side: "left" | "right", width: number, height?: number): Anchors;
export function moveAnchors(anchors: Anchors, dx: number, dy: number, width: number, height?: number): Anchors;
export function layout(width: number, items: Item[], anchors?: Anchors): Geometry;
export function equilibrium(geometry: Geometry, strength?: number): number[];
export function ropePoint(geometry: Geometry, curve: number[], t: number): Point;
export function springProgress(seconds: number): number;
export function canSettle(state: {
  enabled: boolean;
  hidden: boolean;
  reduced: boolean;
  dragging: boolean;
  preview: boolean;
}): boolean;
export function insertAtSlot<T extends Item>(items: T[], item: T, slot: number, capacity: number): T[];
