import './polyfills.js' // 古いSafari(iOS11)向けポリフィル。必ず最初に。
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'

createRoot(document.getElementById('root')).render(<App />)
