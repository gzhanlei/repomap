import { execFile, type ExecFileOptions } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (file: string, args: string[], options?: ExecFileOptions) => Promise<CommandResult>;

export const execCommand: CommandRunner = (file, args, options = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { encoding: "utf8", ...options, shell: false }, (error, stdout, stderr) => {
    if (error) {
      reject(Object.assign(error, { stdout: String(stdout), stderr: String(stderr) }));
      return;
    }
    resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
});
