import { BuildMetadata } from '@jupiter/contracts'

export type BuildMetadataResult =
  | { readonly ok: true; readonly metadata: BuildMetadata }
  | { readonly ok: false; readonly problem: string }

/** Read and validate the metadata injected at build time. Never trusts it blindly. */
export function readBuildMetadata(): BuildMetadataResult {
  const raw: unknown =
    typeof __JUPITER_BUILD_METADATA__ === 'undefined' ? undefined : __JUPITER_BUILD_METADATA__
  if (raw === undefined) {
    return { ok: false, problem: 'This build does not contain build metadata.' }
  }
  const parsed = BuildMetadata.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`
    )
    return { ok: false, problem: `The build metadata is invalid — ${issues.join('; ')}` }
  }
  return { ok: true, metadata: parsed.data }
}
