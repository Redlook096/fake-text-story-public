declare module 'html2canvas' {
  const html2canvas: (element: HTMLElement, options?: any) => Promise<HTMLCanvasElement>;
  export default html2canvas;
}

declare module '@ffmpeg/ffmpeg' {
  export class FFmpeg {
    load(options?: any): Promise<void>;
    writeFile(path: string, data: Uint8Array | string): Promise<void>;
    readFile(path: string): Promise<Uint8Array>;
    exec(args: string[]): Promise<void>;
  }
}


