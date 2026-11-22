// 桌宠渲染进程 → Electron 主进程的安全桥（contextIsolation）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petBridge', {
  move: (dx, dy) => ipcRenderer.send('pet-move', dx, dy),
  toggleClickThrough: () => ipcRenderer.send('pet-toggle-clickthrough'),
})
