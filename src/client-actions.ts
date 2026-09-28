import * as React from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { ClientError, errorLabel, layerLabel } from './client-locales'
import type { LocaleProps } from './client-locales'

export function EyeIcon(props: { hidden: boolean }) {
  return React.createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.6, 'aria-hidden': true,
  }, React.createElement('path', { d: 'M2 12s3.5-7 10-7 10 7-3.5 7-10 7S2 12 2 12Z' }),
  React.createElement('circle', { cx: 12, cy: 12, r: 3 }),
  props.hidden ? React.createElement('path', { d: 'm3 3 18 18' }) : null)
}

function PlusIcon() {
  return React.createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.6, 'aria-hidden': true,
  }, React.createElement('path', { d: 'M12 5v14M5 12h14' }))
}

export function NewVariableButton({ t, onClick }: LocaleProps & { onClick: () => void }) {
  return React.createElement(Button, {
    variant: 'ghost', size: 'sm', icon: React.createElement(PlusIcon), onClick,
    title: t('newVariable'), 'aria-label': t('newVariable'),
  })
}

/** Explicit submission: moving between the three new-variable fields never saves. */
export function NewVariableForm(props: LocaleProps & {
  layers: string[]
  create: (layer: string, name: string, value: string) => Promise<void>
  onCancel: () => void
}) {
  const { t } = props
  const [layer, setLayer] = React.useState('user-env')
  const [name, setName] = React.useState('')
  const [value, setValue] = React.useState('')
  const [visible, setVisible] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<unknown>(null)
  const session = React.useRef({ active: true, pending: false })
  React.useEffect(() => {
    session.current.active = true
    return () => { session.current.active = false }
  }, [])
  const cancel = () => {
    if (session.current.pending) return
    session.current.active = false
    setName(''); setValue(''); setVisible(false)
    props.onCancel()
  }
  const submit: React.FormEventHandler<HTMLFormElement> = async (event) => {
    event.preventDefault()
    if (!session.current.active || session.current.pending) return
    const key = name.trim()
    setError(null)
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      setError(new ClientError({ error: key ? 'invalid-name' : 'empty-name' }))
      return
    }
    session.current.pending = true
    setBusy(true)
    try {
      await props.create(layer, key, value)
    } catch (error) {
      if (session.current.active) setError(error)
    } finally {
      session.current.pending = false
      if (session.current.active) setBusy(false)
    }
  }
  const sensitive = /KEY|PASSWORD|SECRET|TOKEN/i.test(name)
  const masked = sensitive && !visible
  const multiline = /[\r\n]/.test(value)
  return React.createElement('form', {
    className: 'dsh-environment-tray-create', 'aria-label': t('newVariable'), onSubmit: submit,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.nativeEvent?.isComposing) {
        event.preventDefault(); event.stopPropagation(); cancel()
      }
    },
  },
  React.createElement('div', { className: 'dsh-environment-tray-create-fields' },
    React.createElement('label', null, t('saveTo'), React.createElement('select', {
      className: 'dsh-environment-tray-input', 'aria-label': t('saveTo'), value: layer, disabled: busy,
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { setLayer(event.target.value); setError(null) },
    }, props.layers.map((layer) => React.createElement('option', { key: layer, value: layer }, layerLabel(t, layer))))),
    React.createElement('label', null, t('variableName'), React.createElement(Input, {
      'aria-label': t('variableName'), value: name, autoFocus: true, disabled: busy,
      autoComplete: 'off', spellCheck: false, 'aria-invalid': error !== null,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setName(event.target.value); setVisible(false); setError(null) },
    })),
    React.createElement('label', { className: 'dsh-environment-tray-create-value' }, t('variableValue'),
      React.createElement('span', null,
        React.createElement(masked ? 'input' : 'textarea', {
          className: 'dsh-environment-tray-input', 'aria-label': t('variableValue'), value, type: masked ? 'password' : undefined,
          rows: 2, disabled: busy, readOnly: masked && multiline, autoComplete: 'off', spellCheck: false,
          title: masked && multiline ? t('multilineHint') : undefined,
          onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValue(event.target.value),
        }),
        sensitive ? React.createElement(Button, {
          type: 'button', variant: 'ghost', size: 'sm', disabled: busy,
          icon: React.createElement(EyeIcon, { hidden: visible }),
          title: t(visible ? 'hideInput' : 'showInput'), 'aria-label': t(visible ? 'hideInput' : 'showInput'),
          onClick: () => setVisible(!visible),
        }) : null,
      ),
    ),
  ),
  error !== null ? React.createElement('p', { role: 'alert' }, errorLabel(t, error)) : null,
  React.createElement('div', { className: 'dsh-environment-tray-form-actions' },
    React.createElement(Button, { type: 'button', variant: 'ghost', size: 'sm', disabled: busy, onClick: cancel }, t('cancel')),
    React.createElement(Button, { type: 'submit', variant: 'primary', size: 'sm', disabled: busy }, t(busy ? 'saving' : 'create')),
  ))
}

export function DeleteAction(props: LocaleProps & {
  name: string
  layer: string
  icon: React.ReactNode
  fallback?: boolean
  disabled?: boolean
  onOpen: () => void
  onClose: () => void
  remove: () => Promise<void>
}) {
  const { t } = props
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<unknown>(null)
  const session = React.useRef({ active: true, pending: false })
  React.useEffect(() => {
    session.current.active = true
    return () => { session.current.active = false }
  }, [])
  const close = () => {
    if (!session.current.pending) { setOpen(false); setError(null); props.onClose() }
  }
  const remove = async () => {
    if (session.current.pending || !open || props.disabled) return
    session.current.pending = true
    setBusy(true); setError(null)
    try {
      await props.remove()
      if (session.current.active) setOpen(false)
    } catch (error) {
      if (session.current.active) setError(error)
    } finally {
      session.current.pending = false
      if (session.current.active) setBusy(false)
    }
  }
  return React.createElement(React.Fragment, null,
    React.createElement(Button, {
      type: 'button', variant: 'ghost', size: 'sm', icon: props.icon, disabled: props.disabled,
      title: t('deleteFrom', { layer: layerLabel(t, props.layer) }), 'aria-label': t('delete'),
      onClick: () => { props.onOpen(); setError(null); setOpen(true) },
    }),
    React.createElement(Modal, {
      open, title: t('deleteVariable'), closeLabel: t('close'), className: 'dsh-environment-tray-confirm', onClose: close,
      footer: React.createElement('div', { className: 'dsh-environment-tray-form-actions' },
        React.createElement(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: close }, t('cancel')),
        React.createElement(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: remove }, t(busy ? 'saving' : 'confirmDelete')),
      ),
    },
    React.createElement('p', null, t('deletePrompt', { name: props.name, layer: layerLabel(t, props.layer) })),
    props.fallback ? React.createElement('p', null, t('deleteFallback')) : null,
    error !== null ? React.createElement('p', { role: 'alert' }, errorLabel(t, error)) : null,
    ),
  )
}
