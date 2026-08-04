/**
 * Does the extraction model actually understand spoken Hebrew?
 *
 * Groq's strict Structured Outputs mode guarantees the *shape* of a response —
 * constrained decoding means it can't return anything but our schema. It says
 * nothing about whether the values inside are right. Those are separate
 * questions and only the first one comes with a guarantee.
 *
 * That matters here because the models with strict-mode support are the
 * `gpt-oss` family, which are English-centric by reputation, and the entire
 * point of this feature is matching Hebrew speech to Latin display names. A
 * perfectly-shaped response naming the wrong racer is the failure mode to
 * worry about, and no amount of schema validation will catch it.
 *
 * So: prove it on a handful of realistic sentences before any UI is built on
 * top of the assumption. Cheap to run, and a bad result here means swapping
 * providers rather than rewriting a feature.
 *
 *   npm run probe:groq
 *
 * Exits non-zero if any case fails, so it can gate a build if you ever want it
 * to. Needs GROQ_API_KEY in apps/api/.env — the key is never printed.
 */
import '../common/load-env';
import { buildSchema, systemPrompt, userPrompt } from '../voice/prompt';

/**
 * Groq by default, but overridable: any OpenAI-compatible gateway works here,
 * and several proxy the frontier models — which matters because the Hebrew
 * risk this probe exists to measure is specifically a weakness of the small
 * open-weight models, not of GPT-4o/Claude-class ones.
 *
 *   GROQ_BASE_URL=https://your-gateway.example/v1 npm run probe:groq
 */
