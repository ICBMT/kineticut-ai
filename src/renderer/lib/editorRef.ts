import type * as monaco from 'monaco-editor'

/** Mutable ref to the mounted Monaco editor, set by <EditorArea />. */
export const editorRef: { current: monaco.editor.IStandaloneCodeEditor | null } = {
  current: null,
}
