declare module "qrcode-terminal" {
  const qrcodeTerminal: {
    generate(
      text: string,
      options?: { small?: boolean },
      callback?: (qrCode: string) => void,
    ): void;
  };
  export default qrcodeTerminal;
}

declare module "ws" {
  import type { Duplex } from "node:stream";

  export type RawData = Buffer | ArrayBuffer | Buffer[];

  export interface ClientOptions {
    perMessageDeflate?: boolean;
    createConnection?: () => Duplex;
  }

  export default class WebSocket {
    static readonly OPEN: number;
    readonly readyState: number;

    constructor(address: string, options?: ClientOptions);

    send(data: string): void;
    terminate(): void;
    once(event: "open", listener: () => void): this;
    on(event: "message", listener: (data: RawData) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  }

  export class WebSocketServer {
    constructor(options: { server: import("node:http").Server });
    on(event: "connection", listener: (socket: WebSocket) => void): this;
    close(callback: (error?: Error) => void): void;
  }
}
