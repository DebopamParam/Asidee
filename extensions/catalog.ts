import envDocs from "./env-docs/extension.json" with { type: "json" }
import folders from "./folders/extension.json" with { type: "json" }
import logins from "./logins/extension.json" with { type: "json" }
import repo from "./repo/extension.json" with { type: "json" }
import rotator from "./rotator/extension.json" with { type: "json" }
import t3 from "./t3/extension.json" with { type: "json" }

// The extensions that ship inside asd. Their declarations come from here and their code runs from inside the binary
// (`asd extension-run ID …`), so installing one needs neither Bun nor a copy of its files.
export const BUNDLED: Record<string, unknown> = { "env-docs": envDocs, folders, logins, repo, rotator, t3 }

// Bundled extensions this asd no longer has, and what replaced them. An installed one is reported with this, not loaded,
// and `asd ext remove ID` still takes its marker away.
export const RETIRED: Record<string, string> = { skills: "Skills and plugins is no longer bundled: Folders copies any folder in, such as ~/.agents. Remove it with `asd ext remove skills`, and install Folders with `asd ext install folders`." }
