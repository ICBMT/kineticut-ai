/**
 * Minimal type declarations for node-pty (the package ships no .d.ts).
 * Only the surface used by the terminal manager is declared.
 */
declare module 'node-pty' {
  export interface IPty {
    write(data: string): void
    resize(columns: number, rows: number): void
    kill(signal?: string): void
    onData(listener: (data: string) => void): void
    onExit(listener: (event: { exitCode: number; signal?: number }) => void): void
    pid: number
  }

  export interface IPtyForkOptions {
    name?: string
    cols?: number
    rows?: number
    cwd?: string
    env?: Record<string, string | undefined>
    encoding?: string
    handleFlowControl?: boolean
    flowControlPause?: string
    flowControlResume?: string
  }

  export function spawn(file: string, args: string[] | string, options: IPtyForkOptions): IPty
}
