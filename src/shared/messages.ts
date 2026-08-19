/**
 * Message protocol between the Side Panel (React UI), the Background service
 * worker (the brain) and the Content Script (the eyes & hands).
 */

export type SidePanelRequest =
  | { type: 'SEND_MESSAGE'; payload: { text: string } }
  | { type: 'STOP' }
  | { type: 'GET_PAGE_CONTEXT' }
  | { type: 'CLEAR_HISTORY' };

export type SidePanelEvent =
  | { type: 'ROLE_DELTA'; payload: { role: 'user' | 'assistant'; delta: string } }
  | { type: 'MESSAGE_COMPLETE'; payload: { role: 'user' | 'assistant'; text: string } }
  | { type: 'AGENT_ACTION'; payload: { description: string } }
  | { type: 'ERROR'; payload: { message: string } }
  | { type: 'SETTINGS'; payload: { model: string; readPageContext: boolean } }
  | { type: 'BUSY'; payload: { busy: boolean } }
  | { type: 'PAGE_CONTEXT'; payload: { markdown: string; title: string; url: string } };

export type ContentScriptRequest =
  | { type: 'GET_PAGE_CONTEXT'; requestId?: string }
  | { type: 'READ_VIDEO_CONTEXT'; requestId?: string }
  | {
      type: 'EXECUTE_ACTION';
      payload: { action: string; params: Record<string, unknown> };
      requestId?: string;
    }
  | {
      type: 'TOOL_RESPONSE';
      requestId: string;
      payload: ContentScriptResponse | null;
    };

/** Transcript entry extracted from a video page's caption tracks. */
export type TranscriptSegment = { start: number; text: string };

/** The universal video context the content script can read from any tab. */
export type VideoContext = {
  /** Which extraction strategy succeeded (or 'none'). */
  source:
    | 'youtube_transcript'
    | 'html5_track_captions'
    | 'vimeo_captions'
    | 'video_metadata'
    | 'none';
  /** Page URL of the video. */
  url: string;
  title?: string;
  /** Human-readable video metadata (duration, current time, src, state). */
  metadata?: Record<string, unknown>;
  /** Caption transcript segments, when captions were available. */
  transcript?: TranscriptSegment[];
  /** Plain transcript text joined from segments. */
  transcriptText?: string;
};

export type ContentScriptResponse =
  | { type: 'PAGE_CONTEXT'; payload: { markdown: string; title: string; url: string } }
  | { type: 'VIDEO_CONTEXT'; payload: VideoContext }
  | { type: 'ACTION_RESULT'; payload: { success: boolean; description: string } };
