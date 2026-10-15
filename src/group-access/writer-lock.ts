import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const lockPath = (rootDir: string) => path.join(rootDir, "group-access.writer.lock");
export function groupWriterBusy(rootDir: string): boolean { return fs.existsSync(lockPath(rootDir)); }
export function assertGroupWriter(rootDir: string, token?: string): void {
  if (!groupWriterBusy(rootDir)) return;
  try { if (token && JSON.parse(fs.readFileSync(lockPath(rootDir), "utf8")).token === token) return; } catch { /* Fail closed. */ }
  throw new Error("群权限正在由运行中的服务或另一管理窗口写入；当前只读。请先停止服务。异常退出遗留的锁请在确认进程已退出后清理。");
}
export function acquireGroupWriter(rootDir: string): { token: string; release(): void } {
  fs.mkdirSync(rootDir, { recursive: true });
  const file = lockPath(rootDir);
  const token = randomUUID();
  let fd: number;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") assertGroupWriter(rootDir); throw error; }
  try { fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })); fs.fsyncSync(fd); }
  catch (error) { fs.unlinkSync(file); throw error; }
  finally { fs.closeSync(fd); }
  return { token, release() { assertGroupWriter(rootDir, token); if (fs.existsSync(file)) fs.unlinkSync(file); } };
}
