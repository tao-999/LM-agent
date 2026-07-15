/// <reference types="vite/client" />

import type { LocalAgentApi } from '../../preload'

declare global {
  interface Window {
    localAgent: LocalAgentApi
  }
}

export {}
