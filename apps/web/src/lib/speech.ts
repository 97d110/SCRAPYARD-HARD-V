/**
 * Hebrew speech capture, via the browser's own Web Speech API.
 *
 * Deliberately thin: it starts listening, streams back interim text so the UI
 * can show something happening, and hands over a final transcript. All the
 * understanding happens server-side (see `voice.service.ts`) — this only turns
 * sound into words.
 *
 * Three things worth knowing before relying on it:
 *
 *   1. Support is uneven. Chrome and Edge implement it; Firefox does not, and
 *      Safari's support has historically been partial and inconsistent. Hence
 *      `speechSupported()` — callers hide the mic rather than offering a button
 *      that silently fails.
 *
 *   2. "Client-side" is a half-truth. Chrome's implementation streams audio to
 *      Google's servers for recognition; it is not on-device. It avoids OUR
 *      server and our bandwidth, which was the point, but it isn't private.
 *
 *   3. The language is fixed before listening starts and can't be switched
 *      mid-sentence. Pinned to Hebrew here by choice. A sentence that mixes
 *      Hebrew and English ("עמית ניצח with 16") will mangle the English half —
 *      that's inherent to the API, not something this wrapper can paper over.
 *      Groq's Whisper models handle mixed speech and are on the same free tier
 *      if this ever becomes the thing that annoys people.
 */

/** Long enough for four racers and their scores; short enough to not hang open. */
const MAX_LISTEN_MS = 20_000;

/*
 * Minimal hand-rolled types. TypeScript's bundled DOM library doesn't declare
 * SpeechRecognition (it's still a draft spec), and `webkitSpeechRecognition`
 * never will be. Declaring only what's used here beats pulling in a dependency
 * or casting to `any` at every call site.
 */
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionResultListLike {
  readonly length: number;
  [index: number]: SpeechRecognitionResultLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}
interface SpeechRecognitionErrorEventLike {
  error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function constructor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** False on Firefox and anywhere else without the API — hide the mic entirely. */
export function speechSupported(): boolean {
  return constructor() !== null;
}

export interface SpeechSession {
  /** Ask for the final result now. Resolves the original promise. */
  stop(): void;
  /** Throw the session away without producing a transcript. */
  cancel(): void;
}

export interface ListenCallbacks {
  /** Fires repeatedly with the best guess so far, so the UI can show progress. */
  onInterim?: (text: string) => void;
}

/**
 * Human-readable reasons, because the raw API codes are terse and a couple of
 * them mean something the person can actually act on.
 */
function describeError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access was blocked — allow it in your browser settings.';
    case 'no-speech':
      return "Didn't catch anything — try again a bit closer to the mic.";
    case 'audio-capture':
      return 'No microphone found.';
    case 'network':
      return 'Speech recognition needs a network connection.';
    case 'aborted':
      return 'Cancelled.';
    default:
      return `Speech recognition failed (${code}).`;
  }
}

/**
 * Listen once, resolving with the final transcript.
 *
 * Returns the session synchronously alongside the promise so the caller can
 * wire up a stop button before anything has been said — awaiting first would
 * mean the session object arrives only after it's already over.
 */
export function listenForHebrew(callbacks: ListenCallbacks = {}): {
  session: SpeechSession;
  result: Promise<string>;
} {
  const Ctor = constructor();
  if (!Ctor) {
    return {
      session: { stop: () => {}, cancel: () => {} },
      result: Promise.reject(new Error('Speech recognition is not supported in this browser.')),
    };
  }

  const recognition = new Ctor();
  recognition.lang = 'he-IL';
  // One utterance, not a running dictation: someone says the results and stops.
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let finalText = '';
  let settled = false;
  let cancelled = false;

  const result = new Promise<string>((resolve, reject) => {
    // Never leave the mic open indefinitely — a forgotten session is a hot mic.
    const timer = window.setTimeout(() => {
      try {
        recognition.stop();
      } catch {
        // Already stopped; onend still fires and settles the promise.
      }
    }, MAX_LISTEN_MS);

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      settle();
    };

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const alternative = event.results[i][0];
        if (!alternative) continue;
        if (event.results[i].isFinal) finalText += alternative.transcript;
        else interim += alternative.transcript;
      }
      const preview = (finalText + interim).trim();
      if (preview) callbacks.onInterim?.(preview);
    };

    recognition.onerror = (event) => {
      // A no-speech error after something was already heard isn't a failure —
      // it's just the trailing silence that ended the sentence.
      if (event.error === 'no-speech' && finalText.trim()) return;
      if (cancelled) return;
      finish(() => reject(new Error(describeError(event.error))));
    };

    recognition.onend = () => {
      if (cancelled) {
        finish(() => reject(new Error('Cancelled.')));
        return;
      }
      const text = finalText.trim();
      finish(() =>
        text
          ? resolve(text)
          : reject(new Error("Didn't catch anything — try again a bit closer to the mic.")),
      );
    };

    try {
      recognition.start();
    } catch (error) {
      finish(() =>
        reject(error instanceof Error ? error : new Error('Could not start listening.')),
      );
    }
  });

  return {
    session: {
      stop: () => {
        try {
          recognition.stop();
        } catch {
          // Already stopping — onend settles it either way.
        }
      },
      cancel: () => {
        cancelled = true;
        try {
          recognition.abort();
        } catch {
          // Nothing to abort.
        }
      },
    },
    result,
  };
}
