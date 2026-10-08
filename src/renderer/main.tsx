import React from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import '@fontsource/fira-code/400.css'
import '@fontsource/fira-code/500.css'
import '@fontsource/cascadia-code/400.css'
import '@fontsource/cascadia-code/500.css'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'
import { setupMonaco } from './lib/monaco'

setupMonaco()

createRoot(document.getElementById('root')!).render(<App />)
