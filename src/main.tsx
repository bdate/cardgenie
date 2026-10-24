import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { shouldShowWelcome } from './landingExperiment'

const Experience = shouldShowWelcome()
  ? lazy(() => import('./Welcome'))
  : lazy(() => import('./App'))

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
