export type ToolCategory = 'html' | 'modal'

export interface Tool {
  name: string
  description: string
  category: ToolCategory
  /** Where to use it. Omitted when there is nothing publicly runnable. */
  href?: string
  /** Public source, when there is any. Link straight to the script when the script is the point. */
  source?: string
  /** Link text for `source`. Defaults to "Source"; set to a filename to show it's a direct link. */
  sourceLabel?: string
  /** Caveats worth stating up front: attribution, access limits. */
  note?: string
}

export const toolSections: { category: ToolCategory; heading: string; blurb: string }[] = [
  {
    category: 'html',
    heading: 'HTML tools',
    blurb:
      'Single files with inline CSS and JS. No build step, no server, no network calls — they read files you pick locally and never upload anything.'
  },
  {
    category: 'modal',
    heading: 'Modal',
    blurb:
      'GPU jobs that run on Modal. These cost money per invocation, so there is no public endpoint — the source is the useful part.'
  }
]

export const tools: Tool[] = [
  {
    name: 'Transcript player',
    category: 'html',
    href: 'https://tools.evanyoung.dev/transcript-player/',
    source: 'https://github.com/EvanDavidYoung/tools',
    description:
      'Load an audio file and its transcript JSON, then play them in sync with word-level highlighting. Written for reviewing machine transcripts, so it handles the CJK/English token-spacing problem that makes most players render bilingual text wrong.'
  },
  {
    name: 'Climbing detection viewer',
    category: 'html',
    href: 'https://tools.evanyoung.dev/climb-viewer/',
    source: 'https://github.com/EvanDavidYoung/tools',
    description:
      'Load a climbing video plus pose-detection output and scrub a colour-coded timeline of the detected segments. Built to find where the model was wrong, which is most of what training one actually consists of. Ships with a sample clip so it works without supplying your own files.'
  },
  {
    name: 'Guitar tab ripper',
    category: 'html',
    href: 'https://ugrip.pages.dev/',
    source: 'https://github.com/EvanDavidYoung/ugrip',
    note: 'Forked from hedwiggggg/ugrip (MIT), self-hosted',
    description:
      'Pulls the chords and lyrics for a song, transposes or simplifies the chords, and exports a clean PDF to actually play from. Not my code — I forked it and run my own copy.'
  },
  {
    name: 'Diarized transcription',
    category: 'modal',
    source: 'https://github.com/EvanDavidYoung/podcastdownloader/blob/main/scripts/modal/transcribe_modal.py',
    sourceLabel: 'transcribe_modal.py',
    note: 'Deployed but authenticated — no public endpoint',
    description:
      'WhisperX plus pyannote on a T4. The interesting part is a three-pass design for bilingual audio: diarize the whole file first, then identify each speaker’s language from their longest turns, then transcribe every turn with that language forced. Whisper’s language detection is unreliable under 30 seconds, so letting it guess per-segment garbles anything that alternates between languages.'
  },
  {
    name: 'Face blur',
    category: 'modal',
    source: 'https://github.com/EvanDavidYoung/blur-face/blob/main/blur_face.py',
    sourceLabel: 'blur_face.py',
    note: 'Command line only',
    description:
      'Blur one chosen face across a video, keeping the audio. Detection is sequential because tracking needs frames in order, but the blurring fans out across 500-frame chunks in parallel. Every stage checkpoints to a volume, so a re-run resumes instead of starting over.'
  }
]
