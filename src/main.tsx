import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { landingExperimentReady, shouldShowWelcome } from './landingExperiment'

const Experience = lazy(async () => {
  if (shouldShowWelcome()) {
    const preview = new URLSearchParams(location.search).get('welcome')
    if (preview === 'a' || preview === 'b' || preview === 'c' || await landingExperimentReady()) return import('./Welcome')
  }
  return import('./App')
})

declare global {
  interface Window {
    __gcuTakeover?: boolean
  }
}

if (!window.__gcuTakeover) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Suspense fallback={<p role="status" style={{ textAlign: 'center', padding: 48 }}>A little magic is on its way…</p>}>
        <Experience />
      </Suspense>
    </StrictMode>,
  )
}
