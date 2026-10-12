import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A throwaway git repository for tests. */
export class TempRepo {
  readonly root = mkdtempSync(path.join(tmpdir(), 'vc-test-'));

  constructor() {
    this.git('init', '-q', '-b', 'main');
    this.git('config', 'user.email', 'test@example.com');
    this.git('config', 'user.name', 'Test');
    this.git('config', 'core.autocrlf', 'false');
  }

  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.root, encoding: 'utf8' });
  }

  write(file: string, content: string | Buffer): this {
    const full = path.join(this.root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
    return this;
  }

  remove(file: string): this {
    rmSync(path.join(this.root, file));
    return this;
  }

  commit(message = 'commit'): string {
    this.git('add', '-A');
    this.git('commit', '-q', '-m', message);
    return this.git('rev-parse', 'HEAD').trim();
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
