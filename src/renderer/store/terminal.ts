import { create } from 'zustand'

export interface TermTab {
  id: string
  title: string
  exited?: boolean
}

interface TerminalState {
  terminals: TermTab[]
  activeId: string | null
  addTerminal(t: TermTab): void
  removeTerminal(id: string): void
  setActive(id: string | null): void
  markExited(id: string): void
  renameTerminal(id: string, title: string): void
}

export const useTerminalStore = create<TerminalState>((set) => ({
  terminals: [],
  activeId: null,

  addTerminal: (t) =>
    set((s) => ({
      terminals: [...s.terminals, t],
      activeId: t.id,
    })),

  removeTerminal: (id) =>
    set((s) => {
      const terminals = s.terminals.filter((t) => t.id !== id)
      let activeId = s.activeId
      if (activeId === id) {
        activeId = terminals.length > 0 ? terminals[terminals.length - 1].id : null
      }
      return { terminals, activeId }
    }),

  setActive: (id) => set({ activeId: id }),
  markExited: (id) =>
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, exited: true } : t)),
    })),
  renameTerminal: (id, title) =>
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, title } : t)),
    })),
}))