const BASE_URL = (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const TIMEOUT_MS = 30_000;

/**
 * A stand-in roster, shaped exactly like the real one: Latin display names
 * with Hebrew aliases beside them. Mirrors the seeded crew so the probe can
 * run against a database that has never been touched.
 */
const ROSTER = [
  { id: 'r-amit', displayName: 'Amit Nino', hebrewAliases: ['עמית', 'נינו', 'עמית נינו'] },
  { id: 'r-dana', displayName: 'Dana Kessler', hebrewAliases: ['דנה', 'קסלר', 'דנה קסלר'] },
  { id: 'r-noam', displayName: 'Noam Barak', hebrewAliases: ['נועם', 'ברק', 'נועם ברק'] },
  { id: 'r-yael', displayName: 'Yael Doron', hebrewAliases: ['יעל', 'דורון', 'יעל דורון'] },
  { id: 'r-omer', displayName: 'Omer Ziv', hebrewAliases: ['עומר', 'זיו', 'עומר זיו'] },
];

interface ProbeCase {
  /** What someone would actually say, out loud, in Hebrew. */
  transcript: string;
  /** Racer ids in finishing order, winner first. */
  expected: string[];
  /** Scores in the same order; null where the sentence doesn't state one. */
  expectedScores: Array<number | null>;
  /** Who is speaking, for the cases that test first-person resolution. */
  speakerId?: string;
  /** Why this case is here — printed on failure so the result is diagnosable. */
  note: string;
}

/*
 * Deliberately not variations of one sentence. Each case isolates something
 * that could independently break: first-name-only speech, surnames, spelled-out
 * Hebrew numerals, a sentence with no scores at all, and first-person speech —
 * which in Hebrew often carries the subject in the verb rather than a pronoun.
 */
const CASES: ProbeCase[] = [
  {
    transcript: 'עמית ניצח עם שש עשרה, אחר כך דנה עם חמש עשרה, אחר כך נועם עם שמונה',
    expected: ['r-amit', 'r-dana', 'r-noam'],
    expectedScores: [16, 15, 8],
    note: 'Spelled-out Hebrew numerals (שש עשרה = 16) rather than digits.',
  },
  {
    transcript: 'יעל ראשונה 16, עומר שני 15, עמית שלישי 15, דנה רביעית 8',
    expected: ['r-yael', 'r-omer', 'r-amit', 'r-dana'],
    expectedScores: [16, 15, 15, 8],
    note: 'Full four-car field with digits and explicit ordinals.',
  },
  {
    transcript: 'קסלר לקחה את זה, ואחריה נינו',
    expected: ['r-dana', 'r-amit'],
    expectedScores: [null, null],
    note: 'Surnames only, no scores stated — must not invent numbers.',
  },
  {
    transcript: 'נועם ניצח, עומר היה שני, יעל שלישית',
    expected: ['r-noam', 'r-omer', 'r-yael'],
    expectedScores: [null, null, null],
    note: 'First names, placement by words alone, no scores.',
  },
  {
    transcript: 'אני ניצחתי עם 16, אחר כך דנה עם 15',
    expected: ['r-amit', 'r-dana'],
    expectedScores: [16, 15],
    speakerId: 'r-amit',
    note: 'Explicit אני ("I") must resolve to the speaker, not be dropped.',
  },
  {
    /*
     * The harder half of the same idea: no pronoun at all. Hebrew puts the
     * subject in the verb, so "ניצחתי" is "I won" — an alias list can never
     * catch this, only a prompt rule about first-person conjugation can.
     */
    transcript: 'ניצחתי עם 16, יעל שנייה עם 15, עומר שלישי',
    expected: ['r-amit', 'r-yael', 'r-omer'],
    expectedScores: [16, 15, null],
    speakerId: 'r-amit',
    note: 'First-person VERB with no pronoun (ניצחתי) must resolve to the speaker.',
  },
  {
    /*
     * Two rules at once, deliberately: the speaker is named FIRST but finished
     * SECOND, so the ordinal has to beat word order at the same time as the
     * first-person verb resolves. Realistic — people lead with their own result.
     */
    transcript: 'הגעתי שני עם 15, דנה ניצחה עם 16',
    expected: ['r-dana', 'r-amit'],
    expectedScores: [16, 15],
    speakerId: 'r-amit',
    note: 'הגעתי ("I came") as a placement verb, with the ordinal overriding word order.',
  },
  {
    transcript: 'סיימתי שלישי, נועם ניצח, יעל שנייה',
    expected: ['r-noam', 'r-yael', 'r-amit'],
    expectedScores: [null, null, null],
    speakerId: 'r-amit',
    note: 'סיימתי ("I finished") — speaker said first, placed last, no scores given.',
  },
  {
    /*
     * The contracted teens, exactly as they're said out loud. An unrecognised
     * number doesn't error — it comes back null, which reads as "no score
     * given" and quietly loses a real result. So this is worth a case.
     */
    transcript: 'דנה ניצחה עם חמשרה, אחר כך עמית עם שתמשרה',
    expected: ['r-dana', 'r-amit'],
    expectedScores: [15, 12],
    note: 'Contracted teens: חמשרה = 15, שתמשרה = 12.',
  },
  {
    // Descending on purpose: a case whose expected output the grid would reject
    // as an invalid race is a confusing thing to assert as correct.
    transcript: 'יעל ניצחה עם שמונשרה, עומר עם ששרה, נועם עם ארבעשרה',
    expected: ['r-yael', 'r-omer', 'r-noam'],
    expectedScores: [18, 16, 14],
    note: 'More contractions the rule should generalise to: שמונשרה/ששרה/ארבעשרה = 18/16/14.',
  },
];

interface Finisher {
  racerId: string;
  heardAs: string;
  gameScore: number | null;
}

async function extract(
  transcript: string,
  apiKey: string,
  model: string,
  speakerId?: string,
): Promise<Finisher[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        // Deterministic: this is extraction, not writing. Re-running the probe
        // should give the same verdict rather than a different roll.
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: userPrompt(transcript, ROSTER, speakerId) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'race_results',
            strict: true,
            schema: buildSchema(ROSTER.map((r) => r.id)),
          },
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      // 400 here most often means the model doesn't support strict mode —
      // worth saying so plainly rather than dumping a raw error.
      const extra =
        response.status === 400
          ? ` — if this mentions response_format, ${model} may not support strict Structured Outputs`
          : '';
      throw new Error(`HTTP ${response.status}${extra}: ${body.slice(0, 400)}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error('No content in the response');
    return (JSON.parse(content) as { finishers: Finisher[] }).finishers;
  } finally {
    clearTimeout(timer);
  }
}

function describe(finishers: Finisher[]): string {
  if (finishers.length === 0) return '(nothing)';
  return finishers
    .map((f) => `${f.racerId}${f.gameScore === null ? '' : `=${f.gameScore}`} (heard "${f.heardAs}")`)
    .join(', ');
}

/** Enough to tell two keys apart in a paste, and no more. Mirrors preflight.ts. */
function fingerprint(value: string): string {
  return value.length <= 12 ? '(set, suspiciously short)' : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * Whether the key works at all, asked once against the cheapest endpoint there
 * is. Without this, a bad key produces one failure per case and the summary
 * blames Hebrew for what is actually an auth problem — which is exactly what
 * happened the first time this ran.
 */
async function checkAuth(apiKey: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (response.ok) return { ok: true };
    return { ok: false, detail: `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

  if (!apiKey) {
    console.error('GROQ_API_KEY is not set.');
    console.error('');
    console.error('It must live in apps/api/.env — NOT the repo root. That path is');
    console.error('what load-env.ts reads, and a .env at the root is silently ignored.');
    process.exit(1);
  }

  console.log(`Model: ${model}`);
  console.log(`Key:   ${fingerprint(apiKey)} (${apiKey.length} chars)`);

  // Ask once whether the key works, before spending four calls finding out.
  const auth = await checkAuth(apiKey);
  if (!auth.ok) {
    console.error(`\nThe key was rejected before any Hebrew was tested.\n  ${auth.detail}\n`);
    console.error('This is an auth/transport problem, not a matching problem — the');
    console.error('probe has no opinion yet on whether Hebrew works. Worth checking:');
    console.error('  - The key is in apps/api/.env, not the repo root .env');
    console.error('  - The key belongs to THIS provider. Groq keys start "gsk_"; an');
    console.error('    "sk-..." key is from OpenAI or an OpenAI-compatible gateway,');
    console.error('    which needs GROQ_BASE_URL pointed at that gateway instead.');
    console.error('  - No stray quotes, spaces or a trailing newline inside the value');
    console.error('  - It is still live in the provider console, and not since revoked');
    process.exit(1);
  }
  console.log(`Auth:  ok`);
  console.log(`Cases: ${CASES.length}\n`);

  let passed = 0;
  let orderOnly = 0;
  let errored = 0;

  for (const [index, probe] of CASES.entries()) {
    const label = `[${index + 1}/${CASES.length}]`;
    try {
      const finishers = await extract(probe.transcript, apiKey, model, probe.speakerId);
      const gotIds = finishers.map((f) => f.racerId);
      const gotScores = finishers.map((f) => f.gameScore);

      const idsMatch = gotIds.join('|') === probe.expected.join('|');
      const scoresMatch = gotScores.join('|') === probe.expectedScores.join('|');

      if (idsMatch && scoresMatch) {
        passed += 1;
        console.log(`${label} PASS  ${probe.transcript}`);
      } else if (idsMatch) {
        // Worth separating: the hard part (cross-script name matching) worked
        // and only the numbers are off, which is a prompt problem rather than a
        // "this model can't do Hebrew" problem.
        orderOnly += 1;
        console.log(`${label} PARTIAL — names right, scores wrong`);
        console.log(`      said:     ${probe.transcript}`);
        console.log(`      expected: ${probe.expectedScores.join(', ')}`);
        console.log(`      got:      ${gotScores.join(', ')}`);
      } else {
        console.log(`${label} FAIL  (${probe.note})`);
        console.log(`      said:     ${probe.transcript}`);
        console.log(`      expected: ${probe.expected.join(' > ')}`);
        console.log(`      got:      ${describe(finishers)}`);
      }
    } catch (error) {
      errored += 1;
      console.log(`${label} ERROR ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Errors are counted apart from failures on purpose. A request that never
  // completed tested nothing, and folding it into "failed" invites a verdict
  // about Hebrew that the run has no evidence for.
  const tested = CASES.length - errored;
  const failed = tested - passed - orderOnly;
  console.log(`\n${passed} passed, ${orderOnly} partial, ${failed} failed, ${errored} errored.`);

  if (errored === CASES.length) {
    console.log('Every request failed to complete, so nothing about Hebrew was');
    console.log('measured. Fix the errors above and re-run before drawing conclusions.');
    process.exit(1);
  }

  if (errored > 0) {
    console.log(`Note: ${errored} of ${CASES.length} never completed, so this verdict`);
    console.log('covers only the cases that did.');
  }

  if (passed === tested) {
    console.log('Hebrew matching looks solid — safe to build the UI on this.');
  } else if (passed + orderOnly === tested) {
    console.log('Names matched everywhere; only score parsing needs prompt work.');
  } else {
    console.log('Name matching is unreliable. Worth trying the other gpt-oss model,');
    console.log('or a provider whose models handle Hebrew better, before building on it.');
  }

  process.exit(passed === tested && errored === 0 ? 0 : 1);
}

void main();
