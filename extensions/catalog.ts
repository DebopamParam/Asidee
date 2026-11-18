import envDocs from "./env-docs/extension.json" with { type: "json" }
import logins from "./logins/extension.json" with { type: "json" }
import repo from "./repo/extension.json" with { type: "json" }
import rotator from "./rotator/extension.json" with { type: "json" }
import skills from "./skills/extension.json" with { type: "json" }
import t3 from "./t3/extension.json" with { type: "json" }

// The extensions that ship inside asd. Their declarations come from here and their code runs from inside the binary
// (`asd extension-run ID …`), so installing one needs neither Bun nor a copy of its files.
export const BUNDLED: Record<string, unknown> = { "env-docs": envDocs, logins, repo, rotator, skills, t3 }
