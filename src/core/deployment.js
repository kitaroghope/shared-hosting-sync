import { resolveEnv, credsFromResolved } from './envResolver.js'
import { assertLocalFolder } from '../onboarding.js'
import { validateRemotePath } from '../paths.js'
import { buildMatcher } from '../ignore.js'

/** Shared validated deployment context for terminal and dashboard operations. */
export function resolveDeployment(project, options = {}) {
  const resolved = resolveEnv(project.id, options)
  if (resolved.warnings.length) throw new Error(resolved.warnings.join('; '))
  const target = {
    ...project, localPath: assertLocalFolder(project.localPath),
    remotePath: validateRemotePath(resolved.values.DEVSYNC_REMOTE_PATH)
  }
  return {
    project: target,
    matcher: buildMatcher(target.localPath),
    creds: credsFromResolved(resolved.values),
    dryRun: ['true', '1', true].includes(resolved.values.DEVSYNC_DRY_RUN),
    debounceMs: Number(resolved.values.DEVSYNC_DEBOUNCE_MS),
    values: resolved.values
  }
}
