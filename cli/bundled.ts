import { BUNDLED_RUN } from "../core/extensions"
import { command as envDocs } from "../extensions/env-docs/env-docs"
import { command as logins } from "../extensions/logins/login"
import { command as repo } from "../extensions/repo/repo"
import { command as rotator } from "../extensions/rotator/rotator"
import { command as t3 } from "../extensions/t3/t3"

const COMMANDS: Record<string, (argv: string[]) => Promise<void>> = { "env-docs": envDocs, logins, repo, rotator, t3 }

// `asd extension-run ID …`: a bundled extension's own command line, run inside this binary, so it needs no Bun. The
// client's parsing does not apply to it; the extension reads its arguments and ASIDEE_* variables as it would under Bun.
export async function runBundled(argv: string[]): Promise<void> {
  const [id, ...args] = argv
  const command = id !== undefined && Object.hasOwn(COMMANDS, id) ? COMMANDS[id] : undefined
  if (!command) {
    console.error(`asd: ${BUNDLED_RUN} needs a bundled extension: ${Object.keys(COMMANDS).join(", ")}.`)
    process.exit(2)
  }
  await command(args)
}
