// Reset one person's password to a fresh random one. They sign in with it, are asked to choose their own password at once,
// and the old password (and any signed-in device) stops working right away.
//
//   node scripts/reset-password.mjs usera           prints the new password + the AUTH entry to paste; touches nothing
//   TRACKERS_GITHUB_TOKEN=github_pat_… node scripts/reset-password.mjs usera --apply
//                                                   also writes it into the AUTH variable (TRACKERS_REPO, default seanx888/aethersky)
//
// Run it on your own machine, never in GitHub Actions: this repository is public, so the log would show the password.
// The person must still have PASSWORD_USER<letter> set in Vercel — that variable is what makes them a valid user.
import { pathToFileURL } from 'node:url';
import { authStore, temporaryPassword, AUTH_VAR } from '../web/api/_lib/auth.mjs';

const USAGE = 'usage: node scripts/reset-password.mjs <usera|userb|…> [--apply]';

export async function main(argv, { env = process.env, fetchImpl = fetch, now = Date.now(), log = console.log } = {}) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = argv.filter((a) => a.startsWith('--'));
  const name = String(args[0] || '').toLowerCase();
  if (args.length !== 1 || !/^user[a-z]$/.test(name) || flags.some((f) => f !== '--apply')) {
    log(USAGE);
    return 1;
  }
  const apply = flags.includes('--apply');
  if (apply && !env.TRACKERS_GITHUB_TOKEN) {
    log('--apply needs TRACKERS_GITHUB_TOKEN (fine-grained token, this repo only, Variables: read and write).');
    return 1;
  }

  const { password, entry } = await temporaryPassword({ now });
  if (apply) {
    try {
      await authStore(env, fetchImpl).setHash(name, entry.hash, entry.at, { temp: true });
    } catch (e) {
      log(`Could not write the ${AUTH_VAR} variable: ${e.message}`);
      return 1;
    }
    log(`✓ ${name}: new password stored in ${AUTH_VAR} (${env.TRACKERS_REPO || 'seanx888/aethersky'}). Old password and sign-ins are void.`);
  }
  log(`\nNew password for ${name} — shown once, pass it on privately:\n\n  ${password}\n`);
  if (!apply) {
    log(`Not stored yet. GitHub → Settings → Secrets and variables → Actions → Variables → ${AUTH_VAR}: replace only the "${name}" entry with`);
    log(`  "${name}": ${JSON.stringify(entry)}`);
    log('(inside the existing { … } — keep everyone else\'s entry; create the variable as { <the line above> } if it does not exist).');
  }
  log(`${name} signs in with it, then must choose their own password.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
