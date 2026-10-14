export interface OriginalPhoto {
  id: string;
  path: string;
  width: number;
  height: number;
}
export function createOriginalCache(read: (photo: OriginalPhoto) => Promise<string>, budget?: number): {
  load: (photo: OriginalPhoto, needed?: () => boolean) => Promise<string>;
  clear: () => void;
  invalidate: (photo: OriginalPhoto) => void;
};
