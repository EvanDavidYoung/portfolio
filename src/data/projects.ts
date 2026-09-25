export type ProjectMedia =
  | { type: 'image'; src: string; alt: string }
  /** Muted, looping clip. `poster` shows while it loads and for reduced-motion users. */
  | { type: 'video'; src: string; poster: string; alt: string }

export interface Project {
  name: string
  description: string
  /** Where to see it. Omitted when there is nothing public to link to. */
  href?: string
  /** Short stack/context line shown under the title. */
  stack?: string
  /** Omitted until there is a screenshot or clip; the card renders a placeholder. */
  media?: ProjectMedia
}

// Media lives in public/projects/. Keep images ~1200px wide webp, clips short muted mp4s.
export const projects: Project[] = [
  {
    name: 'Zhuyin Game',
    href: 'https://zhuyin-pinyin-game.netlify.app/',
    stack: 'React · Vite',
    media: {
      type: 'video',
      src: '/projects/zhuyin-game.mp4',
      poster: '/projects/zhuyin-game-poster.webp',
      alt: 'Zhuyin Game: a word is shown as the first Zhuyin symbol of each syllable, then revealed as 網球'
    },
    description:
      'A guessing game for drilling Zhuyin. You get the category and the first symbol of each syllable, and have to name the word before revealing it. Toggles between Zhuyin and Pinyin, and Traditional and Simplified.'
  },
  {
    name: 'Chinese Reader',
    href: 'https://reader-chinese.netlify.app/',
    stack: 'Next.js · OpenCC · ElevenLabs',
    media: {
      type: 'video',
      src: '/projects/chinese-reader.mp4',
      poster: '/projects/chinese-reader-poster.webp',
      alt: 'Chinese Reader playing a Traditional Chinese story aloud, highlighting each word as it is spoken'
    },
    description:
      'Paste Chinese text or fetch an article by URL, flip between Simplified and Traditional, and listen along with text-to-speech that highlights each character as it is spoken.'
  },
  {
    name: 'File Mover',
    stack: 'macOS · SwiftUI · Gemini',
    media: {
      type: 'video',
      src: '/projects/file-mover.mp4',
      poster: '/projects/file-mover-poster.webp',
      alt: 'File Mover: editing categories, choosing destinations, sorting files into categories, then reviewing the move history'
    },
    description:
      'A macOS app for tidying folders. Drop files in, let Gemini suggest categories, adjust them, then move everything in one go. It keeps you in the loop enough that you still know where things ended up.'
  },
  {
    name: 'Bloomberg Live QA',
    href: 'https://www.bloombergmedia.com/press/bloomberg-media-launches-bloomberg-live-qa/',
    stack: 'Bloomberg · Next.js · Node.js · WebRTC',
    media: {
      type: 'video',
      src: '/projects/bloomberg-live-qa.mp4',
      poster: '/projects/bloomberg-live-qa-poster.webp',
      alt: 'Bloomberg Live Q&A session with Mark Gurman, scrubbing through the archived audio player'
    },
    description:
      'A live audio Q&A platform with real-time chat, built on WebRTC audio and scaled to 10k+ concurrent listeners around the world.'
  },
  {
    name: 'Transcription pipeline',
    stack: 'Slack · vLLM · MCP · Modal',
    description:
      'Mention a podcast link in Slack and the transcript shows up in the thread. A self-hosted Qwen model on vLLM spots the request, calls a transcription tool over MCP, and a WhisperX job on a Modal GPU does the transcribing.'
  }
]
