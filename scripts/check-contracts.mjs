import { URL, fileURLToPath } from "node:url"
import { validateContractCorpus } from "./contract-manifest.mjs"

validateContractCorpus(fileURLToPath(new URL("../contracts", import.meta.url)))
