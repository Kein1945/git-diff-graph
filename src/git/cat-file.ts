import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

interface Request {
  resolve: (buf: Buffer | undefined) => void;
}

/**
 * Reads many blobs through one long-lived `git cat-file --batch` process instead of spawning
 * `git show` per file (which costs ~20 ms each on Windows).
 */
export class CatFile {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private queue: Request[] = [];
  private buffer = Buffer.alloc(0);
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(private readonly cwd: string) {}

  read(ref: string, file: string): Promise<Buffer | undefined> {
    const proc = this.ensure();
    clearTimeout(this.idleTimer);
    return new Promise((resolve) => {
      this.queue.push({ resolve });
      proc.stdin.write(`${ref}:${file}\n`);
    });
  }

  close(): void {
    clearTimeout(this.idleTimer);
    this.proc?.stdin.end();
    this.proc = undefined;
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    const proc = spawn('git', ['cat-file', '--batch'], { cwd: this.cwd, windowsHide: true });
    proc.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    const fail = () => {
      for (const r of this.queue.splice(0)) r.resolve(undefined);
      this.proc = undefined;
      this.buffer = Buffer.alloc(0);
    };
    proc.on('exit', fail);
    proc.on('error', fail);
    proc.stdin.on('error', fail);
    this.proc = proc;
    return proc;
  }

  private drain(): void {
    for (;;) {
      const nl = this.buffer.indexOf(10);
      if (nl < 0 || !this.queue.length) break;
      const header = this.buffer.subarray(0, nl).toString('utf8');
      // "<sha> <type> <size>" or "<name> missing" / "<name> ambiguous"
      const m = /^\S+ (\S+) (\d+)$/.exec(header);
      if (!m) {
        this.buffer = this.buffer.subarray(nl + 1);
        this.queue.shift()!.resolve(undefined);
        continue;
      }
      const size = Number(m[2]);
      if (this.buffer.length < nl + 1 + size + 1) break; // wait for the rest of the body
      const body = this.buffer.subarray(nl + 1, nl + 1 + size);
      this.buffer = this.buffer.subarray(nl + 1 + size + 1);
      this.queue.shift()!.resolve(m[1] === 'blob' ? Buffer.from(body) : undefined);
    }
    if (!this.queue.length) {
      // Let the process go when nobody needs it, so the CLI can exit.
      this.idleTimer = setTimeout(() => this.close(), 2000);
      this.idleTimer.unref();
    }
  }
}
