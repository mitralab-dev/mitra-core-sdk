import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"

export function validateContractCorpus(contractsDirectory) {
  const manifestPath = join(contractsDirectory, "manifest.json")
  if (!existsSync(manifestPath)) throw new Error(`Missing contract manifest at ${manifestPath}`)

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  if (manifest.contract !== "SDK-PARITY-001") throw new Error("Unexpected contract identifier")
  if (!Array.isArray(manifest.versions) || manifest.versions.length === 0) {
    throw new Error("Contract manifest must declare at least one version")
  }

  const declaredPaths = manifest.versions.map(({ path }) => path).sort()
  const packagedPaths = readdirSync(contractsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^v\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => `${entry.name}/sdk-parity.json`)
    .sort()
  if (JSON.stringify(declaredPaths) !== JSON.stringify(packagedPaths)) {
    throw new Error("Contract manifest versions do not match packaged version directories")
  }

  const versions = manifest.versions.map((entry) => {
    if (dirname(entry.path) !== `v${entry.version}`) {
      throw new Error(`Contract ${entry.version} path does not match its version`)
    }
    const contractPath = join(contractsDirectory, entry.path)
    if (!existsSync(contractPath)) throw new Error(`Missing contract ${entry.version}`)
    const bytes = readFileSync(contractPath)
    const digest = createHash("sha256").update(bytes).digest("hex")
    if (digest !== entry.sha256) throw new Error(`Digest mismatch for contract ${entry.version}`)
    const contract = JSON.parse(bytes.toString("utf8"))
    if (contract.contract !== manifest.contract || contract.version !== entry.version) {
      throw new Error(`Identity mismatch for contract ${entry.version}`)
    }
    return contract
  })

  if (!manifest.versions.some(({ version }) => version === manifest.current)) {
    throw new Error(`Current contract version ${manifest.current} is not declared`)
  }

  return { manifest, versions }
}
