/**
 * Who is allowed in. One definition, read from two very different places.
 *
 * This lives in `common/` rather than next to the Google strategy because the
 * users service needs it too: an admin creating a racer by email must apply
 * exactly the same rule that sign-in applies, or they could mint a seat that no
 * permitted account is ever able to claim. Importing it from the strategy would
 * close a cycle (strategy → users service → strategy), which Nest's DI and
 * decorator metadata handle badly.
 *
 * ── The allowlist is pattern-based ──────────────────────────────────────────
 *
 * `ALLOWED_WORKSPACE_DOMAINS` is a comma-separated list where each entry is
 * either a bare domain or a glob over the whole email address:
 *
 *   cytactic.com          a bare domain — shorthand for *@cytactic.com
 *   @cytactic.com         same thing
 *   *@cytactic.com        an explicit glob (only `*` is special)
 *   *@*.cytactic.com      any subdomain
 *   amit@gmail.com        one specific address
 *   *@gmail.com           any Gmail account (open — use with care)
 *
 * `*` matches any run of characters; everything else is matched literally, so
 * a stray `.` can't act as a wildcard. Matching is full-string and
 * case-insensitive, which is why `a@cytactic.com.evil.com` never matches
 * `*@cytactic.com`.
 */

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Scrapyard runs strict pattern-restricted Google SSO — see apps/api/.env.example.`,
    );
  }
  return value;
}

/** Raw allowlist entries, normalised and lower-cased. Required, no default. */
function rawEntries(): string[] {
  const entries = requiredEnv('ALLOWED_WORKSPACE_DOMAINS')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new Error(
      'ALLOWED_WORKSPACE_DOMAINS is set but empty. Scrapyard will not run an ' +
        'open sign-in — give it at least one domain or pattern, e.g. cytactic.com',
    );
  }
  return entries;
}

/** Turn one allowlist entry into a full-email glob pattern. */
function toEmailGlob(entry: string): string {
  if (!entry.includes('@')) return `*@${entry}`; // bare domain
  if (entry.startsWith('@')) return `*${entry}`; // @domain
  return entry; // already an email or an email glob
}

/** Compile a glob (only `*` is special) into an anchored, case-insensitive regex. */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === '*' ? '.*' : `\\${char}`));
  return new RegExp(`^${escaped}$`, 'i');
}

/** The compiled matchers for the current allowlist. */
function matchers(): RegExp[] {
  return rawEntries().map((entry) => globToRegex(toEmailGlob(entry)));
}

/** True if `email` is permitted to sign in / be added as a racer. */
export function isAllowedEmail(email: string): boolean {
  const address = email.trim().toLowerCase();
  return matchers().some((pattern) => pattern.test(address));
}

/**
 * Human-readable allowlist labels, for the login page and error messages.
 * A domain-style entry shows its domain (`cytactic.com`); a specific address
 * shows in full (`amit@gmail.com`).
 */
export function allowedDomains(): string[] {
  return rawEntries().map((entry) => {
    if (entry.startsWith('*@')) return entry.slice(2);
    if (entry.startsWith('@')) return entry.slice(1);
    return entry;
  });
}

/**
 * The Google account-chooser `hd` hint — only when the allowlist is a single
 * plain Workspace domain. It's a UX nicety, never a control (validate()
 * re-checks), so anything fancier than one bare domain just omits it.
 */
export function hostedDomainHint(): string | undefined {
  const entries = rawEntries();
  if (entries.length !== 1) return undefined;
  const only = entries[0];
  const domain = only.startsWith('*@') ? only.slice(2) : !only.includes('@') ? only : undefined;
  // A hint is meaningless if the domain part still contains a wildcard.
  return domain && !domain.includes('*') ? domain : undefined;
}
