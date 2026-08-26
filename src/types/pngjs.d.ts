declare module "pngjs" {
  export class PNG {
    static sync: {
      read(buffer: Buffer): { width: number; height: number; data: Buffer };
      write(png: PNG): Buffer;
    };
    constructor(opts: { width: number; height: number });
    data: Buffer;
    width: number;
    height: number;
  }
}
