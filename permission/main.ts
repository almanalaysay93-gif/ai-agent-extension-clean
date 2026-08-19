/**
 * One-time microphone grant page.
 *
 * Microphone permission is bound to an origin, and Chrome suppresses the
 * prompt in side panels. Opening this page as a normal tab on the extension's
 * own origin lets the user grant once; the side panel then inherits it.
 */
const status = document.getElementById('status') as HTMLParagraphElement;
const retry = document.getElementById('retry') as HTMLButtonElement;

async function requestMicrophone(): Promise<void> {
  status.textContent = 'Requesting the microphone…';
  status.className = '';
  retry.hidden = true;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // The grant is what matters, not the audio: release the device at once so
    // no recording indicator lingers on the tab.
    stream.getTracks().forEach((track) => track.stop());
    status.textContent =
      'Microphone allowed. You can close this tab and press the mic button in the side panel.';
    status.className = 'ok';
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    status.textContent =
      name === 'NotAllowedError'
        ? 'Microphone blocked. Click the camera/mic icon in the address bar, allow the microphone, then ask again.'
        : `Could not access the microphone: ${error instanceof Error ? error.message : String(error)}`;
    status.className = 'bad';
    retry.hidden = false;
  }
}

retry.addEventListener('click', () => void requestMicrophone());
void requestMicrophone();
