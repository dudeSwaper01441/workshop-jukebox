import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import Guest from './Guest'
import Admin from './Admin'
import Display from './Display'

const path = window.location.pathname
// exact /admin and /display only, so tunnel URLs with similar prefixes don't leak
const isAdmin = path === '/admin' || path.startsWith('/admin/')
const isDisplay = path === '/display' || path.startsWith('/display/')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isAdmin ? <Admin /> : isDisplay ? <Display /> : <Guest />}</StrictMode>,
)
