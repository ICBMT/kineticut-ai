import { app, BrowserWindow, Menu } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'

const isDev = !!process.env.ELECTRON_RENDERER_URL

// Required when running as root (common in containers/CI).
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  app.commandLine.appendSwitch('no-sandbox')
}

let win: BrowserWindow | null = null

function createWindow() {
  win = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 1080,
    minHeight: 680,
    frame: false,
    backgroundColor: '#0b0b10',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  win.setMenuBarVisibility(false)
  win.setAutoHideMenuBar(true)

  win.once('ready-to-show', () => win?.show())
  win.on('maximize', () => win?.webContents.send('win:maximized', true))
  win.on('unmaximize', () => win?.webContents.send('win:maximized', false))
  win.on('closed', () => {
    win = null
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    registerIpc(() => win)

    // Minimal native menu: keeps standard accelerators (esp. Edit roles on macOS)
    // alive while the in-app title bar provides the visible UI.
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
        { role: 'fileMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ]),
    )

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
