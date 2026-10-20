/**
 * `glc telnet`: plays a `.gcast` to everyone who connects with `telnet host port`, like towel.blinkenlights.nl.
 * Each connection gets its own player with the usual keys; there is no sound over telnet.
 *
 * @module
 */
import { createServer, type Server, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { playInTerminal, type TerminalOptions } from './terminal.js';

const IAC = 255;
const SB = 250;
const SE = 240;
const NAWS = 31;
// IAC WILL ECHO, IAC WILL SUPPRESS-GO-AHEAD, IAC DO NAWS: character mode without local echo, and window sizes
const HELLO = Buffer.from([IAC, 251, 1, IAC, 251, 3, IAC, 253, NAWS]);

/** Options of `serveTelnet`. */
export interface TelnetOptions extends Omit<TerminalOptions, 'output' | 'input' | 'ffplay'> {
  /** Default 2323. */
  readonly port?: number;
  /** Default `0.0.0.0`. */
  readonly host?: string;
}

const session = (socket: Socket, input: string, options: TelnetOptions): void => {
  const keys = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => keys }) as unknown as NodeJS.ReadStream;
  const output = Object.assign(socket, { isTTY: true, columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream;
  let pending = Buffer.alloc(0);
  socket.on('data', (data: Buffer) => {
    pending = Buffer.concat([pending, data]);
    const plain: number[] = [];
    let at = 0;
    while (at < pending.length) {
      if (pending[at] !== IAC) {
        // Enter arrives as CR NUL or CR LF; the player needs neither
        if (pending[at] !== 0) plain.push(pending[at]!);
        at += 1;
        continue;
      }
      if (at + 1 >= pending.length) break;
      const command = pending[at + 1]!;
      if (command === IAC) {
        plain.push(IAC);
        at += 2;
      } else if (command === SB) {
        const end = pending.indexOf(SE, at);
        if (end < 0) break;
        if (pending[at + 2] === NAWS && end - at >= 8) {
          output.columns = pending.readUInt16BE(at + 3) || 80;
          output.rows = pending.readUInt16BE(at + 5) || 24;
          socket.emit('resize');
        }
        at = end + 1;
      } else if (command >= 251 && command <= 254) {
        if (at + 2 >= pending.length) break;
        at += 3;
      } else at += 2;
    }
    pending = pending.subarray(at);
    if (plain.length > 0) keys.write(Buffer.from(plain));
  });
  socket.on('error', () => socket.destroy());
  socket.write(HELLO);
  // the window size answer usually comes within a moment; start without it if it does not
  setTimeout(() => {
    void playInTerminal(input, { ...options, output, input: keys, ffplay: '' })
      .catch((error: unknown) => socket.write(`\r\nglyphcast: ${error instanceof Error ? error.message : String(error)}\r\n`))
      .finally(() => socket.end());
  }, 300);
};

/** Serves `input` (a `.gcast` file or URL) over telnet. Resolves with the listening server. */
export const serveTelnet = (input: string, options: TelnetOptions = {}): Promise<Server> => {
  const server = createServer((socket) => session(socket, input, options));
  // ponytail: every session adds `exit`/`SIGINT` listeners in the player; fine for a hobby server, move them per session if it runs for weeks
  process.setMaxListeners(0);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 2323, options.host ?? '0.0.0.0', () => resolve(server));
  });
};
