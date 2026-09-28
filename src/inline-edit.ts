import * as React from 'react'

interface EditValue { value: string; revision?: string }
interface EditOptions<T> {
  read?: () => Promise<EditValue>
  write: (value: string, revision?: string) => Promise<T>
  remove?: (revision?: string) => Promise<T>
  onSaved: (result: T) => void
}

/** One edit session; blur and Enter share a synchronous submission lock. */
export function useInlineEdit<T>(options: EditOptions<T>) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const [ready, setReady] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<unknown>(null)
  const [visible, setVisible] = React.useState(false)
  const session = React.useRef({ generation: 0, active: false, pending: false, suspended: false, original: '', revision: undefined as string | undefined })
  React.useEffect(() => () => {
    session.current.active = false
    session.current.suspended = false
    session.current.generation += 1
    session.current.original = ''
    session.current.revision = undefined
  }, [])

  const cancel = () => {
    session.current.active = false
    session.current.suspended = false
    session.current.generation += 1
    session.current.original = ''
    session.current.revision = undefined
    setEditing(false)
    setDraft('')
    setVisible(false)
    setError(null)
    setBusy(false)
  }
  const begin = async () => {
    if (!options.read || session.current.pending) return
    const generation = ++session.current.generation
    session.current.active = true
    session.current.suspended = false
    setEditing(true)
    setDraft('')
    setReady(false)
    setBusy(true)
    setVisible(false)
    setError(null)
    try {
      const value = await options.read()
      if (generation !== session.current.generation) return
      session.current.original = value.value
      session.current.revision = value.revision
      setDraft(value.value)
      setReady(true)
    } catch (error) {
      if (generation === session.current.generation) setError(error)
    } finally {
      if (generation === session.current.generation) setBusy(false)
    }
  }
  const submit = async (remove = false) => {
    if (!session.current.active || session.current.pending || session.current.suspended || !ready) return
    if (!remove && draft === session.current.original) { cancel(); return }
    if (remove && !options.remove) return
    session.current.pending = true
    const generation = session.current.generation
    setBusy(true)
    setError(null)
    try {
      const result = remove
        ? await options.remove!(session.current.revision)
        : await options.write(draft, session.current.revision)
      if (generation !== session.current.generation) return
      cancel()
      options.onSaved(result)
    } catch (error) {
      if (generation === session.current.generation) setError(error)
    } finally {
      session.current.pending = false
      if (generation === session.current.generation) setBusy(false)
    }
  }
  const onBlur: React.FocusEventHandler<HTMLDivElement> = (event) => {
    if ((event.relatedTarget as HTMLElement | null)?.getAttribute?.('data-dsh-environment-tray-copy') === 'true') return
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void submit()
  }
  const onKeyDown: React.KeyboardEventHandler<HTMLInputElement | HTMLTextAreaElement> = (event) => {
    if (event.nativeEvent?.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (!session.current.pending) cancel()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void submit()
    }
  }
  return { editing, draft, setDraft, ready, busy, error, visible, setVisible, begin, cancel,
    pause: () => { session.current.suspended = true }, resume: () => { session.current.suspended = false },
    remove: () => submit(true), onBlur, onKeyDown }
}
