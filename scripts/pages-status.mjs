import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read Pages configuration. Only an explicitly configured workflow may deploy. */
export async function readPagesStatus({ repository, token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository ?? '')) throw new Error('A GitHub owner/repository is required.');
  if (!token) throw new Error('GITHUB_TOKEN with Pages read permission is required.');
  const api = new URL(apiUrl);
  if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash) throw new Error('GitHub API URL must be HTTPS without credentials, query, or fragment.');
  const response = await fetchImpl(`${api.href.replace(/\/$/, '')}/repos/${repository}/pages`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10' },
    redirect: 'error',
    signal: AbortSignal.timeout(10000)
  });
  if (response.status === 404) return { configured: false, reason: 'not-enabled' };
  if (response.status !== 200) throw new Error(`Pages configuration lookup failed with HTTP ${response.status}. Check workflow Pages read permission and GitHub API availability.`);
  const site = await response.json();
  if (site?.build_type === 'workflow') return { configured: true, reason: 'workflow' };
  if (site?.build_type === 'legacy') return { configured: false, reason: 'legacy-source' };
  throw new Error('Pages configuration lookup returned an unexpected build_type.');
}

export function pagesStatusSummary(status) {
  if (status.configured) return '## Demo Pages\n\nGitHub Pages is configured for Actions. The deployment job may publish the checked static artifact.\n';
  const reason = status.reason === 'not-enabled' ? 'GitHub Pages is not enabled for this repository.' : 'GitHub Pages still uses branch publishing.';
  return `## Demo Pages: configuration required\n\n${reason} The checked static demo artifact is uploaded; deployment is skipped.\n\nAn owner must select **Settings → Pages → Build and deployment → Source → GitHub Actions**, then run **Actions → Demo Pages → Run workflow** on main. The normal workflow token cannot enable the first Pages site.\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const status = await readPagesStatus({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN, apiUrl: process.env.GITHUB_API_URL });
  if (!process.env.GITHUB_OUTPUT || !process.env.GITHUB_STEP_SUMMARY) throw new Error('Run this preflight as a GitHub Actions step.');
  await appendFile(process.env.GITHUB_OUTPUT, `configured=${status.configured}\n`);
  await appendFile(process.env.GITHUB_STEP_SUMMARY, pagesStatusSummary(status));
  console.log(`Pages configuration: ${status.reason}; deployment ${status.configured ? 'eligible' : 'skipped'}.`);
}
