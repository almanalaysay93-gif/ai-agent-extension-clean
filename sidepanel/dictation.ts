/**
 * Voice input for the composer, built on Chrome's Web Speech API.
 *
 * Speech recognition is free and streams text as the user talks, so no audio
 * ever goes through the model. The one wrinkle is permission: microphone
 * access is granted per origin, and Chrome will not show its permission
 * prompt inside a side panel. The extension therefore opens a normal tab on
 * its own origin (permission/index.html) to collect the grant once; every
 * extension surface, side panel included, inherits it afterwards.
 */

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<
    ArrayLike<{ transcript: string }> & { isFinal: boolean }
  >;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export type Dictation = {
  supported: boolean;
  listening: () => boolean;
  start: () => Promise<void>;
  stop: () => void;
};

export type DictationCallbacks = {
  /** Fires with the text so far: interim while speaking, final on a pause. */
  onTranscript: (text: string, isFinal: boolean) => void;
  onError: (message: string) => void;
  onListeningChange: (listening: boolean) => void;
};

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/**
 * Opens the one-time permission tab. Chrome silently refuses getUserMedia
 * prompts in a side panel, so the grant has to happen on a real tab.
 */
function openPermissionTab(): void {
  chrome.tabs
    .create({ url: chrome.runtime.getURL('permission/index.html') })
    .catch(() => undefined);
}

async function micPermissionState(): Promise<PermissionState | 'unknown'> {
  try {
    const status = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    });
    return status.state;
  } catch {
    return 'unknown';
  }
}

export function createDictation(callbacks: DictationCallbacks): Dictation {
  const Ctor = getRecognitionCtor();
  let recognition: SpeechRecognitionLike | null = null;
  let active = false;

  const stop = () => {
    active = false;
    callbacks.onListeningChange(false);
    recognition?.stop();
  };

  const start = async () => {
    if (!Ctor) {
      callbacks.onError('This browser has no speech recognition support.');
      return;
    }
    if (active) {
      stop();
      return;
    }

    const permission = await micPermissionState();
    if (permission === 'denied') {
      callbacks.onError(
        'Microphone access is blocked for this extension. Re-enable it in Chrome site settings, then try again.',
      );
      return;
    }
    if (permission === 'prompt') {
      callbacks.onError(
        'Microphone access has not been granted yet — a tab just opened to ask for it. Allow the mic there, then press the mic button again.',
      );
      openPermissionTab();
      return;
    }

    recognition = new Ctor();
    recognition.lang = navigator.language || 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) final += text;
        else interim += text;
      }
      if (final) callbacks.onTranscript(final, true);
      else if (interim) callbacks.onTranscript(interim, false);
    };

    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        callbacks.onError(
          'Chrome blocked the microphone. Allow it in the tab that just opened, then press the mic button again.',
        );
        openPermissionTab();
      } else if (event.error === 'network') {
        callbacks.onError('Speech recognition needs a network connection.');
      } else {
        callbacks.onError(`Speech recognition failed: ${event.error}`);
      }
      active = false;
      callbacks.onListeningChange(false);
    };

    recognition.onend = () => {
      // Chrome ends the session on its own after a pause. Restart while the
      // user still has the mic toggled on, so dictation feels continuous.
      if (active) {
        try {
          recognition?.start();
          return;
        } catch {
          // Fall through to the off state below.
        }
      }
      active = false;
      callbacks.onListeningChange(false);
    };

    try {
      recognition.start();
      active = true;
      callbacks.onListeningChange(true);
    } catch (error) {
      callbacks.onError(
        `Could not start the microphone: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return {
    supported: Boolean(Ctor),
    listening: () => active,
    start,
    stop,
  };
}
