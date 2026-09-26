import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { StoreProvider } from './state/store.js'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('The #root element is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>
)
