export type ProjectMedia =
  | { type: 'image'; src: string; alt: string }
  /** Muted, looping clip. `poster` shows while it loads and for reduced-motion users. */
  | { type: 'video'; src: string; poster: string; alt: string }

export interface Project {
  name: string
  description: string
  /** Where to see it. Omitted when there is nothing public to link to. */
  href?: string
  /** Extra links shown under the description, for projects with more than one thing to try. */
  links?: { label: string; href: string }[]
  /** Short stack/context line shown under the title. */
  stack?: string
  /** Omitted until there is a screenshot or clip; the card renders a placeholder. */
  media?: ProjectMedia
}

// Media lives in public/projects/. Keep images ~1200px wide webp, clips short muted mp4s.
export const projects: Project[] = [
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
    name: 'Second brain',
    stack: 'GitHub Actions · vLLM · Qwen3-VL · Modal',
    media: {
      type: 'image',
      src: '/projects/second-brain-pipeline.webp',
      alt: 'Pipeline diagram: a daily GitHub Actions job exports Slack, uploads it to Google Drive, and enriches notes with a vLLM A100 and a Modal T4'
    },
    description:
      'Anything I drop into Slack, whether a screenshot, a link, or a voice memo, becomes a structured note. A daily GitHub Actions job backs the workspace up to Google Drive, then enriches each message: OCR and captions from Qwen3-VL on a self-hosted vLLM A100, titles and summaries for links, and transcripts for YouTube and audio via WhisperX on Modal.'
  },
  {
    name: 'Climbing clip studio',
    href: '/demos/climbing-studio/',
    stack: 'Python · MediaPipe · HMM · Modal',
    media: {
      type: 'image',
      src: '/projects/climbing-studio.webp',
      alt: 'Clip Studio: a bouldering video with the detector\'s climbing probability and suggested segments on the timeline'
    },
    description:
      'Finds the spans of a climbing video where the climber is off the ground, so hours of gym footage become short clips. Pose tracking is calibrated per video to its own floor and the climber\'s size, then an HMM turns per-frame scores into segments. The studio is where I review the suggestions, fix the edges, and cut. The demo runs on real footage and detector output, with the jobs simulated in your browser.'
  },
  {
    name: 'Transcription pipeline',
    href: 'https://github.com/EvanDavidYoung/slackIntegration',
    stack: 'Slack · vLLM · MCP · Modal',
    media: {
      type: 'image',
      src: '/projects/transcription-pipeline.webp',
      alt: 'Architecture: a Slack mention reaches the Minion bot on Railway, which asks vLLM on Modal for a tool call, submits the job through an MCP server to a transcription API, and gets the WhisperX result back by webhook'
    },
    description:
      'Mention a podcast link in Slack and the transcript shows up in the thread. A self-hosted Qwen model on vLLM spots the request, calls a transcription tool over MCP, and a WhisperX job on a Modal GPU does the transcribing.'
  },
  {
    name: 'Chinese reading & shadowing',
    href: 'https://tools.evanyoung.dev/shadowing/',
    links: [
      { label: 'Try shadowing', href: 'https://tools.evanyoung.dev/shadowing/' },
      { label: 'Try the vocab app', href: '/demos/chinese-vocab/' }
    ],
    stack: 'HTML · OpenRouter · Anki',
    media: {
      type: 'image',
      src: '/projects/chinese-shadowing.webp',
      alt: 'Shadowing tool showing a Traditional Chinese article with sentence loop and shadowing mode controls above an audio player'
    },
    description:
      'Two tools for turning Chinese articles into practice. The shadowing tool reads along with spoken Mandarin word by word, then loops a sentence or pauses after each one so you can repeat it out loud. The vocab app turns an article into draft flashcards, lets you approve or edit them, quizzes you before and after reading, and exports the keepers to Anki.'
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
  }
]
