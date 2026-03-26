import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './lib/amplify' // Initialize Amplify before anything else
import './index.css'
import { App } from './app'

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
