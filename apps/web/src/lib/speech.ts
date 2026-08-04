/**
 * Microphone capture, for spoken race entry.
 *
 * Records audio and hands back a data URL. The transcription happens server-side
 * (Groq Whisper — see `voice.service.ts`); this file only deals with the mic.
 *
 * It used to use the browser's Web Speech API instead, which was a mistake worth
 * recording: that API is not on-device. Chrome streams audio to Google and
 * reports a bare `network` error when it can't reach them, which is what happens
 * behind a corporate proxy, in Chromium builds shipped without Google's speech
 * backend, and in any browser with the endpoint blocked. Firefox doesn't
 * implement it at all. Uploading the audio ourselves costs a few tens of
 * kilobytes and removes every one of those failure modes — plus it handles
 * sentences that mix Hebrew and English, which a single fixed `lang` could not.
 */

/** Long enough for four racers and their scores; short enough to bound the upload. */
const MAX_RECORD_MS = 20_000;

/**
 * Preference order. Opus in WebM is small and universally accepted where it
 * exists; Safari only does MP4/AAC. An empty string means "let the browser
 * choose", which is the last resort rather than the default because the result
 * is then unpredictable and may not be a container the provider accepts.
 */
const PREFERRED_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  '',
];

/** False where there's no recorder or no mic API at all — hide the button. */
export function speechSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

function pickMimeType(): string {
  for (const type of PREFERRED_TYPES) {
    if (type === '') return '';
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

export interface RecordingSession {
  /** Finish and resolve with the recording. */
  stop(): void;
  /** Abandon it — releases the mic, rejects the promise. */
  cancel(): void;
}

/**
 * Turns the recorded blob into `data:audio/webm;base64,…`.
 *
 * FileReader rather than manual base64: it handles the chunking for large
 * buffers, where a naive `btoa(String.fromCharCode(...bytes))` blows the call
 * stack on anything more than a few hundred kilobytes.
 */
function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the recording.'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Could not read the recording.'));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(blob);
  });
}

function describeMicError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was blocked — allow it in your browser settings.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone found.';
    case 'NotReadableError':
      return 'The microphone is in use by something else.';
    default:
      return 'Could not start recording.';
  }
}

/**
 * Record once, resolving with a data URL.
 *
 * The session is returned synchronously alongside the promise so a stop button
 * can be wired up before anything has been said — awaiting first would hand it
 * over only after the recording was already finished.
 */
export function recordAudio(): {
  session: RecordingSession;
  result: Promise<string>;
} {
  let stopRecorder: (() => void) | null = null;
  let cancelled = false;
  let started = false;

  const result = (async (): Promise<string> => {
    if (!speechSupported()) {
      throw new Error('Recording is not supported in this browser.');
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      throw new Error(describeMicError(error));
    }

    // Whatever happens next, the mic light must go out.
    const release = () => stream.getTracks().forEach((track) => track.stop());

    // Cancelled during the permission prompt — don't open a recorder at all.
    if (cancelled) {
      release();
      throw new Error('Cancelled.');
    }

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      release();
      throw new Error('Could not start recording.');
    }

    const chunks: Blob[] = [];
    started = true;

    return await new Promise<string>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (recorder.state !== 'inactive') recorder.stop();
      }, MAX_RECORD_MS);

      stopRecorder = () => {
        if (recorder.state !== 'inactive') recorder.stop();
      };

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };

      recorder.onerror = () => {
        window.clearTimeout(timer);
        release();
        reject(new Error('Recording failed.'));
      };

      recorder.onstop = () => {
        window.clearTimeout(timer);
        release();
        if (cancelled) {
          reject(new Error('Cancelled.'));
          return;
        }
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
        if (blob.size === 0) {
          reject(new Error("Didn't catch anything — try again, a bit closer to the mic."));
          return;
        }
        toDataUrl(blob).then(resolve, reject);
      };

      // A short timeslice means `ondataavailable` fires during the recording
      // rather than only at the end, so a browser that drops the final buffer
      // still leaves us with something usable.
      recorder.start(250);
    });
  })();

  return {
    session: {
      stop: () => stopRecorder?.(),
      cancel: () => {
        cancelled = true;
        // Before the recorder exists, the flag alone is enough — the async body
        // checks it after the permission prompt resolves.
        if (started) stopRecorder?.();
      },
    },
    result,
  };
}
