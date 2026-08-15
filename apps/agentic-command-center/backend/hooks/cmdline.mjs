// hooks/cmdline.mjs — the one boundary between "we hold argv" and "a child
// process runs". Closes DEP0190 (shell:true + args array is concatenated,
// not escaped) at every real-claude spawn site: kernel adapter identity()/
// startTask() and runner/runClaudeOnce. POSIX needs no shell at all, so the
// injection class is deleted there, not escaped. Windows must keep a shell
// for the `claude.cmd` shim (Node refuses shell-less .cmd since
// CVE-2024-27980), so args become ONE string, quoted here, tested hard.
export class CmdQuoteError extends Error {}

// Chars cmd.exe passes through bare AND the MS C runtime parses as one arg.
// Everything else is CRT-quoted; quoting also neutralizes cmd metacharacters
// (& | < > ^ ( ) ! ; ,) because cmd treats quoted spans literally with
// delayed expansion off — node spawns `cmd.exe /d /s /c`, so it is off.
const BARE = /^[A-Za-z0-9._:\\/+=@-]+$/;

export function cmdQuote(arg) {
  const s = String(arg);
  if (/[\r\n\0]/.test(s)) throw new CmdQuoteError(`control character in spawn arg: ${JSON.stringify(s)}`);
  // % expands even inside quotes and cannot be caret-escaped on a /c command
  // line. Kernel-generated args never contain it; refusing beats mangling.
  if (s.includes("%")) throw new CmdQuoteError(`"%" cannot be escaped on a cmd.exe command line: ${JSON.stringify(s)}`);
  if (s !== "" && BARE.test(s)) return s;
  let out = '"';
  let bs = 0;
  for (const ch of s) {
    if (ch === "\\") { bs++; continue; }
    if (ch === '"') { out += "\\".repeat(bs * 2 + 1) + '"'; bs = 0; continue; }
    out += "\\".repeat(bs) + ch;
    bs = 0;
  }
  return out + "\\".repeat(bs * 2) + '"';
}

// What to hand child_process. Invariant (unit-locked): shell:true => no args
// key, so the DEP0190 combination is unrepresentable at the call sites.
export function spawnSpec(bin, args = [], platform = process.platform) {
  if (platform !== "win32") return { file: String(bin), args: args.map(String), shell: false };
  return { file: [bin, ...args].map(cmdQuote).join(" "), shell: true };
}
